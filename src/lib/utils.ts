import { createHash, randomUUID } from "node:crypto";
import { AppError, type Sha256, type Timestamp, type UUID } from "./types";

export const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function newUuid(): UUID {
  return randomUUID();
}

export function nowUtc(): Timestamp {
  return new Date().toISOString();
}

export function sha256(value: string | Uint8Array): Sha256 {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error("JCS cannot serialize a non-finite number");
  }
  if (Object.is(value, -0)) {
    return "0";
  }
  return JSON.stringify(value);
}

/**
 * The locked contract only permits JSON data. This implementation follows
 * RFC 8785 ordering and ECMAScript JSON number/string serialization for the
 * scalar values used by brief-v1.
 */
export function jcs(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return canonicalNumber(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => jcs(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${jcs(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("JCS received an unsupported value");
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function quote(value: string): string {
  return JSON.stringify(value);
}

export function assertUuid(value: unknown, field: string): asserts value is UUID {
  if (typeof value !== "string" || !uuidV4Pattern.test(value)) {
    throw new AppError(400, "INVALID_REQUEST", [{ field, code: "UUID_REQUIRED" }]);
  }
}

export function assertInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new AppError(400, "INVALID_REQUEST", [{ field, code: "INTEGER_REQUIRED" }]);
  }
}

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function sanitizeFileName(value: string): string {
  const withoutControls = value.replace(/[\u0000-\u001f\u007f]/g, "");
  const basename = withoutControls.replace(/^.*[\\/]/, "").trim();
  const bounded = Array.from(basename).slice(0, 120).join("");
  return bounded || "brief.pdf";
}

export function privateStorageKey(...parts: string[]): string {
  const clean = parts.map((part) => {
    if (!part || part === "." || part === ".." || part.includes("/") || part.includes("\\")) {
      throw new Error("Invalid private storage segment");
    }
    return part;
  });
  return clean.join("/");
}

export function errorCodeForUnknown(error: unknown): string {
  if (error instanceof AppError) {
    return error.code;
  }
  return "INTERNAL_ERROR";
}
