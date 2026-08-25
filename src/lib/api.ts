import { NextResponse } from "next/server";
import { AppError, type UUID } from "./types";
import { assertUuid, uuidV4Pattern } from "./utils";
import { MAX_BRIEF_BYTES } from "./media";
import { createWorkflowService, type WorkflowService } from "./workflow";

const MAX_MULTIPART_BODY_BYTES = MAX_BRIEF_BYTES + 1024 * 1024;

function requestReferenceId(request: Request): UUID {
  const supplied = request.headers.get("x-request-id");
  return supplied && uuidV4Pattern.test(supplied) ? supplied : crypto.randomUUID();
}

function jsonError(referenceId: UUID, error: unknown): NextResponse {
  const appError = error instanceof AppError ? error : new AppError(500, "INTERNAL_ERROR");
  const body = {
    error: {
      code: appError.code,
      message: "The request could not be completed. Try again or contact support with the reference ID.",
      referenceId,
      fieldErrors: appError.fieldErrors,
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

function keyFromHeader(request: Request, header: string): UUID {
  const key = request.headers.get(header);
  assertUuid(key, header);
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

function serviceForRequest(): WorkflowService {
  return createWorkflowService();
}

async function handle(
  request: Request,
  method: string,
  segments: string[],
  service: WorkflowService,
  referenceId: UUID,
): Promise<NextResponse> {
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
  service: WorkflowService = serviceForRequest(),
): Promise<NextResponse> {
  const referenceId = requestReferenceId(request);
  try {
    return await handle(request, request.method.toUpperCase(), path, service, referenceId);
  } catch (error) {
    return jsonError(referenceId, error);
  }
}
