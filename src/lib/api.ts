import { NextResponse } from "next/server";
import { AppError, type S5MutationFence, type S6ConcurrencyToken, type S6CorrectionOperation, type S6ViewId, type UUID } from "./types";
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
const PUBLIC_S5_ERROR_CODES = new Set<string>([
  "INVALID_REQUEST", "IDEMPOTENCY_KEY_REQUIRED", "PROJECT_NOT_FOUND", "METHOD_NOT_ALLOWED", "S5_NOT_READY",
  "S5_FINAL_VISUAL_INELIGIBLE", "S5_APPROVAL_REQUIRED", "S5_APPROVAL_LOCKED", "S5_APPROVAL_STALE", "S5_REOPEN_NOT_ALLOWED",
  "S5_APPROVED_ASSET_CORRUPT", "S5_FROZEN_CONTEXT_MISMATCH", "S5_LAYOUT_INPUT_INVALID", "S5_LAYOUT_CONVENTION_INVALID",
  "S5_PLAN_HASH_MISMATCH", "S5_LAYOUT_OVERCONSTRAINED", "S5_LAYOUT_NOT_READY", "S5_PDF_OVERFLOW", "S5_PDF_SIZE_EXCEEDED",
  "S5_PDF_UNICODE_UNSUPPORTED", "S5_FONT_UNAVAILABLE", "S5_RENDER_FAILURE", "S5_PUBLICATION_BUSY", "S5_PUBLICATION_MISMATCH",
  "S5_PUBLICATION_FAILED", "S5_PUBLICATION_UNCERTAIN", "S5_CLAIM_FENCED", "S5_RETRY_EXHAUSTED", "S5_TELEMETRY_UNAVAILABLE",
  "S5_TELEMETRY_SOURCE_CORRUPT", "S5_PERSISTENCE_FAILED", "S5_ARTIFACT_NOT_FOUND", "S5_IDEMPOTENCY_KEY_REUSE", "S5_INTERNAL_ERROR",
]);

const PUBLIC_S6_ERROR_CODES = new Set<string>([
  "S6_SOURCE_NOT_READY", "S6_SOURCE_STALE", "S6_SPATIAL_SCHEMA_INVALID", "S6_GEOMETRY_INVALID", "S6_PROFILE_INVALID",
  "S6_DESIGN_FORM_UNREVIEWED", "S6_UNSUPPORTED_FORM", "S6_GEOMETRY_UNRESOLVED", "S6_REVISION_CONFLICT", "S6_ACCEPTANCE_CONFLICT",
  "S6_VIEW_RENDER_FAILURE", "S6_VIEW_PRESERVATION_FAILED", "S6_PUBLICATION_FAILED", "S6_STALE_ARTIFACT", "S6_UNAUTHORIZED_OR_NOT_FOUND",
  "S6_DEPENDENCY_UNAVAILABLE", "S6_IDEMPOTENCY_KEY_REUSE", "S6_PERSISTENCE_FAILED", "S6_CLAIM_FENCED", "S6_PUBLICATION_BUSY",
  "S6_RETRY_EXHAUSTED", "S6_INVALID_REQUEST", "S6_INTERNAL_ERROR", "S6_PROFILE_SELF_INTERSECTION", "S6_PROFILE_TOO_COMPLEX",
  "S6_CORRECTION_INVALID", "S6_CORRECTION_GEOMETRY_NOT_ALLOWED", "S6_HARD_FACT_IMMUTABLE", "S6_OBJECT_NOT_FOUND",
  "S6_UNKNOWN_NOT_FOUND", "METHOD_NOT_ALLOWED", "IDEMPOTENCY_KEY_REQUIRED",
]);
const S4_PUBLIC_FIELDS = new Set(["body", "projectId", "baseRevisionId", "expectedSelectionVersion", "primitives", "instructionText", "editId", "targetId", "Idempotency-Key", "x-request-id", "request"]);
const S4_PUBLIC_FIELD_CODES = new Set(["REQUIRED", "UNKNOWN_FIELD", "JSON_REQUIRED", "JSON_OBJECT_REQUIRED", "BODY_LENGTH_INVALID", "BODY_TOO_LARGE", "EMPTY_BODY_REQUIRED", "IDEMPOTENCY_KEY_REQUIRED", "UUID_REQUIRED", "INVALID_VALUE", "INVALID_REQUEST"]);
const S5_PUBLIC_FIELDS = new Set(["body", "projectId", "layoutGroupId", "artifactId", "expectedGenerationSetId", "expectedSelectionStateId", "expectedSelectionVersion", "expectedActiveRevisionId", "expectedApprovalEventId", "expectedApprovalGeneration", "expectedApprovalEventSequence", "reopenReason", "Idempotency-Key", "x-request-id", "request"]);
const S6_PUBLIC_FIELDS = new Set([
  "body", "projectId", "revisionId", "viewId", "operations", "expectedRevisionId", "expectedRevisionHash",
  "expectedParentRevisionId", "expectedParentHash", "expectedCurrentAcceptedRevisionId", "expectedCurrentAcceptedHash",
  "expectedSourceFingerprint", "Idempotency-Key", "x-request-id", "request",
]);
const S6_PUBLIC_FIELD_CODES = new Set(["REQUIRED", "UNKNOWN_FIELD", "JSON_REQUIRED", "JSON_OBJECT_REQUIRED", "BODY_LENGTH_INVALID", "BODY_TOO_LARGE", "EMPTY_BODY_REQUIRED", "IDEMPOTENCY_KEY_REQUIRED", "UUID_REQUIRED", "INVALID_VALUE", "INTEGER_REQUIRED", "INVALID_REQUEST"]);

function safeS4Field(field: string): string {
  if (S4_PUBLIC_FIELDS.has(field) || /^primitives(?:\[\d+\])?(?:\.(?:kind|xQ16|yQ16|widthQ16|heightQ16|radiusQ8|points)(?:\[\d+\])?(?:\.(?:xQ16|yQ16))?)?$/.test(field)) return field;
  return "body";
}

function safeS4FieldErrors(fieldErrors: readonly { field: string; code: string }[]): { field: string; code: string }[] {
  return fieldErrors.map((item) => ({ field: safeS4Field(item.field), code: S4_PUBLIC_FIELD_CODES.has(item.code) ? item.code : "INVALID_REQUEST" }));
}

function safeS5Field(field: string): string { return S5_PUBLIC_FIELDS.has(field) ? field : "body"; }
function safeS5FieldErrors(fieldErrors: readonly { field: string; code: string }[]): { field: string; code: string }[] { return fieldErrors.map((item) => ({ field: safeS5Field(item.field), code: item.code === "REQUIRED" || item.code === "UNKNOWN_FIELD" || item.code === "UUID_REQUIRED" || item.code === "IDEMPOTENCY_KEY_REQUIRED" || item.code === "INVALID_VALUE" ? item.code : "INVALID_REQUEST" })); }
function safeS6Field(field: string): string {
  if (S6_PUBLIC_FIELDS.has(field) || /^operations(?:\[\d+\])?(?:\.(?:objectId|objectIds|deltaMm|rotationMd|dimensionsMm|geometry|material|zoneIds|requirementIds|note|unknownId|resolutionKind|resolutionNote|replacement|objectType|role|label|positionMm|parentObjectId))?(?:\[\d+\])?(?:\.(?:xMm|yMm|zMm|xMd|yMd|widthMm|depthMm|heightMm|kind|profile|radiusMm|localAnchor|vertices|winding))?$/u.test(field)) return field;
  return "body";
}
function safeS6FieldErrors(fieldErrors: readonly { field: string; code: string }[]): { field: string; code: string }[] {
  return fieldErrors.map((item) => ({ field: safeS6Field(item.field), code: S6_PUBLIC_FIELD_CODES.has(item.code) ? item.code : "INVALID_REQUEST" }));
}

function requestReferenceId(request: Request): UUID {
  const supplied = request.headers.get("x-request-id");
  return supplied && uuidV4Pattern.test(supplied) ? supplied : crypto.randomUUID();
}

function jsonError(referenceId: UUID, error: unknown, s3 = false, s4 = false, s5 = false, s6 = false): NextResponse {
  const candidate = error instanceof AppError
    ? error
    : new AppError(500, s6 ? "S6_INTERNAL_ERROR" : s5 ? "S5_INTERNAL_ERROR" : s4 ? "S4_INTERNAL_ERROR" : s3 ? "S3_INTERNAL_ERROR" : "INTERNAL_ERROR");
  const surfaceCandidate = s6 && candidate.code === "INVALID_REQUEST"
    ? new AppError(candidate.status, "S6_INVALID_REQUEST", candidate.fieldErrors, candidate.logContext)
    : candidate;
  const appError = s6 && !PUBLIC_S6_ERROR_CODES.has(surfaceCandidate.code)
    ? new AppError(500, "S6_INTERNAL_ERROR", safeS6FieldErrors(surfaceCandidate.fieldErrors))
    : s5 && !PUBLIC_S5_ERROR_CODES.has(surfaceCandidate.code)
      ? new AppError(500, "S5_INTERNAL_ERROR")
      : s4 && !PUBLIC_S4_ERROR_CODES.has(surfaceCandidate.code)
      ? new AppError(500, "S4_INTERNAL_ERROR")
        : s3 && !PUBLIC_S3_ERROR_CODES.has(surfaceCandidate.code)
        ? new AppError(500, "S3_INTERNAL_ERROR")
          : surfaceCandidate;
  const body = {
    error: {
      code: appError.code,
      message: "The request could not be completed. Try again or contact support with the reference ID.",
      referenceId,
      fieldErrors: s6 ? safeS6FieldErrors(appError.fieldErrors) : s5 ? safeS5FieldErrors(appError.fieldErrors) : s4 ? safeS4FieldErrors(appError.fieldErrors) : appError.fieldErrors,
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

function isS5Path(segments: string[]): boolean {
  return segments.length >= 3 && segments[0] === "projects" && segments[2] === "s5";
}

export function isS6Path(segments: string[]): boolean {
  return segments.length >= 3 && segments[0] === "projects" && segments[2] === "s6";
}

export type AuthorizedS6Service = {
  service: WorkflowService;
  subjectId: string;
};

export async function authorizedS6Service(
  request: Request,
  segments: string[],
  supplied: WorkflowService | ApiRequestDependencies | undefined,
): Promise<AuthorizedS6Service> {
  const projectId = segments[1];
  if (typeof projectId !== "string" || !uuidV4Pattern.test(projectId)) throw new AppError(404, "S6_UNAUTHORIZED_OR_NOT_FOUND");
  const dependencies = isApiRequestDependencies(supplied)
    ? supplied
    : { workflowService: supplied, s3Authorization: productionS3Authorization };
  let context: S3AccessContext | null;
  try {
    context = await dependencies.s3Authorization.resolveContext(request);
  } catch {
    throw new AppError(404, "S6_UNAUTHORIZED_OR_NOT_FOUND");
  }
  if (!context || typeof context.subjectId !== "string" || context.subjectId.length === 0) {
    throw new AppError(404, "S6_UNAUTHORIZED_OR_NOT_FOUND");
  }
  try {
    if (!(await dependencies.s3Authorization.authorizeProject(context, projectId))) {
      throw new AppError(404, "S6_UNAUTHORIZED_OR_NOT_FOUND");
    }
  } catch (error) {
    if (error instanceof AppError && error.code === "S6_UNAUTHORIZED_OR_NOT_FOUND") throw error;
    throw new AppError(404, "S6_UNAUTHORIZED_OR_NOT_FOUND");
  }
  return {
    service: dependencies.workflowService ?? serviceForRequest(),
    subjectId: context.subjectId,
  };
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

async function authorizedS5Service(
  request: Request,
  segments: string[],
  supplied: WorkflowService | ApiRequestDependencies | undefined,
): Promise<WorkflowService> {
  const projectId = segments[1];
  if (typeof projectId !== "string" || !uuidV4Pattern.test(projectId)) throw new AppError(404, "PROJECT_NOT_FOUND");
  const dependencies = isApiRequestDependencies(supplied)
    ? supplied
    : { workflowService: supplied, s3Authorization: productionS3Authorization };
  let context: S3AccessContext | null;
  try { context = await dependencies.s3Authorization.resolveContext(request); } catch { throw new AppError(404, "PROJECT_NOT_FOUND"); }
  if (!context || typeof context.subjectId !== "string" || context.subjectId.length === 0) throw new AppError(404, "PROJECT_NOT_FOUND");
  try {
    if (!(await dependencies.s3Authorization.authorizeProject(context, projectId))) throw new AppError(404, "PROJECT_NOT_FOUND");
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

const S5_FENCE_KEYS = ["expectedGenerationSetId", "expectedSelectionStateId", "expectedSelectionVersion", "expectedActiveRevisionId", "expectedApprovalEventId", "expectedApprovalGeneration", "expectedApprovalEventSequence"] as const;

function s5Fence(body: Record<string, unknown>, includeReason = false): S5MutationFence {
  exactKeys(body, includeReason ? [...S5_FENCE_KEYS, "reopenReason"] : S5_FENCE_KEYS);
  assertUuid(body.expectedGenerationSetId, "expectedGenerationSetId"); assertUuid(body.expectedSelectionStateId, "expectedSelectionStateId"); assertUuid(body.expectedActiveRevisionId, "expectedActiveRevisionId");
  if (body.expectedApprovalEventId !== null) assertUuid(body.expectedApprovalEventId, "expectedApprovalEventId");
  for (const key of ["expectedSelectionVersion", "expectedApprovalGeneration", "expectedApprovalEventSequence"] as const) if (!Number.isSafeInteger(body[key]) || (body[key] as number) < 0) throw new AppError(400, "INVALID_REQUEST", [{ field: key, code: "INVALID_VALUE" }]);
  if ((body.expectedSelectionVersion as number) < 1) throw new AppError(400, "INVALID_REQUEST", [{ field: "expectedSelectionVersion", code: "INVALID_VALUE" }]);
  return { expectedGenerationSetId: body.expectedGenerationSetId as UUID, expectedSelectionStateId: body.expectedSelectionStateId as UUID, expectedSelectionVersion: body.expectedSelectionVersion as number, expectedActiveRevisionId: body.expectedActiveRevisionId as UUID, expectedApprovalEventId: body.expectedApprovalEventId as UUID | null, expectedApprovalGeneration: body.expectedApprovalGeneration as number, expectedApprovalEventSequence: body.expectedApprovalEventSequence as number };
}

function s5JsonResponse(result: { replayed?: boolean; artifacts?: Array<{ status: string }> }): number {
  return result.replayed || result.artifacts?.every((item) => item.status === "committed") ? 200 : 202;
}

function s5DownloadResponse(result: { bytes: Buffer; contentType: string; fileName: string }): NextResponse {
  return new NextResponse(new Uint8Array(result.bytes), { status: 200, headers: { "content-type": result.contentType, "content-disposition": `attachment; filename="${result.fileName}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-length": String(result.bytes.byteLength) } });
}

const S6_TOKEN_KEYS = [
  "expectedRevisionId",
  "expectedRevisionHash",
  "expectedParentRevisionId",
  "expectedParentHash",
  "expectedCurrentAcceptedRevisionId",
  "expectedCurrentAcceptedHash",
  "expectedSourceFingerprint",
] as const;
const S6_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const S6_VIEW_ID_SET = new Set<S6ViewId>(["perspective-northwest", "perspective-southeast", "top-orthographic"]);
const S6_PRIMITIVE_SET = new Set(["counter", "display_plinth", "screen", "storage_volume", "table", "seating_marker", "equipment_placeholder", "box", "overhead_volume", "partition"]);
const S6_ROLE_SET = new Set(["furniture", "display", "screen", "storage", "seating", "equipment", "overhead", "booth_partition"]);
const S6_FINISH_SET = new Set(["solid_color", "wood_like", "metal_like", "fabric_like", "glass_like", "brand_reference", "unknown"]);
const S6_SOURCE_SET = new Set(["confirmed_project_input", "user_confirmed_design_decision", "s5_visual_intent", "bounded_design_inference", "unknown"]);

function s6Record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AppError(400, "S6_INVALID_REQUEST", [{ field, code: "INVALID_VALUE" }]);
  return value as Record<string, unknown>;
}

function s6Integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0)) throw new AppError(400, "S6_INVALID_REQUEST", [{ field, code: "INTEGER_REQUIRED" }]);
  return value;
}

function s6String(value: unknown, field: string, maximum = 240): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new AppError(400, "S6_INVALID_REQUEST", [{ field, code: "INVALID_VALUE" }]);
  return value;
}

function s6Hash(value: unknown, field: string): string {
  if (typeof value !== "string" || !S6_SHA256_PATTERN.test(value)) throw new AppError(400, "S6_INVALID_REQUEST", [{ field, code: "INVALID_VALUE" }]);
  return value;
}

function s6StringArray(value: unknown, field: string, maximum = 256): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new AppError(400, "S6_INVALID_REQUEST", [{ field, code: "INVALID_VALUE" }]);
  return value.map((item, index) => s6String(item, field + "[" + String(index) + "]"));
}

function s6Vector(value: unknown, field: string): { xMm: number; yMm: number; zMm: number } {
  const record = s6Record(value, field);
  exactKeys(record, ["xMm", "yMm", "zMm"]);
  return { xMm: s6Integer(record.xMm, field + ".xMm"), yMm: s6Integer(record.yMm, field + ".yMm"), zMm: s6Integer(record.zMm, field + ".zMm") };
}

function s6Rotation(value: unknown, field: string): { xMd: number; yMd: number; zMd: number } {
  const record = s6Record(value, field);
  exactKeys(record, ["xMd", "yMd", "zMd"]);
  return { xMd: s6Integer(record.xMd, field + ".xMd"), yMd: s6Integer(record.yMd, field + ".yMd"), zMd: s6Integer(record.zMd, field + ".zMd") };
}

function s6Dimensions(value: unknown, field: string): { widthMm: number; depthMm: number; heightMm: number } {
  const record = s6Record(value, field);
  exactKeys(record, ["widthMm", "depthMm", "heightMm"]);
  return { widthMm: s6Integer(record.widthMm, field + ".widthMm"), depthMm: s6Integer(record.depthMm, field + ".depthMm"), heightMm: s6Integer(record.heightMm, field + ".heightMm") };
}

function s6Profile(value: unknown, field: string): { winding: "ccw-from-positive-y-v1"; vertices: Array<{ xMm: number; zMm: number }> } {
  const record = s6Record(value, field);
  exactKeys(record, ["winding", "vertices"]);
  if (record.winding !== "ccw-from-positive-y-v1" || !Array.isArray(record.vertices) || record.vertices.length > 24) throw new AppError(400, "S6_INVALID_REQUEST", [{ field, code: "INVALID_VALUE" }]);
  return {
    winding: "ccw-from-positive-y-v1",
    vertices: record.vertices.map((value, index) => {
      const vertex = s6Record(value, field + ".vertices[" + String(index) + "]");
      exactKeys(vertex, ["xMm", "zMm"]);
      return { xMm: s6Integer(vertex.xMm, field + ".vertices[" + String(index) + "].xMm"), zMm: s6Integer(vertex.zMm, field + ".vertices[" + String(index) + "].zMm") };
    }),
  };
}

function s6Geometry(value: unknown, field: string): unknown {
  const record = s6Record(value, field);
  if (record.kind === "rect_prism") {
    exactKeys(record, ["kind", "dimensionsMm", "localAnchor"]);
    if (record.localAnchor !== "floor" && record.localAnchor !== "center") throw new AppError(400, "S6_INVALID_REQUEST", [{ field, code: "INVALID_VALUE" }]);
    return { kind: "rect_prism", dimensionsMm: s6Dimensions(record.dimensionsMm, field + ".dimensionsMm"), localAnchor: record.localAnchor };
  }
  if (record.kind === "round_prism") {
    exactKeys(record, ["kind", "radiusMm", "heightMm", "localAnchor"]);
    if (record.localAnchor !== "floor" && record.localAnchor !== "center") throw new AppError(400, "S6_INVALID_REQUEST", [{ field, code: "INVALID_VALUE" }]);
    return { kind: "round_prism", radiusMm: s6Integer(record.radiusMm, field + ".radiusMm"), heightMm: s6Integer(record.heightMm, field + ".heightMm"), localAnchor: record.localAnchor };
  }
  if (record.kind === "profile_extrusion") {
    exactKeys(record, ["kind", "profile", "heightMm", "localAnchor"]);
    if (record.localAnchor !== "floor" && record.localAnchor !== "center") throw new AppError(400, "S6_INVALID_REQUEST", [{ field, code: "INVALID_VALUE" }]);
    return { kind: "profile_extrusion", profile: s6Profile(record.profile, field + ".profile"), heightMm: s6Integer(record.heightMm, field + ".heightMm"), localAnchor: record.localAnchor };
  }
  throw new AppError(400, "S6_INVALID_REQUEST", [{ field, code: "INVALID_VALUE" }]);
}

function s6Provenance(value: unknown, field: string): unknown {
  const record = s6Record(value, field);
  exactKeys(record, ["kind", "sourceRef", "sourceFingerprint", "acceptedByUser", "note"]);
  if (!["confirmed_project_input", "user_confirmed_design_decision", "bounded_design_inference", "unknown_unresolved"].includes(String(record.kind)) ||
      typeof record.sourceRef !== "string" || typeof record.acceptedByUser !== "boolean" ||
      (record.sourceFingerprint !== null && !S6_SHA256_PATTERN.test(String(record.sourceFingerprint))) ||
      (record.note !== null && typeof record.note !== "string")) {
    throw new AppError(400, "S6_INVALID_REQUEST", [{ field, code: "INVALID_VALUE" }]);
  }
  return record;
}

function s6Material(value: unknown, field: string): unknown {
  const record = s6Record(value, field);
  exactKeys(record, ["materialId", "label", "finishKind", "colorHex", "source", "sourceAssetId", "sourceAssetSha256", "notes", "provenance"]);
  s6String(record.materialId, field + ".materialId");
  s6String(record.label, field + ".label");
  if (!S6_FINISH_SET.has(String(record.finishKind))) throw new AppError(400, "S6_INVALID_REQUEST", [{ field, code: "INVALID_VALUE" }]);
  if (record.colorHex !== null && (typeof record.colorHex !== "string" || !/^#[0-9a-f]{6}$/iu.test(record.colorHex))) throw new AppError(400, "S6_INVALID_REQUEST", [{ field: field + ".colorHex", code: "INVALID_VALUE" }]);
  if (!S6_SOURCE_SET.has(String(record.source))) throw new AppError(400, "S6_INVALID_REQUEST", [{ field, code: "INVALID_VALUE" }]);
  if (record.sourceAssetId !== null) assertUuid(record.sourceAssetId, field + ".sourceAssetId");
  if (record.sourceAssetSha256 !== null) s6Hash(record.sourceAssetSha256, field + ".sourceAssetSha256");
  if (record.notes !== null && typeof record.notes !== "string") throw new AppError(400, "S6_INVALID_REQUEST", [{ field: field + ".notes", code: "INVALID_VALUE" }]);
  s6Provenance(record.provenance, field + ".provenance");
  return record;
}

function s6Replacement(value: unknown, field: string): unknown {
  const record = s6Record(value, field);
  exactKeys(record, ["objectType", "role", "label", "geometry", "positionMm", "rotationMd", "material"]);
  if (!S6_PRIMITIVE_SET.has(String(record.objectType)) || !S6_ROLE_SET.has(String(record.role))) throw new AppError(400, "S6_INVALID_REQUEST", [{ field, code: "INVALID_VALUE" }]);
  s6String(record.label, field + ".label");
  s6Geometry(record.geometry, field + ".geometry");
  s6Vector(record.positionMm, field + ".positionMm");
  s6Rotation(record.rotationMd, field + ".rotationMd");
  s6Material(record.material, field + ".material");
  return record;
}

function s6Operation(value: unknown, index: number): S6CorrectionOperation {
  const field = "operations[" + String(index) + "]";
  const record = s6Record(value, field);
  const kind = record.kind;
  if (typeof kind !== "string") throw new AppError(400, "S6_INVALID_REQUEST", [{ field, code: "INVALID_VALUE" }]);
  if (kind === "move") {
    exactKeys(record, ["kind", "objectId", "deltaMm"]);
    return { kind, objectId: s6String(record.objectId, field + ".objectId"), deltaMm: s6Vector(record.deltaMm, field + ".deltaMm") };
  }
  if (kind === "rotate") {
    exactKeys(record, ["kind", "objectId", "rotationMd"]);
    return { kind, objectId: s6String(record.objectId, field + ".objectId"), rotationMd: s6Rotation(record.rotationMd, field + ".rotationMd") };
  }
  if (kind === "resize") {
    exactKeys(record, ["kind", "objectId", "dimensionsMm"]);
    return { kind, objectId: s6String(record.objectId, field + ".objectId"), dimensionsMm: s6Dimensions(record.dimensionsMm, field + ".dimensionsMm") };
  }
  if (kind === "replace_geometry") {
    exactKeys(record, ["kind", "objectId", "geometry"]);
    return { kind, objectId: s6String(record.objectId, field + ".objectId"), geometry: s6Geometry(record.geometry, field + ".geometry") as any };
  }
  if (kind === "material") {
    exactKeys(record, ["kind", "objectId", "material"]);
    return { kind, objectId: s6String(record.objectId, field + ".objectId"), material: s6Material(record.material, field + ".material") as any };
  }
  if (kind === "zone_requirement_map") {
    exactKeys(record, ["kind", "objectId", "zoneIds", "requirementIds"]);
    return { kind, objectId: s6String(record.objectId, field + ".objectId"), zoneIds: s6StringArray(record.zoneIds, field + ".zoneIds"), requirementIds: s6StringArray(record.requirementIds, field + ".requirementIds") };
  }
  if (kind === "confirm_design_inference") {
    exactKeys(record, ["kind", "objectIds", "note"]);
    return { kind, objectIds: s6StringArray(record.objectIds, field + ".objectIds", 32), note: s6String(record.note, field + ".note", 1000) };
  }
  if (kind === "resolve_unknown") {
    exactKeys(record, ["kind", "unknownId", "resolutionKind", "resolutionNote", "replacement"]);
    if (record.resolutionKind !== "represented" && record.resolutionKind !== "explicit_simplification") throw new AppError(400, "S6_INVALID_REQUEST", [{ field, code: "INVALID_VALUE" }]);
    return { kind, unknownId: s6String(record.unknownId, field + ".unknownId"), resolutionKind: record.resolutionKind, resolutionNote: s6String(record.resolutionNote, field + ".resolutionNote", 1000), replacement: record.replacement === null ? null : s6Replacement(record.replacement, field + ".replacement") as any };
  }
  if (kind === "add") {
    exactKeys(record, ["kind", "objectType", "role", "label", "geometry", "positionMm", "rotationMd", "material", "parentObjectId", "zoneIds", "requirementIds"]);
    if (!S6_PRIMITIVE_SET.has(String(record.objectType)) || !S6_ROLE_SET.has(String(record.role))) throw new AppError(400, "S6_INVALID_REQUEST", [{ field, code: "INVALID_VALUE" }]);
    if (record.parentObjectId !== null) s6String(record.parentObjectId, field + ".parentObjectId");
    return {
      kind,
      objectType: record.objectType as any,
      role: record.role as any,
      label: s6String(record.label, field + ".label"),
      geometry: s6Geometry(record.geometry, field + ".geometry") as any,
      positionMm: s6Vector(record.positionMm, field + ".positionMm"),
      rotationMd: s6Rotation(record.rotationMd, field + ".rotationMd"),
      material: s6Material(record.material, field + ".material") as any,
      parentObjectId: record.parentObjectId as string | null,
      zoneIds: s6StringArray(record.zoneIds, field + ".zoneIds"),
      requirementIds: s6StringArray(record.requirementIds, field + ".requirementIds"),
    };
  }
  if (kind === "remove") {
    exactKeys(record, ["kind", "objectId"]);
    return { kind, objectId: s6String(record.objectId, field + ".objectId") };
  }
  throw new AppError(400, "S6_INVALID_REQUEST", [{ field, code: "INVALID_VALUE" }]);
}

function s6Token(body: Record<string, unknown>, withOperations = false): S6ConcurrencyToken {
  exactKeys(body, withOperations ? [...S6_TOKEN_KEYS, "operations"] : S6_TOKEN_KEYS);
  assertUuid(body.expectedRevisionId, "expectedRevisionId");
  s6Hash(body.expectedRevisionHash, "expectedRevisionHash");
  if (body.expectedParentRevisionId !== null) assertUuid(body.expectedParentRevisionId, "expectedParentRevisionId");
  if (body.expectedParentHash !== null) s6Hash(body.expectedParentHash, "expectedParentHash");
  if ((body.expectedParentRevisionId === null) !== (body.expectedParentHash === null)) throw new AppError(400, "S6_INVALID_REQUEST", [{ field: "expectedParentRevisionId", code: "INVALID_VALUE" }]);
  if (body.expectedCurrentAcceptedRevisionId !== null) assertUuid(body.expectedCurrentAcceptedRevisionId, "expectedCurrentAcceptedRevisionId");
  if (body.expectedCurrentAcceptedHash !== null) s6Hash(body.expectedCurrentAcceptedHash, "expectedCurrentAcceptedHash");
  if ((body.expectedCurrentAcceptedRevisionId === null) !== (body.expectedCurrentAcceptedHash === null)) throw new AppError(400, "S6_INVALID_REQUEST", [{ field: "expectedCurrentAcceptedRevisionId", code: "INVALID_VALUE" }]);
  return {
    expectedRevisionId: body.expectedRevisionId as UUID,
    expectedRevisionHash: body.expectedRevisionHash as any,
    expectedParentRevisionId: body.expectedParentRevisionId as UUID | null,
    expectedParentHash: body.expectedParentHash as any,
    expectedCurrentAcceptedRevisionId: body.expectedCurrentAcceptedRevisionId as UUID | null,
    expectedCurrentAcceptedHash: body.expectedCurrentAcceptedHash as any,
    expectedSourceFingerprint: s6Hash(body.expectedSourceFingerprint, "expectedSourceFingerprint") as any,
  };
}

async function s6JsonBody(request: Request): Promise<Record<string, unknown>> {
  return s4JsonBody(request);
}

function s6ViewId(value: string): S6ViewId {
  if (!S6_VIEW_ID_SET.has(value as S6ViewId)) throw new AppError(400, "S6_INVALID_REQUEST", [{ field: "viewId", code: "INVALID_VALUE" }]);
  return value as S6ViewId;
}

function s6MutationStatus(result: { replayed?: boolean }): number {
  return result.replayed ? 200 : 202;
}

export async function handleS6(
  request: Request,
  method: string,
  segments: string[],
  service: WorkflowService,
  subjectId: string,
  referenceId: UUID,
): Promise<NextResponse> {
  const projectId = segments[1] as UUID;
  if (segments.length === 3) {
    if (method !== "GET") throw new AppError(405, "METHOD_NOT_ALLOWED");
    await requireEmptyBody(request);
    return NextResponse.json(service.s6.getState(projectId), { status: 200 });
  }
  if (segments.length === 4 && segments[3] === "generation") {
    if (method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED");
    const body = await s6JsonBody(request);
    exactKeys(body, []);
    const result = await service.s6.generate(projectId, s2IdempotencyKeyFromHeader(request), referenceId, subjectId);
    return NextResponse.json(result, { status: s6MutationStatus(result) });
  }
  if (segments.length === 5 && segments[3] === "revisions") {
    assertUuid(segments[4], "revisionId");
    if (method !== "GET") throw new AppError(405, "METHOD_NOT_ALLOWED");
    await requireEmptyBody(request);
    return NextResponse.json(service.s6.getRevision(projectId, segments[4]), { status: 200 });
  }
  if (segments.length === 6 && segments[3] === "revisions") {
    assertUuid(segments[4], "revisionId");
    const revisionId = segments[4] as UUID;
    if (segments[5] === "reopen") {
      if (method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED");
      const token = s6Token(await s6JsonBody(request));
      const result = await service.s6.reopen(projectId, revisionId, token, s2IdempotencyKeyFromHeader(request), referenceId, subjectId);
      return NextResponse.json(result, { status: s6MutationStatus(result) });
    }
    if (segments[5] === "corrections") {
      if (method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED");
      const body = await s6JsonBody(request);
      exactKeys(body, [...S6_TOKEN_KEYS, "operations"]);
      if (!Array.isArray(body.operations) || body.operations.length > 32) throw new AppError(400, "S6_INVALID_REQUEST", [{ field: "operations", code: "INVALID_VALUE" }]);
      const token = s6Token(body, true);
      const operations = body.operations.map((value, index) => s6Operation(value, index));
      const result = await service.s6.correct(projectId, revisionId, token, operations, s2IdempotencyKeyFromHeader(request), referenceId, subjectId);
      return NextResponse.json(result, { status: s6MutationStatus(result) });
    }
    if (segments[5] === "validate") {
      if (method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED");
      const token = s6Token(await s6JsonBody(request));
      return NextResponse.json(await service.s6.validate(projectId, revisionId, token, s2IdempotencyKeyFromHeader(request), referenceId), { status: 200 });
    }
    if (segments[5] === "accept") {
      if (method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED");
      const token = s6Token(await s6JsonBody(request));
      return NextResponse.json(await service.s6.accept(projectId, revisionId, token, s2IdempotencyKeyFromHeader(request), referenceId, subjectId), { status: 200 });
    }
    if (segments[5] === "render") {
      if (method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED");
      const token = s6Token(await s6JsonBody(request));
      const result = await service.s6.render(projectId, revisionId, token, s2IdempotencyKeyFromHeader(request), referenceId);
      return NextResponse.json(result, { status: s6MutationStatus(result) });
    }
  }
  if (segments.length === 7 && segments[3] === "revisions" && segments[5] === "views") {
    assertUuid(segments[4], "revisionId");
    const viewId = s6ViewId(segments[6]);
    if (method !== "GET") throw new AppError(405, "METHOD_NOT_ALLOWED");
    await requireEmptyBody(request);
    return NextResponse.json(service.s6.getView(projectId, segments[4], viewId), { status: 200 });
  }
  if (segments.length === 8 && segments[3] === "revisions" && segments[5] === "views") {
    assertUuid(segments[4], "revisionId");
    const viewId = s6ViewId(segments[6]);
    if (segments[7] === "publish") {
      if (method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED");
      const token = s6Token(await s6JsonBody(request));
      return NextResponse.json(await service.s6.publish(projectId, segments[4], viewId, token, s2IdempotencyKeyFromHeader(request), referenceId), { status: 200 });
    }
    if (segments[7] === "download") {
      if (method !== "GET") throw new AppError(405, "METHOD_NOT_ALLOWED");
      await requireEmptyBody(request);
      return s5DownloadResponse(service.s6.getViewDownload(projectId, segments[4], viewId));
    }
  }
  if (segments.length === 4 && segments[3] === "telemetry") {
    if (method !== "GET") throw new AppError(405, "METHOD_NOT_ALLOWED");
    await requireEmptyBody(request);
    return NextResponse.json(service.s6.getTelemetry(projectId), { status: 200 });
  }
  if (segments.length === 4 && segments[3] === "handoff") {
    if (method !== "GET") throw new AppError(405, "METHOD_NOT_ALLOWED");
    await requireEmptyBody(request);
    return NextResponse.json(service.s6.getS7Handoff(projectId), { status: 200 });
  }
  throw new AppError(400, "S6_INVALID_REQUEST");
}

async function handleS5(
  request: Request,
  method: string,
  segments: string[],
  service: WorkflowService,
  referenceId: UUID,
): Promise<NextResponse> {
  const projectId = segments[1] as UUID;
  if (segments.length === 3) {
    if (method !== "GET") throw new AppError(405, "METHOD_NOT_ALLOWED"); await requireEmptyBody(request);
    return NextResponse.json({ ...service.s5.getState(projectId), fence: service.s5.getFence(projectId) }, { status: 200 });
  }
  if (segments.length === 4 && segments[3] === "approval") {
    if (method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED"); const result = service.s5.approve(projectId, s5Fence(await s4JsonBody(request)), s2IdempotencyKeyFromHeader(request), referenceId); return NextResponse.json(result, { status: 200 });
  }
  if (segments.length === 4 && segments[3] === "reopen") {
    if (method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED"); const body = await s4JsonBody(request); const fence = s5Fence(body, true); const reason = body.reopenReason; if (reason !== "user_requested" && reason !== "upstream_change_detected" && reason !== "artifact_invalidated") throw new AppError(400, "INVALID_REQUEST", [{ field: "reopenReason", code: "INVALID_VALUE" }]); const result = service.s5.reopen(projectId, fence, s2IdempotencyKeyFromHeader(request), referenceId, reason); return NextResponse.json(result, { status: 200 });
  }
  if (segments.length === 4 && segments[3] === "hero") {
    if (method !== "GET") throw new AppError(405, "METHOD_NOT_ALLOWED"); await requireEmptyBody(request); return NextResponse.json(service.s5.getHeroStatus(projectId), { status: 200 });
  }
  if (segments.length === 5 && segments[3] === "hero" && segments[4] === "download") {
    if (method !== "GET") throw new AppError(405, "METHOD_NOT_ALLOWED"); await requireEmptyBody(request); return s5DownloadResponse(service.s5.getHeroDownload(projectId));
  }
  if (segments.length === 4 && segments[3] === "layout") {
    if (method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED"); const result = service.s5.generateLayout(projectId, s5Fence(await s4JsonBody(request)), s2IdempotencyKeyFromHeader(request), referenceId); const { planHash: _planHash, ...response } = result; return NextResponse.json(response, { status: s5JsonResponse(result) });
  }
  if (segments.length === 5 && segments[3] === "layout") {
    assertUuid(segments[4], "layoutGroupId"); if (method !== "GET") throw new AppError(405, "METHOD_NOT_ALLOWED"); await requireEmptyBody(request); return NextResponse.json(service.s5.getLayout(projectId, segments[4]), { status: 200 });
  }
  if (segments.length === 6 && segments[3] === "layout" && segments[5] === "retry") {
    assertUuid(segments[4], "layoutGroupId"); if (method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED"); const result = service.s5.retryLayout(projectId, segments[4], s5Fence(await s4JsonBody(request)), s2IdempotencyKeyFromHeader(request), referenceId); return NextResponse.json(result, { status: s5JsonResponse(result) });
  }
  if (segments.length === 4 && segments[3] === "presentation") {
    if (method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED"); const result = await service.s5.generatePresentation(projectId, s5Fence(await s4JsonBody(request)), s2IdempotencyKeyFromHeader(request), referenceId); return NextResponse.json(result, { status: s5JsonResponse(result) });
  }
  if (segments.length === 5 && segments[3] === "presentation") {
    assertUuid(segments[4], "artifactId"); if (method !== "GET") throw new AppError(405, "METHOD_NOT_ALLOWED"); await requireEmptyBody(request); return NextResponse.json(service.s5.getPresentation(projectId, segments[4]), { status: 200 });
  }
  if (segments.length === 6 && segments[3] === "presentation" && segments[5] === "retry") {
    assertUuid(segments[4], "artifactId"); if (method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED"); const result = await service.s5.retryPresentation(projectId, segments[4], s5Fence(await s4JsonBody(request)), s2IdempotencyKeyFromHeader(request), referenceId); return NextResponse.json(result, { status: s5JsonResponse(result) });
  }
  if (segments.length === 6 && segments[3] === "presentation" && segments[5] === "download") {
    assertUuid(segments[4], "artifactId"); if (method !== "GET") throw new AppError(405, "METHOD_NOT_ALLOWED"); await requireEmptyBody(request); return s5DownloadResponse(service.s5.getPresentationDownload(projectId, segments[4]));
  }
  if (segments.length === 4 && segments[3] === "telemetry") {
    if (method !== "GET") throw new AppError(405, "METHOD_NOT_ALLOWED"); await requireEmptyBody(request); return NextResponse.json(service.s5.getTelemetry(projectId), { status: 200 });
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
    if (isS6Path(path)) {
      const authorized = await authorizedS6Service(request, path, supplied);
      return await handleS6(request, request.method.toUpperCase(), path, authorized.service, authorized.subjectId, referenceId);
    }
    if (isS5Path(path)) {
      const service = await authorizedS5Service(request, path, supplied);
      return await handleS5(request, request.method.toUpperCase(), path, service, referenceId);
    }
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
    return jsonError(referenceId, error, isS3Path(path), isS4Path(path), isS5Path(path), isS6Path(path));
  }
}
