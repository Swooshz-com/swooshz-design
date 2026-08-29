import { ProviderFailure } from "./openai";
import type { S2DesignRuleSnapshot, S2Requirement, S3AssessmentProviderMetadata, S3ImageProviderMetadata } from "./types";
import {
  S3_ASSESSMENT_JSON_SCHEMA,
  S3_ASSESSMENT_MODEL,
  S3_ASSESSMENT_SCHEMA_NAME,
  S3_IMAGE_MODEL_SNAPSHOT,
} from "./s3-compiler";

export type S3ProviderUsage = Pick<S3ImageProviderMetadata, "providerRequestId" | "inputTokens" | "outputTokens" | "totalTokens">;

export type S3ImageProviderInput = {
  promptText: string;
  sourceBytes: Uint8Array;
};

export type S3ImageProviderResult = {
  pngBytes: Uint8Array;
  providerRequestId: string | null;
  usage?: Omit<S3ProviderUsage, "providerRequestId">;
};

export type S3AssessmentProviderInput = {
  promptText: string;
  outputBytes: Uint8Array;
  /** Server-side fixture context; it is not serialized into the provider request. */
  requirements?: readonly S2Requirement[];
  /** Server-side fixture context; it is not serialized into the provider request. */
  designRules?: readonly S2DesignRuleSnapshot[];
};

export type S3AssessmentProviderResult = {
  payload: unknown;
  providerRequestId: string | null;
  usage?: Omit<S3ProviderUsage, "providerRequestId">;
};

export type S3ImageRequest = {
  endpoint: "/v1/images/edits";
  model: typeof S3_IMAGE_MODEL_SNAPSHOT;
  n: 1;
  size: "1536x1024";
  quality: "medium";
  output_format: "png";
  prompt: string;
  inputImages: readonly [Uint8Array];
};

export function buildS3ImageRequest(input: S3ImageProviderInput): S3ImageRequest {
  return {
    endpoint: "/v1/images/edits",
    model: S3_IMAGE_MODEL_SNAPSHOT,
    n: 1,
    size: "1536x1024",
    quality: "medium",
    output_format: "png",
    prompt: input.promptText,
    inputImages: [input.sourceBytes],
  };
}

export type S3AssessmentRequest = {
  endpoint: "/v1/responses";
  model: typeof S3_ASSESSMENT_MODEL;
  store: false;
  input: readonly [{
    role: "user";
    content: readonly [
      { type: "input_text"; text: string },
      { type: "input_image"; image_url: string; detail: "high" },
    ];
  }];
  text: {
    format: {
      type: "json_schema";
      name: typeof S3_ASSESSMENT_SCHEMA_NAME;
      strict: true;
      schema: typeof S3_ASSESSMENT_JSON_SCHEMA;
    };
  };
};

export function buildS3AssessmentRequest(input: S3AssessmentProviderInput): S3AssessmentRequest {
  return {
    endpoint: "/v1/responses",
    model: S3_ASSESSMENT_MODEL,
    store: false,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: input.promptText },
        {
          type: "input_image",
          image_url: `data:image/png;base64,${Buffer.from(input.outputBytes).toString("base64")}`,
          detail: "high",
        },
      ],
    }],
    text: {
      format: {
        type: "json_schema",
        name: S3_ASSESSMENT_SCHEMA_NAME,
        strict: true,
        schema: S3_ASSESSMENT_JSON_SCHEMA,
      },
    },
  };
}

export type S3ProviderContract = {
  runS3ImageEdit?(input: S3ImageProviderInput): Promise<S3ImageProviderResult>;
  runS3Assessment?(input: S3AssessmentProviderInput): Promise<S3AssessmentProviderResult>;
};

function strictBase64(value: string): boolean {
  if (!value || value.length % 4 !== 0) return false;
  let padding = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x3d) {
      if (index < value.length - 2 || ++padding > 2) return false;
      continue;
    }
    if (padding > 0 || !((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2f)) return false;
  }
  if (padding === 1 && value.charCodeAt(value.length - 2) === 0x3d) return false;
  if (typeof Buffer !== "undefined") {
    try { return Buffer.from(value, "base64").toString("base64") === value; } catch { return false; }
  }
  return true;
}

function providerUsage(body: Record<string, unknown>): Omit<S3ProviderUsage, "providerRequestId"> {
  const usage = typeof body.usage === "object" && body.usage !== null ? body.usage as Record<string, unknown> : {};
  return {
    inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
    outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
    totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : null,
  };
}

function responseRequestId(response: Response, body: Record<string, unknown>): string | null {
  const header = response.headers.get("x-request-id");
  if (header && header.length <= 200) return header;
  return typeof body.id === "string" && body.id.length <= 200 ? body.id : null;
}

function outputText(body: Record<string, unknown>): string {
  if (typeof body.output_text === "string") return body.output_text;
  const output = Array.isArray(body.output) ? body.output : [];
  for (const item of output) {
    if (typeof item !== "object" || item === null) continue;
    const content = Array.isArray((item as Record<string, unknown>).content)
      ? (item as Record<string, unknown>).content as unknown[]
      : [];
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const value = part as Record<string, unknown>;
      if (value.type === "refusal" || typeof value.refusal === "string") throw new ProviderFailure("QA_PROVIDER_REFUSED");
      if (typeof value.text === "string") return value.text;
    }
  }
  throw new ProviderFailure("QA_PROVIDER_EMPTY");
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProviderFailure("PROVIDER_MALFORMED_RESPONSE");
  return value as Record<string, unknown>;
}

/** Runtime provider. It is only reachable after production authorization. */
export class OpenAIS3Provider implements S3ProviderContract {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: { apiKey?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 90_000;
  }

  private async postJson(path: string, body: Record<string, unknown>): Promise<{ response: Response; body: Record<string, unknown> }> {
    if (!this.apiKey) throw new ProviderFailure("PROVIDER_NOT_CONFIGURED");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl("https://api.openai.com/v1/" + path, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        throw new ProviderFailure(controller.signal.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE");
      }
      let value: Record<string, unknown>;
      try { value = parseObject(await response.json()); }
      catch (error) { if (error instanceof ProviderFailure) throw error; throw new ProviderFailure(response.ok ? "PROVIDER_MALFORMED_RESPONSE" : "PROVIDER_HTTP_ERROR"); }
      if (!response.ok) {
        if (response.status === 429) throw new ProviderFailure("PROVIDER_RATE_LIMIT");
        if (response.status >= 500) throw new ProviderFailure("PROVIDER_SERVER_ERROR");
        throw new ProviderFailure("PROVIDER_CLIENT_ERROR");
      }
      return { response, body: value };
    } finally { clearTimeout(timeout); }
  }

  private async postMultipart(path: string, form: FormData): Promise<{ response: Response; body: Record<string, unknown> }> {
    if (!this.apiKey) throw new ProviderFailure("PROVIDER_NOT_CONFIGURED");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl("https://api.openai.com/v1/" + path, {
          method: "POST",
          headers: { authorization: `Bearer ${this.apiKey}` },
          body: form,
          signal: controller.signal,
        });
      } catch {
        throw new ProviderFailure(controller.signal.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE");
      }
      let value: Record<string, unknown>;
      try { value = parseObject(await response.json()); }
      catch (error) { if (error instanceof ProviderFailure) throw error; throw new ProviderFailure(response.ok ? "PROVIDER_MALFORMED_RESPONSE" : "PROVIDER_HTTP_ERROR"); }
      if (!response.ok) {
        if (response.status === 429) throw new ProviderFailure("PROVIDER_RATE_LIMIT");
        if (response.status >= 500) throw new ProviderFailure("PROVIDER_SERVER_ERROR");
        throw new ProviderFailure("PROVIDER_CLIENT_ERROR");
      }
      return { response, body: value };
    } finally { clearTimeout(timeout); }
  }

  async runS3ImageEdit(input: S3ImageProviderInput): Promise<S3ImageProviderResult> {
    const request = buildS3ImageRequest(input);
    const form = new FormData();
    form.append("model", request.model);
    form.append("n", String(request.n));
    form.append("size", request.size);
    form.append("quality", request.quality);
    form.append("output_format", request.output_format);
    form.append("prompt", request.prompt);
    form.append("image", new Blob([Buffer.from(request.inputImages[0])], { type: "image/png" }), "s3-base.png");
    const { response, body } = await this.postMultipart("images/edits", form);
    const data = Array.isArray(body.data) ? body.data : [];
    if (data.length !== 1 || typeof data[0] !== "object" || data[0] === null) throw new ProviderFailure("IMAGE_EMPTY");
    const encoded = (data[0] as Record<string, unknown>).b64_json;
    if (typeof encoded !== "string" || !strictBase64(encoded)) throw new ProviderFailure("IMAGE_MALFORMED");
    const pngBytes = Buffer.from(encoded, "base64");
    if (!pngBytes.length) throw new ProviderFailure("IMAGE_EMPTY");
    return { pngBytes, providerRequestId: responseRequestId(response, body), usage: providerUsage(body) };
  }

  async runS3Assessment(input: S3AssessmentProviderInput): Promise<S3AssessmentProviderResult> {
    const request = buildS3AssessmentRequest(input);
    const { response, body } = await this.postJson("responses", request as unknown as Record<string, unknown>);
    if (body.status === "incomplete" || body.incomplete_details) throw new ProviderFailure("QA_PROVIDER_INCOMPLETE");
    let payload: unknown;
    try { payload = JSON.parse(outputText(body)); }
    catch (error) { if (error instanceof ProviderFailure) throw error; throw new ProviderFailure("QA_SCHEMA_INVALID"); }
    return { payload, providerRequestId: responseRequestId(response, body), usage: providerUsage(body) };
  }
}
