import { ProviderFailure } from "./openai";
import {
  S4_ASSESSMENT_JSON_SCHEMA,
  S4_ASSESSMENT_MODEL,
  S4_ASSESSMENT_SCHEMA_NAME,
  S4_IMAGE_MODEL_SNAPSHOT,
} from "./s4-compiler";
import type { S4AssessmentProviderMetadata, S4ImageProviderMetadata } from "./types";

export type S4ProviderUsage = Pick<S4ImageProviderMetadata, "providerRequestId" | "inputTokens" | "outputTokens" | "totalTokens">;

export type S4ImageProviderInput = {
  promptText: string;
  sourceBytes: Uint8Array;
  maskBytes: Uint8Array;
};

export type S4ImageProviderResult = {
  pngBytes: Uint8Array;
  providerRequestId: string | null;
  usage?: Omit<S4ProviderUsage, "providerRequestId">;
};

export type S4AssessmentProviderInput = {
  promptText: string;
  sourceBytes: Uint8Array;
  outputBytes: Uint8Array;
  maskBytes: Uint8Array;
};

export type S4AssessmentProviderResult = {
  payload: unknown;
  providerRequestId: string | null;
  usage?: Omit<S4ProviderUsage, "providerRequestId">;
};

export type S4ImageRequest = {
  endpoint: "/v1/images/edits";
  model: typeof S4_IMAGE_MODEL_SNAPSHOT;
  n: 1;
  size: "1536x1024";
  quality: "medium";
  output_format: "png";
  prompt: string;
  imageParts: readonly [{
    field: "image[]";
    fileName: "s4-source.png";
    contentType: "image/png";
    bytes: Uint8Array;
  }];
  maskPart: {
    field: "mask";
    fileName: "s4-mask.png";
    contentType: "image/png";
    bytes: Uint8Array;
  };
};

export function buildS4ImageRequest(input: S4ImageProviderInput): S4ImageRequest {
  return {
    endpoint: "/v1/images/edits",
    model: S4_IMAGE_MODEL_SNAPSHOT,
    n: 1,
    size: "1536x1024",
    quality: "medium",
    output_format: "png",
    prompt: input.promptText,
    imageParts: [{
      field: "image[]",
      fileName: "s4-source.png",
      contentType: "image/png",
      bytes: input.sourceBytes,
    }],
    maskPart: {
      field: "mask",
      fileName: "s4-mask.png",
      contentType: "image/png",
      bytes: input.maskBytes,
    },
  };
}

export type S4AssessmentRequest = {
  endpoint: "/v1/responses";
  model: typeof S4_ASSESSMENT_MODEL;
  store: false;
  input: readonly [{
    role: "user";
    content: readonly [
      { type: "input_text"; text: string },
      { type: "input_image"; image_url: string; detail: "high" },
      { type: "input_image"; image_url: string; detail: "high" },
      { type: "input_image"; image_url: string; detail: "high" },
    ];
  }];
  text: {
    format: {
      type: "json_schema";
      name: typeof S4_ASSESSMENT_SCHEMA_NAME;
      strict: true;
      schema: typeof S4_ASSESSMENT_JSON_SCHEMA;
    };
  };
};

function imageDataUrl(bytes: Uint8Array): string {
  return "data:image/png;base64," + Buffer.from(bytes).toString("base64");
}

export function buildS4AssessmentRequest(input: S4AssessmentProviderInput): S4AssessmentRequest {
  return {
    endpoint: "/v1/responses",
    model: S4_ASSESSMENT_MODEL,
    store: false,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: input.promptText },
        { type: "input_image", image_url: imageDataUrl(input.sourceBytes), detail: "high" },
        { type: "input_image", image_url: imageDataUrl(input.outputBytes), detail: "high" },
        { type: "input_image", image_url: imageDataUrl(input.maskBytes), detail: "high" },
      ],
    }],
    text: {
      format: {
        type: "json_schema",
        name: S4_ASSESSMENT_SCHEMA_NAME,
        strict: true,
        schema: S4_ASSESSMENT_JSON_SCHEMA,
      },
    },
  };
}

export type S4ProviderContract = {
  runS4ImageEdit(input: S4ImageProviderInput): Promise<S4ImageProviderResult>;
  runS4Assessment(input: S4AssessmentProviderInput): Promise<S4AssessmentProviderResult>;
  /** These checks are local-only and MUST NOT start provider transport. */
  assertS4ImageEditReady?: () => void;
  assertS4AssessmentReady?: () => void;
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
  try { return Buffer.from(value, "base64").toString("base64") === value; } catch { return false; }
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProviderFailure("PROVIDER_MALFORMED_RESPONSE");
  return value as Record<string, unknown>;
}

function providerUsage(body: Record<string, unknown>): Omit<S4ProviderUsage, "providerRequestId"> {
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

export class OpenAIS4Provider implements S4ProviderContract {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: { apiKey?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 90_000;
  }

  assertS4ImageEditReady(): void {
    this.assertConfigured();
  }

  assertS4AssessmentReady(): void {
    this.assertConfigured();
  }

  private assertConfigured(): void {
    if (!this.apiKey) throw new ProviderFailure("PROVIDER_NOT_CONFIGURED");
  }

  private async postJson(path: string, body: Record<string, unknown>): Promise<{ response: Response; body: Record<string, unknown> }> {
    this.assertConfigured();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl("https://api.openai.com/v1/" + path, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + this.apiKey },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        throw new ProviderFailure(controller.signal.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE");
      }
      let parsed: Record<string, unknown>;
      try { parsed = parseObject(await response.json()); }
      catch (error) {
        if (error instanceof ProviderFailure) throw error;
        throw new ProviderFailure(response.ok ? "PROVIDER_MALFORMED_RESPONSE" : "PROVIDER_HTTP_ERROR");
      }
      if (!response.ok) {
        if (response.status === 429) throw new ProviderFailure("PROVIDER_RATE_LIMIT");
        if (response.status >= 500) throw new ProviderFailure("PROVIDER_SERVER_ERROR");
        throw new ProviderFailure("PROVIDER_CLIENT_ERROR");
      }
      return { response, body: parsed };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async postMultipart(path: string, form: FormData): Promise<{ response: Response; body: Record<string, unknown> }> {
    this.assertConfigured();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl("https://api.openai.com/v1/" + path, {
          method: "POST",
          headers: { authorization: "Bearer " + this.apiKey },
          body: form,
          signal: controller.signal,
        });
      } catch {
        throw new ProviderFailure(controller.signal.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE");
      }
      let parsed: Record<string, unknown>;
      try { parsed = parseObject(await response.json()); }
      catch (error) {
        if (error instanceof ProviderFailure) throw error;
        throw new ProviderFailure(response.ok ? "PROVIDER_MALFORMED_RESPONSE" : "PROVIDER_HTTP_ERROR");
      }
      if (!response.ok) {
        if (response.status === 429) throw new ProviderFailure("PROVIDER_RATE_LIMIT");
        if (response.status >= 500) throw new ProviderFailure("PROVIDER_SERVER_ERROR");
        throw new ProviderFailure("PROVIDER_CLIENT_ERROR");
      }
      return { response, body: parsed };
    } finally {
      clearTimeout(timeout);
    }
  }

  async runS4ImageEdit(input: S4ImageProviderInput): Promise<S4ImageProviderResult> {
    const request = buildS4ImageRequest(input);
    const form = new FormData();
    form.append("model", request.model);
    form.append("n", String(request.n));
    form.append("size", request.size);
    form.append("quality", request.quality);
    form.append("output_format", request.output_format);
    form.append("prompt", request.prompt);
    form.append(request.imageParts[0].field, new Blob([Buffer.from(request.imageParts[0].bytes)], { type: request.imageParts[0].contentType }), request.imageParts[0].fileName);
    form.append(request.maskPart.field, new Blob([Buffer.from(request.maskPart.bytes)], { type: request.maskPart.contentType }), request.maskPart.fileName);
    const { response, body } = await this.postMultipart("images/edits", form);
    const data = Array.isArray(body.data) ? body.data : [];
    if (data.length !== 1 || typeof data[0] !== "object" || data[0] === null) throw new ProviderFailure("IMAGE_EMPTY");
    const encoded = (data[0] as Record<string, unknown>).b64_json;
    if (typeof encoded !== "string" || !strictBase64(encoded)) throw new ProviderFailure("IMAGE_MALFORMED");
    const pngBytes = Buffer.from(encoded, "base64");
    if (!pngBytes.length) throw new ProviderFailure("IMAGE_EMPTY");
    return { pngBytes, providerRequestId: responseRequestId(response, body), usage: providerUsage(body) };
  }

  async runS4Assessment(input: S4AssessmentProviderInput): Promise<S4AssessmentProviderResult> {
    const request = buildS4AssessmentRequest(input);
    const { response, body } = await this.postJson("responses", request as unknown as Record<string, unknown>);
    if (body.status === "incomplete" || body.incomplete_details) throw new ProviderFailure("QA_PROVIDER_INCOMPLETE");
    let payload: unknown;
    try { payload = JSON.parse(outputText(body)); }
    catch (error) {
      if (error instanceof ProviderFailure) throw error;
      throw new ProviderFailure("QA_SCHEMA_INVALID");
    }
    return { payload, providerRequestId: responseRequestId(response, body), usage: providerUsage(body) };
  }
}
