import sharp from "sharp";
import { AppError, type Sha256 } from "./types";
import {
  S2_MAX_PIXELS_PER_ASSET,
  S2_MAX_REPAIR_OUTPUT_BYTES,
  enforceS2AggregateLimits,
} from "./s2-media";
import { sha256 } from "./utils";

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

export type S3ExactPng = {
  bytes: Buffer;
  sha256: Sha256;
  byteSize: number;
  width: 1536;
  height: 1024;
  pixelCount: 1_572_864;
  decodedRgbaBytes: 6_291_456;
  hasAlpha: boolean;
};

function mediaError(code: string): AppError {
  return new AppError(422, code, [{ field: "image", code }]);
}
/**
 * Validates the provider bytes without changing them. S2 broad media limits
 * are applied as a safety floor; S3 then applies its exact geometry contract.
 */
export async function inspectExactS3Png(input: Uint8Array): Promise<S3ExactPng> {
  const bytes = Buffer.from(input);
  if (bytes.length < 1 || bytes.length > S2_MAX_REPAIR_OUTPUT_BYTES) throw mediaError("MEDIA_TOO_LARGE");
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw mediaError("MEDIA_SIGNATURE_MISMATCH");
  try {
    const metadata = await sharp(bytes, {
      failOn: "warning",
      limitInputPixels: S2_MAX_PIXELS_PER_ASSET,
      pages: 1,
      animated: false,
      autoOrient: false,
      sequentialRead: true,
    }).metadata();
    if (metadata.pages !== undefined && metadata.pages !== 1) throw mediaError("MEDIA_ANIMATED_NOT_ALLOWED");
    if (metadata.format !== "png") throw mediaError("MEDIA_SIGNATURE_MISMATCH");
    if (!metadata.width || !metadata.height) throw mediaError("MEDIA_CORRUPT");
    const pixelCount = metadata.width * metadata.height;
    enforceS2AggregateLimits([{
      encodedBytes: bytes.length,
      width: metadata.width,
      height: metadata.height,
      pixelCount,
      decodedRgbaBytes: pixelCount * 4,
    }], "image", 1);
    if (metadata.width !== 1536 || metadata.height !== 1024 || pixelCount !== 1_572_864) {
      throw mediaError("S3_OUTPUT_DIMENSIONS_INVALID");
    }
    const decoded = await sharp(bytes, {
      failOn: "warning",
      limitInputPixels: S2_MAX_PIXELS_PER_ASSET,
      pages: 1,
      animated: false,
      autoOrient: false,
      sequentialRead: true,
    }).raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width !== 1536 || decoded.info.height !== 1024 ||
        (decoded.info.channels !== 3 && decoded.info.channels !== 4) ||
        decoded.data.length !== 1_572_864 * decoded.info.channels) {
      throw mediaError("MEDIA_CORRUPT");
    }
    return {
      bytes,
      sha256: sha256(bytes),
      byteSize: bytes.byteLength,
      width: 1536,
      height: 1024,
      pixelCount: 1_572_864,
      decodedRgbaBytes: 6_291_456,
      hasAlpha: decoded.info.channels === 4,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw mediaError("MEDIA_CORRUPT");
  }
}

export async function decodeS3Rgba(input: Uint8Array): Promise<Buffer> {
  try {
    return await sharp(Buffer.from(input), {
      failOn: "warning",
      limitInputPixels: S2_MAX_PIXELS_PER_ASSET,
      pages: 1,
      animated: false,
      autoOrient: false,
      sequentialRead: true,
    }).ensureAlpha().raw().toBuffer();
  } catch {
    throw mediaError("MEDIA_CORRUPT");
  }
}

export async function s3PixelsChanged(base: Uint8Array, output: Uint8Array): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([decodeS3Rgba(base), decodeS3Rgba(output)]);
    return left.length !== right.length || !left.equals(right);
  } catch {
    // The output is separately validated before this comparison. A source
    // that cannot be decoded is an integrity failure, never a reason to skip
    // the mandatory S3 assessment.
    return true;
  }
}

let fixturePromise: Promise<Buffer> | null = null;

/** Explicit local-only fixture used by MockOpenAIProvider tests. */
export async function createExactS3FixturePng(): Promise<Buffer> {
  fixturePromise ??= sharp({
    create: {
      width: 1536,
      height: 1024,
      channels: 4,
      background: { r: 43, g: 91, b: 134, alpha: 1 },
    },
  }).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
  return Buffer.from(await fixturePromise);
}
