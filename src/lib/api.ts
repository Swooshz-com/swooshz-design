import { NextResponse } from "next/server";
import { AppError, type UUID } from "./types";
import { assertUuid, uuidV4Pattern } from "./utils";
import { MAX_BRIEF_BYTES } from "./media";
import { S2_MAX_MULTIPART_BODY_BYTES, S2_MAX_SOURCE_BYTES } from "./s2-media";
import { createWorkflowService, type WorkflowService } from "./workflow";

const MAX_MULTIPART_BODY_BYTES = MAX_BRIEF_BYTES + 1024 * 1024;
const MAX_S4_BODY_BYTES = 131072;
const PUBLIC_S3_ERROR_CODES = new Set<string>([
  "INVALID_REQUEST",
  "IDEMPOTENCY_KEY_REQUIRED",
  "PROJECT_NOT_FOUND",
  "S3_SOURCE_NOT_FOUND",
  "S3_CYCLE_NOT_FOUND",
  "S3_REVISION_NOT_FOUND",
  "S3_SOURCE_NOT_ELIGIBLE",
  "S3_SOURCE_INTEGRITY_MISMATCH",
  "S3_SOURCE_RESELECTION_CLOSED",
  "S3_SELECTION_VERSION_CONFLICT",
  "S3_SELECTION_TARGET_INVALID",
  "S3_LINEAGE_CONFLICT",
  "S3_REFINEMENT_IN_PROGRESS",
  "S3_REFINEMENT_BUDGET_EXHAUSTED",
  "S3_DUPLICATE_REFINEMENT",
  "S3_DUPLICATE_IMAGE_RETRY",
  "S3_DUPLICATE_ASSESSMENT_RETRY",
  "S3_IMAGE_RETRY_NOT_AVAILABLE",
  "S3_ASSESSMENT_RETRY_NOT_AVAILABLE",
  "S3_RETRY_WAIVED",
  "S4_ROLLBACK_IN_PROGRESS",
  "S3_INTENT_INVALID",
  "IDEMPOTENCY_KEY_REUSE",
  "METHOD_NOT_ALLOWED",
  "S3_INTERNAL_ERROR",
]);
const PUBLIC_S4_ERROR_CODES = new Set<string>([
  "INVALID_REQUEST",
  "IDEMPOTENCY_KEY_REQUIRED",
  "PROJECT_NOT_FOUND",
  "S4_NOT_AVAILABLE",
  "S4_SOURCE_NOT_FOUND",
  "S4_REVISION_NOT_FOUND",
  "S4_EDIT_NOT_FOUND",
  "S4_SOURCE_NOT_ELIGIBLE",
  "S4_SOURCE_INTEGRITY_MISMATCH",
  "S4_MASK_INVALID",
  "S4_MASK_EMPTY",
  "S4_MASK_AREA_TOO_SMALL",
  "S4_MASK_AREA_TOO_LARGE",
  "S4_MASK_FULL_IMAGE",
  "S4_MASK_COMPARISON_TOO_SMALL",
  "S4_INSTRUCTION_INVALID",
  "S4_SELECTION_VERSION_CONFLICT",
  "S4_STALE_SOURCE",
  "S4_EDIT_IN_PROGRESS",
  "S4_BUDGET_EXHAUSTED",
  "S4_DUPLICATE_EDIT",
  "S4_IMAGE_RETRY_NOT_AVAILABLE",
  "S4_ASSESSMENT_RETRY_NOT_AVAILABLE",
  "S4_RETRY_WAIVED",
  "S4_PRESERVATION_FAILED",
  "S4_NOOP_OUTPUT",
  "S4_ROLLBACK_TARGET_INVALID",
  "S4_ROLLBACK_IN_PROGRESS",
  "S4_IDEMPOTENCY_KEY_REUSE",
  "METHOD_NOT_ALLOWED",
  "S4_INTERNAL_ERROR",
]);

const S4_PUBLIC_FIELDS = new Set(["body", "projectId", "baseRevisionId", "expectedSelectionVersion", "primitives", "instructionText", "editId", "targetId", "Idempotency-Key", "x-request-id", "request"]);
const S4_PUBLIC_FIELD_CODES = new Set(["REQUIRED", "UNKNOWN_FIELD", "JSON_REQUIRED", "JSON_OBJECT_REQUIRED", "BODY_LENGTH_INVALID", "BODY_TOO_LARGE", "EMPTY_BODY_REQUIRED", "IDEMPOTENCY_KEY_REQUIRED", "UUID_REQUIRED", "INVALID_VALUE", "INVALID_REQUEST"]);

function safeS4Field(field: string): string {
  if (S4_PUBLIC_FIELDS.has(field) || /^primitives(?:\[\d+\])?(?:\.(?:kind|xQ16|yQ16|widthQ16|heightQ16|radiusQ8|points)(?:\[\d+\])?(?:\.(?:xQ16|yQ16))?)?$/.test(field)) return field;
  return "body";
}

function safeS4FieldErrors(fieldErrors: readonly { field: string; code: string }[]): { field: string; code: string }[] {
  return fieldErrors.map((item) => ({ field: safeS4Field(item.field), code: S4_PUBLIC_FIELD_CODES.has(item.code) ? item.code : "INVALID_REQUEST" }));
}

function requestReferenceId(request: Request): UUID {
  const supplied = request.headers.get("x-request-id");
  return supplied && uuidV4Pattern.test(supplied) ? supplied : crypto.randomUUID();
}

function jsonError(referenceId: UUID, error: unknown, s3 = false, s4 = false): NextResponse {
  const candidate = error instanceof AppError
    ? error
    : new AppError(500, s4 ? "S4_INTERNAL_ERROR" : s3 ? "S3_INTERNAL_ERROR" : "INTERNAL_ERROR");
  const appError = s4 && !PUBLIC_S4_ERROR_CODES.has(candidate.code)
    ? new AppError(500, "S4_INTERNAL_ERROR")
    : s3 && !PUBLIC_S3_ERROR_CODES.has(candidate.code)
      ? new AppError(500, "S3_INTERNAL_ERROR")
      : candidate;
  const body = {
    error: {
      code: appError.code,
      message: "The request could not be completed. Try again or contact support with the reference ID.",
      referenceId,
      fieldErrors: s4 ? safeS4FieldErrors(appError.fieldErrors) : appError.fieldErrors,
    },
  };
  console.error(JSON.stringify({ referenceId, operation: "api_request", status: appError.status, code: appError.code }));
  return NextResponse.json(body, { status: appError.status });
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error("object required");
    }
    return body as Record<string, unknown>;
  } catch {
    throw new AppError(400, "INVALID_REQUEST", [{ field: "body", code: "JSON_OBJECT_REQUIRED" }]);
  }
}

async function s4JsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new AppError(400, "INVALID_REQUEST", [{ field: "body", code: "JSON_REQUIRED" }]);
  }
  const suppliedLength = request.headers.get("content-length");
  if (suppliedLength !== null) {
    const parsedLength = Number(suppliedLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new AppError(400, "INVALID_REQUEST", [{ field: "body", code: "BODY_LENGTH_INVALID" }]);
    }
    if (parsedLength > MAX_S4_BODY_BYTES) {
      throw new AppError(400, "INVALID_REQUEST", [{ field: "body", code: "BODY_TOO_LARGE" }]);
    }
  }
  if (!request.body) throw new AppError(400, "INVALID_REQUEST", [{ field: "body", code: "JSON_OBJECT_REQUIRED" }]);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_S4_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AppError(400, "INVALID_REQUEST", [{ field: "body", code: "BODY_TOO_LARGE" }]);
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)));
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("object required");
    return body as Record<string, unknown>;
  } catch {
    throw new AppError(400, "INVALID_REQUEST", [{ field: "body", code: "JSON_OBJECT_REQUIRED" }]);
  }
}

function keyFromHeader(request: Request, header: string): UUID {
  const key = request.headers.get(header);
  assertUuid(key, header);
  return key;
}

function s2IdempotencyKeyFromHeader(request: Request): UUID {
  const key = request.headers.get("Idempotency-Key");
  if (key === null || key.trim() === "") {
    throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", [{ field: "Idempotency-Key", code: "IDEMPOTENCY_KEY_REQUIRED" }]);
  }
  assertUuid(key, "Idempotency-Key");
  return key;
}

function exactKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  const fieldErrors = [] as { field: string; code: string }[];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) fieldErrors.push({ field: key, code: "REQUIRED" });
  }
  for (const key of Object.keys(body)) {
    if (!expected.has(key)) fieldErrors.push({ field: key, code: "UNKNOWN_FIELD" });
  }
  if (fieldErrors.length) throw new AppError(400, "INVALID_REQUEST", fieldErrors);
}

async function requireEmptyBody(request: Request): Promise<void> {
  if (!request.body) return;
  const reader = request.body.getReader();
  try {
    for (let count = 0; count < 8; count += 1) {
      const next = await reader.read();
      if (next.done) return;
      if (next.value.byteLength > 0) {
        await reader.cancel().catch(() => undefined);
        throw new AppError(400, "INVALID_REQUEST", [{ field: "body", code: "EMPTY_BODY_REQUIRED" }]);
      }
    }
    await reader.cancel().catch(() => undefined);
    throw new AppError(400, "INVALID_REQUEST", [{ field: "body", code: "EMPTY_BODY_REQUIRED" }]);
  } finally {
    reader.releaseLock();
  }
}

function uploadTooLarge(): AppError {
  return new AppError(413, "BRIEF_UPLOAD_TOO_LARGE", [{ field: "file", code: "PDF_SIZE_INVALID" }]);
}

async function boundedBody(request: Request): Promise<Buffer> {
  const suppliedLength = request.headers.get("content-length");
  if (suppliedLength) {
    const parsedLength = Number(suppliedLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > MAX_MULTIPART_BODY_BYTES) {
      throw uploadTooLarge();
    }
  }
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      total += chunk.byteLength;
      if (total > MAX_MULTIPART_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw uploadTooLarge();
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function headerValue(headers: Map<string, string>, name: string): string {
  return headers.get(name.toLowerCase()) ?? "";
}

async function multipartFile(request: Request): Promise<{ fileName: string; mimeType: string; bytes: Uint8Array }> {
  const contentType = request.headers.get("content-type") ?? "";
  const match = contentType.match(/^multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))\s*$/i);
  if (!match) {
    throw new AppError(400, "BRIEF_UPLOAD_INVALID", [{ field: "file", code: "MULTIPART_REQUIRED" }]);
  }
  const boundary = match[1] ?? match[2];
  if (!boundary || boundary.length > 70) {
    throw new AppError(400, "BRIEF_UPLOAD_INVALID", [{ field: "file", code: "MULTIPART_INVALID" }]);
  }
  const body = await boundedBody(request);
  const marker = Buffer.from("--" + boundary, "latin1");
  if (!body.subarray(0, marker.length).equals(marker)) {
    throw new AppError(400, "BRIEF_UPLOAD_INVALID", [{ field: "file", code: "MULTIPART_INVALID" }]);
  }

  const delimiter = Buffer.from("\r\n" + marker.toString("latin1"), "latin1");
  const parts: { headers: Map<string, string>; bytes: Buffer }[] = [];
  let cursor = marker.length;
  while (true) {
    if (body.subarray(cursor, cursor + 2).toString("latin1") === "--") {
      cursor += 2;
      break;
    }
    if (body.subarray(cursor, cursor + 2).toString("latin1") !== "\r\n") {
      throw new AppError(400, "BRIEF_UPLOAD_INVALID", [{ field: "file", code: "MULTIPART_INVALID" }]);
    }
    cursor += 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n", "latin1"), cursor);
    if (headerEnd < 0) {
      throw new AppError(400, "BRIEF_UPLOAD_INVALID", [{ field: "file", code: "MULTIPART_INVALID" }]);
    }
    const headers = new Map<string, string>();
    for (const line of body.subarray(cursor, headerEnd).toString("latin1").split("\r\n")) {
      const separator = line.indexOf(":");
      if (separator > 0) headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }
    const partStart = headerEnd + 4;
    const nextBoundary = body.indexOf(delimiter, partStart);
    if (nextBoundary < 0) {
      throw new AppError(400, "BRIEF_UPLOAD_INVALID", [{ field: "file", code: "MULTIPART_INVALID" }]);
    }
    parts.push({ headers, bytes: body.subarray(partStart, nextBoundary) });
    cursor = nextBoundary + delimiter.length;
    if (body.subarray(cursor, cursor + 2).toString("latin1") === "--") {
      cursor += 2;
      break;
    }
  }

  if (cursor < body.length && body.subarray(cursor).toString("latin1").trim() !== "") {
    throw new AppError(400, "BRIEF_UPLOAD_INVALID", [{ field: "file", code: "MULTIPART_INVALID" }]);
  }
  if (parts.length !== 1) {
    throw new AppError(400, "BRIEF_UPLOAD_INVALID", [{ field: "file", code: "ONE_PDF_REQUIRED" }]);
  }
  const disposition = headerValue(parts[0].headers, "content-disposition");
  const name = disposition.match(/(?:^|;)\s*name="([^"]*)"/i)?.[1] ?? "";
  const fileName = disposition.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1] ?? "";
  if (name !== "file" || !fileName) {
    throw new AppError(400, "BRIEF_UPLOAD_INVALID", [{ field: "file", code: "ONE_PDF_REQUIRED" }]);
  }
  return {
    fileName,
    mimeType: headerValue(parts[0].headers, "content-type"),
    bytes: parts[0].bytes,
  };
}

const S2_MULTIPART_HEADER_BYTES = 16 * 1024;
const S2_MULTIPART_FIELD_BYTES = 512;
const S2_MULTIPART_TRAILER_BYTES = 256;

function s2MultipartError(field = "file", code = "MULTIPART_INVALID"): AppError {
  return new AppError(400, "INVALID_REQUEST", [{ field, code }]);
}

function s2MultipartDisposition(value: string): { name: string; fileName: string | null } {
  if (!/^form-data(?:;|$)/i.test(value)) throw s2MultipartError();
  const nameMatch = value.match(/(?:^|;)\s*name=(?:"([^"]*)"|([^;\s]*))/i);
  const fileNameMatch = value.match(/(?:^|;)\s*filename=(?:"([^"]*)"|([^;\s]*))/i);
  const name = nameMatch?.[1] ?? nameMatch?.[2] ?? "";
  const fileName = fileNameMatch?.[1] ?? fileNameMatch?.[2] ?? null;
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) throw s2MultipartError("body", "INVALID_FIELD");
  if (fileName !== null && (fileName.length > 256 || /[\u0000-\u001f\u007f]/.test(fileName))) throw s2MultipartError("file", "INVALID_FIELD");
  return { name, fileName };
}

function s2MultipartHeaders(value: Buffer): Map<string, string> {
  const headers = new Map<string, string>();
  const text = value.toString("latin1");
  if (!text || text.includes("\r\n\r\n")) throw s2MultipartError();
  for (const line of text.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0 || !/^[!#$%&'*+.^_|~0-9A-Za-z-]+$/.test(line.slice(0, separator))) throw s2MultipartError();
    const name = line.slice(0, separator).toLowerCase();
    const headerValue = line.slice(separator + 1).trim();
    if (headers.has(name) || headerValue.length > 4096 || /[\r\n]/.test(headerValue)) throw s2MultipartError();
    headers.set(name, headerValue);
  }
  return headers;
}

async function multipartS2File(request: Request): Promise<{ fileName: string; mimeType: string; kind: "reference" | "logo"; bytes: Uint8Array }> {
  const contentType = request.headers.get("content-type") ?? "";
  const match = contentType.match(/^multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))\s*$/i);
  if (!match) throw s2MultipartError("file", "MULTIPART_REQUIRED");
  const boundary = match[1] ?? match[2];
  if (!boundary || boundary.length > 70 || /[\r\n]/.test(boundary)) throw s2MultipartError();
  const marker = Buffer.from("--" + boundary, "latin1");
  const delimiter = Buffer.from("\r\n" + marker.toString("latin1"), "latin1");
  const headerEnd = Buffer.from("\r\n\r\n", "latin1");
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) throw s2MultipartError("body", "MULTIPART_INVALID");
    if (parsedLength > S2_MAX_MULTIPART_BODY_BYTES) {
      throw new AppError(413, "MEDIA_TOO_LARGE", [{ field: "file", code: "MEDIA_TOO_LARGE" }]);
    }
  }
  if (!request.body) throw s2MultipartError();

  type Part = { name: string; fileName: string | null; mimeType: string; chunks: Buffer[]; size: number };
  const fields = new Map<string, Part>();
  let current: Part | null = null;
  let pending = Buffer.alloc(0);
  let total = 0;
  let trailerBytes = 0;
  let state: "initial" | "headers" | "body" | "suffix" | "trailer" = "initial";

  const appendPartBytes = (value: Buffer): void => {
    if (!current || value.length === 0) return;
    const limit = current.name === "file" ? S2_MAX_SOURCE_BYTES : S2_MULTIPART_FIELD_BYTES;
    if (current.size + value.length > limit) {
      if (current.name === "file") throw new AppError(413, "MEDIA_TOO_LARGE", [{ field: "file", code: "MEDIA_TOO_LARGE" }]);
      throw s2MultipartError(current.name, "FIELD_TOO_LARGE");
    }
    current.chunks.push(Buffer.from(value));
    current.size += value.length;
  };

  const finishPart = (): void => {
    if (!current) throw s2MultipartError();
    if (fields.has(current.name)) throw s2MultipartError(current.name, "INVALID_FIELD");
    fields.set(current.name, current);
    current = null;
  };

  const processPending = (): void => {
    while (true) {
      if (state === "initial") {
        if (pending.length < marker.length) return;
        if (!pending.subarray(0, marker.length).equals(marker)) throw s2MultipartError();
        pending = Buffer.from(pending.subarray(marker.length));
        state = "suffix";
      }
      if (state === "headers") {
        const end = pending.indexOf(headerEnd);
        if (end < 0) {
          if (pending.length > S2_MULTIPART_HEADER_BYTES) throw s2MultipartError();
          return;
        }
        if (end > S2_MULTIPART_HEADER_BYTES) throw s2MultipartError();
        const headers = s2MultipartHeaders(pending.subarray(0, end));
        const disposition = s2MultipartDisposition(headerValue(headers, "content-disposition"));
        if (!["file", "kind", "filename"].includes(disposition.name) || fields.has(disposition.name)) {
          throw s2MultipartError(disposition.name || "body", "INVALID_FIELD");
        }
        current = { name: disposition.name, fileName: disposition.fileName, mimeType: headerValue(headers, "content-type"), chunks: [], size: 0 };
        pending = Buffer.from(pending.subarray(end + headerEnd.length));
        state = "body";
      }
      if (state === "body") {
        const next = pending.indexOf(delimiter);
        if (next < 0) {
          const keep = Math.min(pending.length, Math.max(0, delimiter.length - 1));
          const complete = pending.length - keep;
          if (complete > 0) appendPartBytes(pending.subarray(0, complete));
          pending = Buffer.from(pending.subarray(complete));
          return;
        }
        appendPartBytes(pending.subarray(0, next));
        pending = Buffer.from(pending.subarray(next + delimiter.length));
        finishPart();
        state = "suffix";
      }
      if (state === "suffix") {
        if (pending.length < 2) return;
        if (pending.subarray(0, 2).toString("latin1") === "--") {
          pending = Buffer.from(pending.subarray(2));
          state = "trailer";
        } else if (pending.subarray(0, 2).toString("latin1") === "\r\n") {
          pending = Buffer.from(pending.subarray(2));
          state = "headers";
        } else {
          throw s2MultipartError();
        }
      }
      if (state === "trailer") {
        trailerBytes += pending.length;
        if (trailerBytes > S2_MULTIPART_TRAILER_BYTES ||
            Array.from(pending).some((byte) => ![9, 10, 13, 32].includes(byte))) throw s2MultipartError();
        pending = Buffer.alloc(0);
        return;
      }
    }
  };

  const reader = request.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > S2_MAX_MULTIPART_BODY_BYTES - total) {
        await reader.cancel().catch(() => undefined);
        throw new AppError(413, "MEDIA_TOO_LARGE", [{ field: "file", code: "MEDIA_TOO_LARGE" }]);
      }
      total += next.value.byteLength;
      const chunk = Buffer.from(next.value);
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      processPending();
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  processPending();
  const finalState: string = state;
  if (finalState !== "trailer" || current !== null || pending.length !== 0) throw s2MultipartError();
  const file = fields.get("file");
  const kindPart = fields.get("kind");
  if (!file || !kindPart || fields.size > 3) throw s2MultipartError("body", "S2_FIELDS_REQUIRED");
  const decodeField = (part: Part): string => {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(part.chunks, part.size)); }
    catch { throw s2MultipartError(part.name, "INVALID_FIELD"); }
  };
  const kind = decodeField(kindPart).trim();
  if (kind !== "reference" && kind !== "logo") throw new AppError(400, "INVALID_ASSET_KIND", [{ field: "kind", code: "INVALID_ASSET_KIND" }]);
  const suppliedFileName = fields.get("filename") ? decodeField(fields.get("filename")!).trim() : "";
  const fileName = suppliedFileName || file.fileName || "asset";
  return { fileName, mimeType: file.mimeType, kind, bytes: Buffer.concat(file.chunks, file.size) };
}

function serviceForRequest(): WorkflowService {
  return createWorkflowService();
}

export type S3AccessContext = {
  subjectId: string;
};

export type S3AccessContextResolver = (
  request: Request,
) => S3AccessContext | null | Promise<S3AccessContext | null>;

export type S3ProjectAuthorizer = (
  context: S3AccessContext,
  projectId: UUID,
) => boolean | Promise<boolean>;

export type S3AuthorizationBoundary = {
  resolveContext: S3AccessContextResolver;
  authorizeProject: S3ProjectAuthorizer;
};

export const productionS3Authorization: S3AuthorizationBoundary = {
  resolveContext: async () => null,
  authorizeProject: async () => false,
};

export type ApiRequestDependencies = {
  workflowService?: WorkflowService;
  s3Authorization: S3AuthorizationBoundary;
};

function isApiRequestDependencies(
  value: WorkflowService | ApiRequestDependencies | undefined,
): value is ApiRequestDependencies {
  return Boolean(value && typeof value === "object" && "s3Authorization" in value);
}

function isS3Path(segments: string[]): boolean {
  return segments.length >= 3 && segments[0] === "projects" && segments[2] === "s3";
}

function isS4Path(segments: string[]): boolean {
  return segments.length >= 3 && segments[0] === "projects" && segments[2] === "s4";
}

async function authorizedS3Service(
  request: Request,
  segments: string[],
  supplied: WorkflowService | ApiRequestDependencies | undefined,
): Promise<WorkflowService> {
  const projectId = segments[1];
  if (typeof projectId !== "string" || !uuidV4Pattern.test(projectId)) {
    throw new AppError(404, "PROJECT_NOT_FOUND");
  }
  const dependencies = isApiRequestDependencies(supplied)
    ? supplied
    : { workflowService: supplied, s3Authorization: productionS3Authorization };
  let context: S3AccessContext | null;
  try {
    context = await dependencies.s3Authorization.resolveContext(request);
  } catch {
    throw new AppError(404, "PROJECT_NOT_FOUND");
  }
  if (!context || typeof context.subjectId !== "string" || context.subjectId.length === 0) {
    throw new AppError(404, "PROJECT_NOT_FOUND");
  }
  try {
    if (!(await dependencies.s3Authorization.authorizeProject(context, projectId))) {
      throw new AppError(404, "PROJECT_NOT_FOUND");
    }
  } catch (error) {
    if (error instanceof AppError && error.code === "PROJECT_NOT_FOUND") throw error;
    throw new AppError(404, "PROJECT_NOT_FOUND");
  }
  return dependencies.workflowService ?? serviceForRequest();
}

async function authorizedS4Service(
  request: Request,
  segments: string[],
  supplied: WorkflowService | ApiRequestDependencies | undefined,
): Promise<WorkflowService> {
  const projectId = segments[1];
  if (typeof projectId !== "string" || !uuidV4Pattern.test(projectId)) {
    throw new AppError(404, "PROJECT_NOT_FOUND");
  }
  const dependencies = isApiRequestDependencies(supplied)
    ? supplied
    : { workflowService: supplied, s3Authorization: productionS3Authorization };
  let context: S3AccessContext | null;
  try {
    context = await dependencies.s3Authorization.resolveContext(request);
  } catch {
    throw new AppError(404, "PROJECT_NOT_FOUND");
  }
  if (!context || typeof context.subjectId !== "string" || context.subjectId.length === 0) {
    throw new AppError(404, "PROJECT_NOT_FOUND");
  }
  try {
    if (!(await dependencies.s3Authorization.authorizeProject(context, projectId))) {
      throw new AppError(404, "PROJECT_NOT_FOUND");
    }
  } catch (error) {
    if (error instanceof AppError && error.code === "PROJECT_NOT_FOUND") throw error;
    throw new AppError(404, "PROJECT_NOT_FOUND");
  }
  return dependencies.workflowService ?? serviceForRequest();
}

async function handleS3(
  request: Request,
  method: string,
  segments: string[],
  service: WorkflowService,
  referenceId: UUID,
): Promise<NextResponse> {
  const projectId = segments[1] as UUID;

  if (segments.length === 3) {
    if (method !== "GET") throw new AppError(405, "METHOD_NOT_ALLOWED");
    await requireEmptyBody(request);
    return NextResponse.json(service.s3.getState(projectId), { status: 200 });
  }

  if (segments.length === 4 && segments[3] === "selection") {
    if (method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED");
    const body = await jsonBody(request);
    exactKeys(body, ["targetKind", "targetId", "expectedSelectionVersion"]);
    if (body.targetKind !== "source_root" && body.targetKind !== "revision") {
      throw new AppError(400, "INVALID_REQUEST", [{ field: "targetKind", code: "INVALID_VALUE" }]);
    }
    assertUuid(body.targetId, "targetId");
    const result = service.s3.selectSource(
      projectId,
      body.targetKind,
      body.targetId,
      body.expectedSelectionVersion as number,
      s2IdempotencyKeyFromHeader(request),
      referenceId,
    );
    return NextResponse.json(result, { status: 200 });
  }

  if (segments.length === 4 && segments[3] === "refinements") {
    if (method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED");
    const body = await jsonBody(request);
    exactKeys(body, ["baseRevisionId", "expectedSelectionVersion", "intentText"]);
    assertUuid(body.baseRevisionId, "baseRevisionId");
    const result = service.s3.refine(
      projectId,
      body.baseRevisionId,
      body.expectedSelectionVersion as number,
      body.intentText,
      s2IdempotencyKeyFromHeader(request),
      referenceId,
    );
    return NextResponse.json(result, { status: result.replayed ? 200 : 202 });
  }

  if (segments.length === 5 && segments[3] === "refinements") {
    assertUuid(segments[4], "cycleId");
    if (method !== "GET") throw new AppError(405, "METHOD_NOT_ALLOWED");
    await requireEmptyBody(request);
    return NextResponse.json(service.s3.getCycle(projectId, segments[4]), { status: 200 });
  }

  if (segments.length === 6 && segments[3] === "refinements" && segments[5] === "image-retry") {
    assertUuid(segments[4], "cycleId");
    if (method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED");
    await requireEmptyBody(request);
    const result = service.s3.imageRetry(projectId, segments[4], s2IdempotencyKeyFromHeader(request), referenceId);
    return NextResponse.json(result, { status: result.replayed ? 200 : 202 });
  }

  if (segments.length === 6 && segments[3] === "refinements" && segments[5] === "assessment-retry") {
    assertUuid(segments[4], "cycleId");
    if (method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED");
    await requireEmptyBody(request);
    const result = service.s3.assessmentRetry(projectId, segments[4], s2IdempotencyKeyFromHeader(request), referenceId);
    return NextResponse.json(result, { status: result.replayed ? 200 : 202 });
  }

  if (segments.length === 5 && segments[3] === "revisions") {
    assertUuid(segments[4], "revisionId");
    if (method !== "GET") throw new AppError(405, "METHOD_NOT_ALLOWED");
    await requireEmptyBody(request);
    return NextResponse.json(service.s3.getRevision(projectId, segments[4]), { status: 200 });
  }

  if (segments.length === 6 && segments[3] === "revisions" && segments[5] === "preview") {
    assertUuid(segments[4], "revisionId");
    if (method !== "GET") throw new AppError(405, "METHOD_NOT_ALLOWED");
    await requireEmptyBody(request);
    const result = await service.s3.getPreview(projectId, segments[4]);
    return new NextResponse(new Uint8Array(result.bytes), {
      status: 200,
      headers: {
        "content-type": "image/png",
        "cache-control": "private, no-store",
        "content-length": String(result.contentLength),
      },
    });
  }

  throw new AppError(400, "INVALID_REQUEST");
}

async function handleS4(
  request: Request,
  method: string,
  segments: string[],
  service: WorkflowService,
  referenceId: UUID,
): Promise<NextResponse> {
  const projectId = segments[1] as UUID;

  if (segments.length === 3) {
    if (method !== "GET") throw new AppError(405, "METHOD_NOT_ALLOWED");
    await requireEmptyBody(request);
    return NextResponse.json(service.s4.getState(projectId), { status: 200 });
  }

  if (segments.length === 4 && segments[3] === "edits") {
    if (method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED");
    const body = await s4JsonBody(request);
    exactKeys(body, ["baseRevisionId", "expectedSelectionVersion", "primitives", "instructionText"]);
    assertUuid(body.baseRevisionId, "baseRevisionId");
    const result = service.s4.admitEdit(
      projectId,
      body,
      s2IdempotencyKeyFromHeader(request),
      referenceId,
    );
    return NextResponse.json(result, { status: result.replayed ? 200 : 202 });
  }

  if (segments.length === 5 && segments[3] === "edits") {
    if (method !== "GET") throw new AppError(405, "METHOD_NOT_ALLOWED");
    assertUuid(segments[4], "editId");
    await requireEmptyBody(request);
    return NextResponse.json(service.s4.getEdit(projectId, segments[4]), { status: 200 });
  }

  if (segments.length === 6 && segments[3] === "edits" && segments[5] === "image-retry") {
    if (method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED");
    assertUuid(segments[4], "editId");
    await requireEmptyBody(request);
    const result = service.s4.imageRetry(projectId, segments[4], s2IdempotencyKeyFromHeader(request), referenceId);
    return NextResponse.json(result, { status: result.replayed ? 200 : 202 });
  }

  if (segments.length === 6 && segments[3] === "edits" && segments[5] === "assessment-retry") {
    if (method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED");
    assertUuid(segments[4], "editId");
    await requireEmptyBody(request);
    const result = service.s4.assessmentRetry(projectId, segments[4], s2IdempotencyKeyFromHeader(request), referenceId);
    return NextResponse.json(result, { status: result.replayed ? 200 : 202 });
  }

  throw new AppError(400, "INVALID_REQUEST");
}

async function handle(
  request: Request,
  method: string,
  segments: string[],
  service: WorkflowService,
  referenceId: UUID,
): Promise<NextResponse> {
  if (segments.length === 4 && segments[0] === "projects" && segments[2] === "s2" && segments[3] === "reference-assets" && method === "POST") {
    assertUuid(segments[1], "projectId"); service.s2.authorizeProject(segments[1]);
    const key = s2IdempotencyKeyFromHeader(request); const file = await multipartS2File(request);
    const result = await service.s2.uploadAsset(segments[1], file.kind, file.fileName, file.mimeType, file.bytes, key);
    return NextResponse.json({ asset: result.asset, draft: result.draft }, { status: result.replayed ? 200 : 201 });
  }
  if (segments.length === 4 && segments[0] === "projects" && segments[2] === "s2" && segments[3] === "reference-draft" && method === "GET") {
    assertUuid(segments[1], "projectId"); service.s2.authorizeProject(segments[1]);
    return NextResponse.json({ draft: service.s2.getReferenceDraft(segments[1]) }, { status: 200 });
  }
  if (segments.length === 4 && segments[0] === "projects" && segments[2] === "s2" && segments[3] === "reference-draft" && method === "PATCH") {
    assertUuid(segments[1], "projectId"); service.s2.authorizeProject(segments[1]);
    const body = await jsonBody(request); exactKeys(body, ["expectedRevision", "referenceAssetIds", "logoAssetIds"]);
    const result = service.s2.updateDraft(segments[1], body.expectedRevision, body.referenceAssetIds, body.logoAssetIds, s2IdempotencyKeyFromHeader(request));
    return NextResponse.json({ draft: result.draft }, { status: 200 });
  }
  if (segments.length === 5 && segments[0] === "projects" && segments[2] === "s2" && segments[3] === "reference-assets" && method === "GET") {
    assertUuid(segments[1], "projectId"); service.s2.authorizeProject(segments[1]); assertUuid(segments[4], "assetId");
    const result = service.s2.getAsset(segments[1], segments[4]);
    return new NextResponse(new Uint8Array(result.bytes), { status: 200, headers: { "content-type": result.contentType, "cache-control": "private, no-store" } });
  }
  if (segments.length === 4 && segments[0] === "projects" && segments[2] === "s2" && segments[3] === "qa-runs" && method === "POST") {
    assertUuid(segments[1], "projectId"); service.s2.authorizeProject(segments[1]);
    const body = await jsonBody(request); exactKeys(body, ["sourceGenerationSetId", "expectedDraftRevision"]); assertUuid(body.sourceGenerationSetId, "sourceGenerationSetId");
    const result = await service.s2.bindQa(segments[1], body.sourceGenerationSetId, body.expectedDraftRevision, s2IdempotencyKeyFromHeader(request), referenceId);
    return NextResponse.json({ qaRun: result.qaRun, inputVersionId: result.inputVersionId }, { status: result.replayed ? 200 : 202 });
  }
  if (segments.length === 5 && segments[0] === "projects" && segments[2] === "s2" && segments[3] === "qa-runs" && method === "GET") {
    assertUuid(segments[1], "projectId"); service.s2.authorizeProject(segments[1]); assertUuid(segments[4], "qaRunId");
    return NextResponse.json(service.s2.getQaRun(segments[1], segments[4]), { status: 200 });
  }
  if (segments.length === 8 && segments[0] === "projects" && segments[2] === "s2" && segments[3] === "qa-runs" && segments[5] === "candidates" && segments[7] === "preview" && method === "GET") {
    assertUuid(segments[1], "projectId"); service.s2.authorizeProject(segments[1]); assertUuid(segments[4], "qaRunId"); assertUuid(segments[6], "candidateId");
    const result = service.s2.getCandidatePreview(segments[1], segments[4], segments[6]);
    return new NextResponse(new Uint8Array(result.bytes), { status: 200, headers: { "content-type": result.contentType, "cache-control": "private, no-store" } });
  }
  if (segments.length === 8 && segments[0] === "projects" && segments[2] === "s2" && segments[3] === "qa-runs" && segments[5] === "candidates" && segments[7] === "retry" && method === "POST") {
    assertUuid(segments[1], "projectId"); service.s2.authorizeProject(segments[1]); assertUuid(segments[4], "qaRunId"); assertUuid(segments[6], "candidateId");
    await requireEmptyBody(request);
    const result = await service.s2.retryQa(segments[1], segments[4], segments[6], s2IdempotencyKeyFromHeader(request), referenceId);
    const { replayed, ...body } = result; return NextResponse.json(body, { status: replayed ? 200 : 202 });
  }
  if (segments.length === 8 && segments[0] === "projects" && segments[2] === "s2" && segments[3] === "qa-runs" && segments[5] === "candidates" && segments[7] === "repair" && method === "POST") {
    assertUuid(segments[1], "projectId"); service.s2.authorizeProject(segments[1]); assertUuid(segments[4], "qaRunId"); assertUuid(segments[6], "candidateId");
    const body = await jsonBody(request); exactKeys(body, ["expectedInputVersionId"]); assertUuid(body.expectedInputVersionId, "expectedInputVersionId");
    const result = await service.s2.repairCandidate(segments[1], segments[4], segments[6], body.expectedInputVersionId, s2IdempotencyKeyFromHeader(request), referenceId);
    const { replayed, ...responseBody } = result; return NextResponse.json(responseBody, { status: replayed ? 200 : 202 });
  }
  if (segments.length === 1 && segments[0] === "projects" && method === "POST") {
    const body = await jsonBody(request);
    exactKeys(body, ["name"]);
    const project = service.createProject(body.name);
    return NextResponse.json({ project }, { status: 201 });
  }
  if (segments.length === 3 && segments[0] === "projects" && segments[2] === "geometry" && method === "PUT") {
    const project = service.saveGeometry(segments[1], await jsonBody(request));
    return NextResponse.json({ project }, { status: 200 });
  }
  if (segments.length === 3 && segments[0] === "projects" && segments[2] === "brief" && method === "GET") {
    return NextResponse.json(service.getBriefState(segments[1]), { status: 200 });
  }
  if (segments.length === 3 && segments[0] === "projects" && segments[2] === "brief" && method === "POST") {
    const key = keyFromHeader(request, "Idempotency-Key");
    const file = await multipartFile(request);
    const result = await service.uploadBrief(segments[1], key, file, referenceId);
    return NextResponse.json(result, { status: 202 });
  }
  if (segments.length === 4 && segments[0] === "projects" && segments[2] === "brief" && segments[3] === "draft" && method === "GET") {
    return NextResponse.json({ draft: service.getDraft(segments[1]) }, { status: 200 });
  }
  if (segments.length === 4 && segments[0] === "projects" && segments[2] === "brief" && segments[3] === "draft" && method === "PATCH") {
    const body = await jsonBody(request);
    exactKeys(body, ["data", "expectedRevision"]);
    return NextResponse.json({ draft: service.editDraft(segments[1], body.data, body.expectedRevision) }, { status: 200 });
  }
  if (segments.length === 4 && segments[0] === "projects" && segments[2] === "brief" && segments[3] === "confirm" && method === "POST") {
    const body = await jsonBody(request);
    exactKeys(body, ["draftId", "expectedRevision"]);
    const key = keyFromHeader(request, "Idempotency-Key");
    return NextResponse.json({ briefVersion: service.confirmBrief(segments[1], body.draftId, body.expectedRevision, key, referenceId) }, { status: 201 });
  }
  if (segments.length === 4 && segments[0] === "projects" && segments[2] === "brief" && segments[3] === "extraction-retry" && method === "POST") {
    const body = await jsonBody(request);
    exactKeys(body, ["assetId", "idempotencyKey"]);
    return NextResponse.json(service.retryExtraction(segments[1], body.assetId, body.idempotencyKey, referenceId), { status: 202 });
  }
  if (segments.length === 3 && segments[0] === "projects" && segments[2] === "generation-sets" && method === "POST") {
    const body = await jsonBody(request);
    exactKeys(body, ["idempotencyKey"]);
    return NextResponse.json(service.createGeneration(segments[1], body.idempotencyKey, referenceId), { status: 202 });
  }
  if (segments.length === 4 && segments[0] === "projects" && segments[2] === "generation-sets" && method === "GET") {
    return NextResponse.json(service.getGeneration(segments[1], segments[3]), { status: 200 });
  }
  if (segments.length === 5 && segments[0] === "projects" && segments[2] === "generation-sets" && segments[4] === "retry" && method === "POST") {
    const body = await jsonBody(request);
    exactKeys(body, ["idempotencyKey"]);
    return NextResponse.json(service.retryGeneration(segments[1], segments[3], body.idempotencyKey, referenceId), { status: 202 });
  }
  throw new AppError(404, "NOT_FOUND");
}

export async function handleApiRequest(
  request: Request,
  path: string[],
  supplied?: WorkflowService | ApiRequestDependencies,
): Promise<NextResponse> {
  const referenceId = requestReferenceId(request);
  try {
    if (isS4Path(path)) {
      const service = await authorizedS4Service(request, path, supplied);
      return await handleS4(request, request.method.toUpperCase(), path, service, referenceId);
    }
    if (isS3Path(path)) {
      const service = await authorizedS3Service(request, path, supplied);
      return await handleS3(request, request.method.toUpperCase(), path, service, referenceId);
    }
    const service = isApiRequestDependencies(supplied)
      ? supplied.workflowService ?? serviceForRequest()
      : supplied ?? serviceForRequest();
    return await handle(request, request.method.toUpperCase(), path, service, referenceId);
  } catch (error) {
    return jsonError(referenceId, error, isS3Path(path), isS4Path(path));
  }
}
