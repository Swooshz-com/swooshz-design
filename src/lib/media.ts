import { AppError } from "./types";
import { sanitizeFileName, sha256 } from "./utils";
import { structuralPdfText } from "./pdf-structure";

export const MAX_BRIEF_BYTES = 20 * 1024 * 1024;
export const MAX_BRIEF_PAGES = 20;

export type PdfUpload = {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
};

function pdfError(field: string, code: string): AppError {
  return new AppError(400, "BRIEF_UPLOAD_INVALID", [{ field, code }]);
}

/**
 * Keeps the SQAG safety invariants that apply to this slice: validate bytes,
 * require a complete PDF marker, reject encrypted input, and cap work before
 * any bytes enter private storage. No filesystem, network, or child process
 * is used while examining media.
 */
export function validatePdfUpload(input: PdfUpload): {
  originalFileName: string;
  byteSize: number;
  pageCount: number;
  sha256: string;
} {
  const originalFileName = sanitizeFileName(input.fileName);
  if (!input.fileName.trim().toLowerCase().endsWith(".pdf")) {
    throw pdfError("file", "PDF_EXTENSION_REQUIRED");
  }
  if (input.mimeType !== "application/pdf") {
    throw pdfError("file", "PDF_MIME_REQUIRED");
  }
  const bytes = Buffer.from(input.bytes);
  if (bytes.length < 1 || bytes.length > MAX_BRIEF_BYTES) {
    throw pdfError("file", "PDF_SIZE_INVALID");
  }
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw pdfError("file", "PDF_SIGNATURE_INVALID");
  }
  const tail = bytes.subarray(Math.max(0, bytes.length - 4096)).toString("latin1");
  if (!tail.includes("%%EOF")) {
    throw pdfError("file", "PDF_INCOMPLETE");
  }
  if (/\/Encrypt\b/.test(bytes.toString("latin1"))) {
    throw pdfError("file", "PDF_ENCRYPTED");
  }

  const text = bytes.toString("latin1");
  const structuralText = structuralPdfText(text);
  const hasCatalog = /\/Type\s*\/Catalog\b/.test(structuralText);
  const hasPages = /\/Type\s*\/Pages\b/.test(structuralText);
  const hasKids = /\/Kids\s*\[/.test(structuralText);
  const pageMatches = structuralText.match(/\/Type\s*\/Page(?!s)\b/g) ?? [];
  const pageCounts = Array.from(structuralText.matchAll(/\/Count\s+(\d+)/g), (match) => Number(match[1]));
  if (!hasCatalog || !hasPages || !hasKids || pageMatches.length < 1 || !pageCounts.includes(pageMatches.length)) {
    throw pdfError("file", "PDF_PAGE_TREE_INVALID");
  }
  if (pageMatches.length > MAX_BRIEF_PAGES) {
    throw pdfError("file", "PDF_PAGE_LIMIT");
  }
  return {
    originalFileName,
    byteSize: bytes.length,
    pageCount: pageMatches.length,
    sha256: sha256(bytes),
  };
}

export function validatePng(bytes: Uint8Array): void {
  const value = Buffer.from(bytes);
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  if (value.length < 33 || !value.subarray(0, 8).equals(signature)) {
    throw new AppError(502, "IMAGE_GENERATION_FAILED", [{ field: "image", code: "PNG_INVALID" }]);
  }
  let offset = 8;
  let hasIhdr = false;
  let hasIend = false;
  while (offset + 12 <= value.length) {
    const length = value.readUInt32BE(offset);
    const type = value.subarray(offset + 4, offset + 8).toString("ascii");
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > value.length) {
      throw new AppError(502, "IMAGE_GENERATION_FAILED", [{ field: "image", code: "PNG_TRUNCATED" }]);
    }
    if (type === "IHDR") {
      if (hasIhdr || length !== 13 || value.readUInt32BE(offset + 8) < 1 || value.readUInt32BE(offset + 12) < 1) {
        throw new AppError(502, "IMAGE_GENERATION_FAILED", [{ field: "image", code: "PNG_HEADER_INVALID" }]);
      }
      hasIhdr = true;
    }
    if (type === "IEND") {
      hasIend = true;
      break;
    }
    offset = chunkEnd;
  }
  if (!hasIhdr || !hasIend) {
    throw new AppError(502, "IMAGE_GENERATION_FAILED", [{ field: "image", code: "PNG_INCOMPLETE" }]);
  }
}

export function safeMediaFieldErrors(error: unknown): { field: string; code: string }[] {
  return error instanceof AppError ? error.fieldErrors : [{ field: "file", code: "MEDIA_INVALID" }];
}
