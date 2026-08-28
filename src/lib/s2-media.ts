import sharp from "sharp";
import { AppError, type S2AssetKind } from "./types";
import { sha256 } from "./utils";

export const S2_MEDIA_PROFILE = "s2-media-v1" as const;
export const S2_MAX_SOURCE_BYTES = 8_388_608;
export const S2_MAX_MULTIPART_BODY_BYTES = 9_437_184;
export const S2_MAX_REFERENCES = 6;
export const S2_MAX_LOGOS = 2;
export const S2_MAX_TOTAL_ASSETS = 8;
export const S2_MAX_DIMENSION = 4_096;
export const S2_MAX_PIXELS_PER_ASSET = 16_777_216;
export const S2_MAX_TOTAL_PIXELS = 32_000_000;
export const S2_MAX_RGBA_BYTES_PER_ASSET = 67_108_864;
export const S2_MAX_TOTAL_RGBA_BYTES = 134_217_728;
export const S2_MAX_NORMALIZED_BYTES = 16_777_216;
export const S2_MAX_PROVIDER_BYTES = 33_554_432;
export const S2_MAX_REPAIR_OUTPUT_BYTES = 16_777_216;
export const S2_MAX_REPAIR_IMAGES = 9;

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const JPEG_PREFIX = Buffer.from([0xff, 0xd8, 0xff]);
const SHARP_OPTIONS = {
  failOn: "warning" as const,
  limitInputPixels: S2_MAX_PIXELS_PER_ASSET,
  pages: 1,
  animated: false,
  autoOrient: true,
  sequentialRead: true,
};

export type S2DetectedMime = "image/png" | "image/jpeg" | "image/webp";

export type S2SharpOptions = NonNullable<Parameters<typeof sharp>[1]>;
export type S2SharpFactory = (
  input: NonNullable<Parameters<typeof sharp>[0]>,
  options: S2SharpOptions,
) => ReturnType<typeof sharp>;

const defaultS2SharpFactory: S2SharpFactory = (input, options) => sharp(input, options);

export type S2MediaInput = {
  kind: S2AssetKind;
  fileName?: string;
  mimeType: string;
  bytes: Uint8Array;
  maxInputBytes?: number;
};

export type S2NormalizedMedia = {
  originalBytes: Uint8Array;
  normalizedBytes: Buffer;
  originalSha256: string;
  normalizedSha256: string;
  detectedMime: S2DetectedMime;
  width: number;
  height: number;
  pixelCount: number;
  hasAlpha: boolean;
};

export type S2DecodedMeasure = {
  encodedBytes: number;
  width: number;
  height: number;
  pixelCount: number;
  decodedRgbaBytes: number;
  normalizedBytes?: number;
};

function mediaError(status: number, code: string, field = "file"): AppError {
  return new AppError(status, code, [{ field, code }]);
}

function extensionOf(fileName: string | undefined): string {
  if (!fileName) return "";
  const base = fileName.replace(/[\\/]+/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
}

function mimeForExtension(extension: string): S2DetectedMime | null {
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  return null;
}

function mimeForFormat(format: string | undefined): S2DetectedMime | null {
  if (format === "png") return "image/png";
  if (format === "jpg" || format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return null;
}

function scanPng(bytes: Buffer): { animated: boolean } {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw mediaError(415, "UNSUPPORTED_MEDIA_TYPE");
  }
  let offset = 8;
  let sawHeader = false;
  let sawEnd = false;
  let animated = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw mediaError(422, "MEDIA_CORRUPT");
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type) || length > bytes.length - offset - 12) {
      throw mediaError(422, "MEDIA_CORRUPT");
    }
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (type === "IHDR") {
      if (sawHeader || length !== 13 || offset !== 8) throw mediaError(422, "MEDIA_CORRUPT");
      const width = bytes.readUInt32BE(dataStart);
      const height = bytes.readUInt32BE(dataStart + 4);
      if (!width || !height) throw mediaError(422, "MEDIA_CORRUPT");
      sawHeader = true;
    }
    if (type === "acTL" || type === "fcTL" || type === "fdAT") animated = true;
    if (type === "IEND") {
      if (length !== 0 || !sawHeader) throw mediaError(422, "MEDIA_CORRUPT");
      sawEnd = true;
      offset += 12;
      break;
    }
    offset += 12 + length;
  }
  if (!sawHeader || !sawEnd || offset !== bytes.length) throw mediaError(422, "MEDIA_CORRUPT");
  if (animated) throw mediaError(422, "MEDIA_ANIMATED_NOT_ALLOWED");
  return { animated: false };
}

function scanWebp(bytes: Buffer): { animated: boolean } {
  if (bytes.length < 16 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
      bytes.subarray(8, 12).toString("ascii") !== "WEBP") {
    throw mediaError(415, "UNSUPPORTED_MEDIA_TYPE");
  }
  const declaredLength = bytes.readUInt32LE(4);
  if (declaredLength !== bytes.length - 8) throw mediaError(422, "MEDIA_CORRUPT");
  let offset = 12;
  let imageChunks = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw mediaError(422, "MEDIA_CORRUPT");
    const type = bytes.subarray(offset, offset + 4).toString("ascii");
    const length = bytes.readUInt32LE(offset + 4);
    const padded = length + (length % 2);
    if (padded > bytes.length - offset - 8) throw mediaError(422, "MEDIA_CORRUPT");
    if (type === "ANIM" || type === "ANMF") throw mediaError(422, "MEDIA_ANIMATED_NOT_ALLOWED");
    if (type === "VP8X") {
      if (length < 10) throw mediaError(422, "MEDIA_CORRUPT");
      if ((bytes[offset + 8] & 0x02) !== 0) throw mediaError(422, "MEDIA_ANIMATED_NOT_ALLOWED");
    }
    if (type === "VP8 " || type === "VP8L") {
      imageChunks += 1;
      if (imageChunks > 1) throw mediaError(422, "MEDIA_ANIMATED_NOT_ALLOWED");
    }
    offset += 8 + padded;
  }
  if (imageChunks !== 1) throw mediaError(422, "MEDIA_CORRUPT");
  return { animated: false };
}

function scanJpeg(bytes: Buffer): void {
  if (bytes.length < 4 || !bytes.subarray(0, 3).equals(JPEG_PREFIX) || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    throw mediaError(422, "MEDIA_CORRUPT");
  }
}

function detectContainer(bytes: Buffer): S2DetectedMime {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    scanPng(bytes);
    return "image/png";
  }
  if (bytes.subarray(0, 3).equals(JPEG_PREFIX)) {
    scanJpeg(bytes);
    return "image/jpeg";
  }
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" || bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    scanWebp(bytes);
    return "image/webp";
  }
  throw mediaError(415, "UNSUPPORTED_MEDIA_TYPE");
}

function enforceDeclaredIdentity(input: S2MediaInput, detected: S2DetectedMime): void {
  const declared = input.mimeType.toLowerCase();
  const declaredMatches = detected === "image/jpeg"
    ? declared === "image/jpeg" || declared === "image/jpg"
    : declared === detected;
  if (!declaredMatches) throw mediaError(422, "MEDIA_SIGNATURE_MISMATCH");
  const extension = extensionOf(input.fileName);
  const extensionMime = mimeForExtension(extension);
  if (extension && !extensionMime) throw mediaError(415, "UNSUPPORTED_MEDIA_TYPE");
  if (extensionMime && extensionMime !== detected) throw mediaError(422, "MEDIA_SIGNATURE_MISMATCH");
}

function enforceMeasure(measure: S2DecodedMeasure, options: {
  maxEncodedBytes?: number;
  maxNormalizedBytes?: number;
  field?: string;
} = {}): void {
  if (options.maxEncodedBytes !== undefined && measure.encodedBytes > options.maxEncodedBytes) {
    throw mediaError(413, "MEDIA_TOO_LARGE", options.field);
  }
  if (measure.width < 1 || measure.height < 1 || measure.width > S2_MAX_DIMENSION || measure.height > S2_MAX_DIMENSION) {
    throw mediaError(422, "MEDIA_DIMENSIONS_EXCEEDED", options.field);
  }
  if (measure.pixelCount > S2_MAX_PIXELS_PER_ASSET) throw mediaError(422, "MEDIA_PIXEL_LIMIT_EXCEEDED", options.field);
  if (measure.decodedRgbaBytes > S2_MAX_RGBA_BYTES_PER_ASSET) throw mediaError(422, "MEDIA_PIXEL_LIMIT_EXCEEDED", options.field);
  const normalizedLimit = options.maxNormalizedBytes ?? S2_MAX_NORMALIZED_BYTES;
  if (measure.normalizedBytes !== undefined && measure.normalizedBytes > normalizedLimit) {
    throw mediaError(422, "MEDIA_NORMALIZATION_FAILED", options.field);
  }
}

export function enforceS2AggregateLimits(measures: readonly S2DecodedMeasure[], field = "assets", maxMeasureCount = S2_MAX_TOTAL_ASSETS): void {
  let totalPixels = 0;
  let totalRgba = 0;
  let totalEncoded = 0;
  for (const measure of measures) {
    enforceMeasure(measure, { field });
    totalPixels += measure.pixelCount;
    totalRgba += measure.decodedRgbaBytes;
    totalEncoded += measure.encodedBytes;
  }
  if (measures.length > maxMeasureCount || totalPixels > S2_MAX_TOTAL_PIXELS ||
      totalRgba > S2_MAX_TOTAL_RGBA_BYTES || totalEncoded > S2_MAX_PROVIDER_BYTES) {
    throw mediaError(422, "MEDIA_AGGREGATE_LIMIT_EXCEEDED", field);
  }
}

export async function normalizeS2Media(
  input: S2MediaInput,
  sharpFactory: S2SharpFactory = defaultS2SharpFactory,
): Promise<S2NormalizedMedia> {
  const bytes = Buffer.from(input.bytes);
  const maxInputBytes = input.maxInputBytes ?? S2_MAX_SOURCE_BYTES;
  if (bytes.length < 1 || bytes.length > maxInputBytes) throw mediaError(413, "MEDIA_TOO_LARGE");
  const detectedMime = detectContainer(bytes);
  enforceDeclaredIdentity(input, detectedMime);
  try {
    const preflight = await sharpFactory(bytes, SHARP_OPTIONS).metadata();
    const format = mimeForFormat(preflight.format);
    if (format !== detectedMime || (preflight.pages !== undefined && preflight.pages !== 1)) {
      throw mediaError(422, preflight.pages && preflight.pages > 1 ? "MEDIA_ANIMATED_NOT_ALLOWED" : "MEDIA_CORRUPT");
    }
    if (!preflight.width || !preflight.height) throw mediaError(422, "MEDIA_CORRUPT");
    const pixelCount = preflight.width * preflight.height;
    const decodedRgbaBytes = pixelCount * 4;
    enforceMeasure({ encodedBytes: bytes.length, width: preflight.width, height: preflight.height, pixelCount, decodedRgbaBytes }, { maxEncodedBytes: maxInputBytes });
    const result = await sharpFactory(bytes, SHARP_OPTIONS)
      .toColourspace("srgb")
      .png({ force: true, palette: false, compressionLevel: 9, adaptiveFiltering: false })
      .toBuffer({ resolveWithObject: true });
    const normalized = Buffer.from(result.data);
    const normalizedScan = scanPng(normalized);
    if (normalizedScan.animated || result.info.format !== "png") throw mediaError(422, "MEDIA_NORMALIZATION_FAILED");
    const normalizedWidth = result.info.width;
    const normalizedHeight = result.info.height;
    const normalizedPixels = normalizedWidth * normalizedHeight;
    const normalizedHasAlpha = result.info.channels === 4;
    if (result.info.channels !== 3 && result.info.channels !== 4) throw mediaError(422, "MEDIA_NORMALIZATION_FAILED");
    enforceMeasure({
      encodedBytes: normalized.length,
      width: normalizedWidth,
      height: normalizedHeight,
      pixelCount: normalizedPixels,
      decodedRgbaBytes: normalizedPixels * 4,
      normalizedBytes: normalized.length,
    }, { maxNormalizedBytes: S2_MAX_NORMALIZED_BYTES });
    return {
      originalBytes: new Uint8Array(bytes),
      normalizedBytes: normalized,
      originalSha256: sha256(bytes),
      normalizedSha256: sha256(normalized),
      detectedMime,
      width: normalizedWidth,
      height: normalizedHeight,
      pixelCount: normalizedPixels,
      hasAlpha: normalizedHasAlpha,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw mediaError(422, "MEDIA_CORRUPT");
  }
}

export async function inspectCanonicalS1Png(bytes: Uint8Array): Promise<S2DecodedMeasure> {
  const value = Buffer.from(bytes);
  if (value.length < 1 || value.length > S2_MAX_PROVIDER_BYTES) throw mediaError(422, "MEDIA_TOO_LARGE", "source");
  if (detectContainer(value) !== "image/png") throw mediaError(422, "MEDIA_SIGNATURE_MISMATCH", "source");
  try {
    const preflight = await sharp(value, SHARP_OPTIONS).metadata();
    if (preflight.format !== "png" || preflight.pages !== undefined && preflight.pages !== 1 ||
        !preflight.width || !preflight.height) throw mediaError(422, "MEDIA_CORRUPT", "source");
    const measure = {
      encodedBytes: value.length,
      width: preflight.width,
      height: preflight.height,
      pixelCount: preflight.width * preflight.height,
      decodedRgbaBytes: preflight.width * preflight.height * 4,
    };
    enforceMeasure(measure, { maxEncodedBytes: S2_MAX_PROVIDER_BYTES, field: "source" });
    const decoded = await sharp(value, SHARP_OPTIONS).raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width !== measure.width || decoded.info.height !== measure.height || !decoded.info.channels || decoded.data.length !== measure.pixelCount * decoded.info.channels) {
      throw mediaError(422, "MEDIA_CORRUPT", "source");
    }
    return measure;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw mediaError(422, "MEDIA_CORRUPT", "source");
  }
}

export function s2MediaMeasure(media: Pick<S2NormalizedMedia, "originalBytes" | "normalizedBytes" | "width" | "height">): S2DecodedMeasure {
  return {
    encodedBytes: media.originalBytes.byteLength,
    width: media.width,
    height: media.height,
    pixelCount: media.width * media.height,
    decodedRgbaBytes: media.width * media.height * 4,
    normalizedBytes: media.normalizedBytes.byteLength,
  };
}

export function s2NormalizedMeasure(media: Pick<S2NormalizedMedia, "normalizedBytes" | "width" | "height">): S2DecodedMeasure {
  return {
    encodedBytes: media.normalizedBytes.byteLength,
    width: media.width,
    height: media.height,
    pixelCount: media.width * media.height,
    decodedRgbaBytes: media.width * media.height * 4,
    normalizedBytes: media.normalizedBytes.byteLength,
  };
}

export function assertS2Png(bytes: Uint8Array, maxBytes = S2_MAX_REPAIR_OUTPUT_BYTES): void {
  const value = Buffer.from(bytes);
  if (value.length < 1 || value.length > maxBytes) throw mediaError(422, "REPAIR_OUTPUT_INVALID", "image");
  try {
    const scan = scanPng(value);
    if (scan.animated) throw mediaError(422, "REPAIR_OUTPUT_INVALID", "image");
  } catch (error) {
    if (error instanceof AppError) throw new AppError(422, "REPAIR_OUTPUT_INVALID", [{ field: "image", code: error.code }]);
    throw new AppError(422, "REPAIR_OUTPUT_INVALID", [{ field: "image", code: "PNG_INVALID" }]);
  }
}

export function s2MimeForExtension(fileName: string): S2DetectedMime | null {
  return mimeForExtension(extensionOf(fileName));
}
