import sharp from "sharp";
import type { Sha256, S4FailureCode, S4PreservationSeverity } from "./types";
import {
  S4_MASK_HEIGHT,
  S4_MASK_MIN_COMPARISON_PIXELS,
  S4_MASK_PIXEL_COUNT,
  S4_MASK_WIDTH,
  s4GuardMask,
} from "./s4-mask";
import { inspectExactS3Png } from "./s3-media";
import { jcs, sha256 } from "./utils";

export const S4_PRESERVATION_GUARD_RADIUS = 6 as const;
export const S4_PRESERVATION_RGB_TOLERANCE = 8 as const;
export const S4_PRESERVATION_ALPHA_TOLERANCE = 8 as const;

export type S4PreservationEvidence = {
  schemaVersion: "s4-preservation-evidence-v1";
  preservationCheckId: string;
  editId: string;
  sourceSha256: Sha256;
  outputSha256: Sha256;
  maskIdentityHash: Sha256;
  width: 1536;
  height: 1024;
  decoderProfile: "s4-rgba-v1";
  guardRadiusPx: 6;
  rgbChannelTolerance: 8;
  alphaTolerance: 8;
  comparisonPixelMinimum: 65_536;
  comparedPixelCount: number;
  differingPixelCount: number;
  rgbDifferingPixelCount: number;
  alphaDifferingPixelCount: number;
  maxRgbDelta: number;
  maxAlphaDelta: number;
  aggregateDelta: number;
  meanAggregateDeltaQ16: number;
  componentCount: number;
  largestComponentPixelCount: number;
  severity: S4PreservationSeverity;
  noOpDetected: boolean;
  status: "PASS" | "MATERIAL_FAIL" | "QA_UNAVAILABLE";
};

export type S4PreservationRun = {
  status: "PASS" | "MATERIAL_FAIL" | "QA_UNAVAILABLE";
  failureCode: S4FailureCode | null;
  noOpDetected: boolean;
  comparedPixelCount: number;
  differingPixelCount: number;
  rgbDifferingPixelCount: number;
  alphaDifferingPixelCount: number;
  maxRgbDelta: number;
  maxAlphaDelta: number;
  aggregateDelta: number;
  meanAggregateDeltaQ16: number;
  componentCount: number;
  largestComponentPixelCount: number;
  severity: S4PreservationSeverity;
  evidence: S4PreservationEvidence;
  evidenceBytes: Buffer;
};

export async function decodeS4Rgba(bytes: Uint8Array): Promise<Buffer> {
  const input = Buffer.from(bytes);
  const metadata = await sharp(input, {
    failOn: "warning",
    limitInputPixels: S4_MASK_PIXEL_COUNT,
    pages: 1,
    animated: false,
    autoOrient: false,
    sequentialRead: true,
  }).metadata();
  if (metadata.format !== "png" || metadata.pages !== undefined && metadata.pages !== 1 ||
      metadata.width !== S4_MASK_WIDTH || metadata.height !== S4_MASK_HEIGHT) {
    throw new Error("S4 media profile mismatch");
  }
  const decoded = await sharp(input, {
    failOn: "warning",
    limitInputPixels: S4_MASK_PIXEL_COUNT,
    pages: 1,
    animated: false,
    autoOrient: false,
    sequentialRead: true,
  }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (decoded.info.width !== S4_MASK_WIDTH || decoded.info.height !== S4_MASK_HEIGHT ||
      decoded.info.channels !== 4 || decoded.data.length !== S4_MASK_PIXEL_COUNT * 4) {
    throw new Error("S4 RGBA profile mismatch");
  }
  return decoded.data;
}

function evidenceBytes(evidence: S4PreservationEvidence): Buffer {
  return Buffer.from(jcs(evidence), "utf8");
}

function makeResult(
  values: Omit<S4PreservationRun, "evidence" | "evidenceBytes">,
  ids: { preservationCheckId: string; editId: string; sourceSha256: Sha256; outputSha256: Sha256; maskIdentityHash: Sha256 },
): S4PreservationRun {
  const evidence: S4PreservationEvidence = {
    schemaVersion: "s4-preservation-evidence-v1",
    preservationCheckId: ids.preservationCheckId,
    editId: ids.editId,
    sourceSha256: ids.sourceSha256,
    outputSha256: ids.outputSha256,
    maskIdentityHash: ids.maskIdentityHash,
    width: 1536,
    height: 1024,
    decoderProfile: "s4-rgba-v1",
    guardRadiusPx: 6,
    rgbChannelTolerance: 8,
    alphaTolerance: 8,
    comparisonPixelMinimum: 65_536,
    comparedPixelCount: values.comparedPixelCount,
    differingPixelCount: values.differingPixelCount,
    rgbDifferingPixelCount: values.rgbDifferingPixelCount,
    alphaDifferingPixelCount: values.alphaDifferingPixelCount,
    maxRgbDelta: values.maxRgbDelta,
    maxAlphaDelta: values.maxAlphaDelta,
    aggregateDelta: values.aggregateDelta,
    meanAggregateDeltaQ16: values.meanAggregateDeltaQ16,
    componentCount: values.componentCount,
    largestComponentPixelCount: values.largestComponentPixelCount,
    severity: values.severity,
    noOpDetected: values.noOpDetected,
    status: values.status,
  };
  return { ...values, evidence, evidenceBytes: evidenceBytes(evidence) };
}

function unavailable(
  failureCode: S4FailureCode,
  ids: { preservationCheckId: string; editId: string; sourceSha256: Sha256; outputSha256: Sha256; maskIdentityHash: Sha256 },
  comparedPixelCount = 0,
): S4PreservationRun {
  return makeResult({
    status: "QA_UNAVAILABLE",
    failureCode,
    noOpDetected: false,
    comparedPixelCount,
    differingPixelCount: 0,
    rgbDifferingPixelCount: 0,
    alphaDifferingPixelCount: 0,
    maxRgbDelta: 0,
    maxAlphaDelta: 0,
    aggregateDelta: 0,
    meanAggregateDeltaQ16: 0,
    componentCount: 0,
    largestComponentPixelCount: 0,
    severity: "none",
  }, ids);
}

function severityFor(
  differingPixelCount: number,
  largestComponentPixelCount: number,
  maxRgbDelta: number,
  maxAlphaDelta: number,
  aggregateDelta: number,
  meanAggregateDeltaQ16: number,
): S4PreservationSeverity {
  if (maxRgbDelta >= 128 || maxAlphaDelta >= 128 || differingPixelCount >= 4_096 || largestComponentPixelCount >= 1_024) return "catastrophic";
  if (differingPixelCount <= 8 && largestComponentPixelCount <= 4 && maxRgbDelta <= 31 &&
      maxAlphaDelta <= 31 && aggregateDelta <= 128 && meanAggregateDeltaQ16 <= 31 * 65_536) return "tiny";
  return "material";
}

export type S4PreservationInput = {
  preservationCheckId: string;
  editId: string;
  sourceBytes: Uint8Array;
  outputBytes: Uint8Array;
  sourceSha256: Sha256;
  outputSha256: Sha256;
  maskRaster: Uint8Array;
  maskIdentityHash: Sha256;
};

export async function evaluateS4Preservation(input: S4PreservationInput): Promise<S4PreservationRun> {
  const ids = {
    preservationCheckId: input.preservationCheckId,
    editId: input.editId,
    sourceSha256: input.sourceSha256,
    outputSha256: input.outputSha256,
    maskIdentityHash: input.maskIdentityHash,
  };
  if (sha256(input.sourceBytes) !== input.sourceSha256 || sha256(input.outputBytes) !== input.outputSha256) {
    return unavailable("S4_IMAGE_INPUT_INTEGRITY_MISMATCH", ids);
  }
  try {
    await inspectExactS3Png(input.sourceBytes);
    await inspectExactS3Png(input.outputBytes);
  } catch {
    return unavailable("S4_PRESERVATION_DECODE_FAILED", ids);
  }
  if (input.maskRaster.length !== S4_MASK_PIXEL_COUNT || [...input.maskRaster].some((value) => value !== 0 && value !== 0xff)) {
    return unavailable("S4_MASK_INVALID", ids);
  }
  const guard = s4GuardMask(input.maskRaster);
  let comparedPixelCount = 0;
  for (let index = 0; index < input.maskRaster.length; index += 1) {
    if (input.maskRaster[index] === 0 && guard[index] === 0) comparedPixelCount += 1;
  }
  if (comparedPixelCount < S4_MASK_MIN_COMPARISON_PIXELS) {
    return unavailable("S4_MASK_COMPARISON_TOO_SMALL", ids, comparedPixelCount);
  }
  let sourceRgba: Buffer;
  let outputRgba: Buffer;
  try {
    [sourceRgba, outputRgba] = await Promise.all([decodeS4Rgba(input.sourceBytes), decodeS4Rgba(input.outputBytes)]);
  } catch {
    return unavailable("S4_PRESERVATION_DECODE_FAILED", ids, comparedPixelCount);
  }
  const noOpDetected = sourceRgba.equals(outputRgba);
  const differing = new Uint8Array(S4_MASK_PIXEL_COUNT);
  let differingPixelCount = 0;
  let rgbDifferingPixelCount = 0;
  let alphaDifferingPixelCount = 0;
  let maxRgbDelta = 0;
  let maxAlphaDelta = 0;
  let aggregateDelta = 0;
  for (let index = 0; index < S4_MASK_PIXEL_COUNT; index += 1) {
    if (input.maskRaster[index] !== 0 || guard[index] !== 0) continue;
    const sourceOffset = index * 4;
    const rgbDelta = Math.max(
      Math.abs(outputRgba[sourceOffset] - sourceRgba[sourceOffset]),
      Math.abs(outputRgba[sourceOffset + 1] - sourceRgba[sourceOffset + 1]),
      Math.abs(outputRgba[sourceOffset + 2] - sourceRgba[sourceOffset + 2]),
    );
    const alphaDelta = Math.abs(outputRgba[sourceOffset + 3] - sourceRgba[sourceOffset + 3]);
    if (rgbDelta > maxRgbDelta) maxRgbDelta = rgbDelta;
    if (alphaDelta > maxAlphaDelta) maxAlphaDelta = alphaDelta;
    const rgbDiffers = rgbDelta > S4_PRESERVATION_RGB_TOLERANCE;
    const alphaDiffers = alphaDelta > S4_PRESERVATION_ALPHA_TOLERANCE;
    if (rgbDiffers) rgbDifferingPixelCount += 1;
    if (alphaDiffers) alphaDifferingPixelCount += 1;
    if (rgbDiffers || alphaDiffers) {
      differing[index] = 1;
      differingPixelCount += 1;
      aggregateDelta += rgbDelta + alphaDelta;
    }
  }
  let componentCount = 0;
  let largestComponentPixelCount = 0;
  const directions = [
    [-1, 0], [-1, 1], [0, 1], [1, 1],
    [1, 0], [1, -1], [0, -1], [-1, -1],
  ] as const;
  const queue: number[] = [];
  for (let y = 0; y < S4_MASK_HEIGHT; y += 1) {
    for (let x = 0; x < S4_MASK_WIDTH; x += 1) {
      const start = y * S4_MASK_WIDTH + x;
      if (differing[start] === 0) continue;
      componentCount += 1;
      differing[start] = 0;
      queue.length = 0;
      queue.push(start);
      let componentSize = 0;
      for (let head = 0; head < queue.length; head += 1) {
        const current = queue[head];
        componentSize += 1;
        const currentX = current % S4_MASK_WIDTH;
        const currentY = Math.floor(current / S4_MASK_WIDTH);
        for (const [dy, dx] of directions) {
          const nextX = currentX + dx;
          const nextY = currentY + dy;
          if (nextX < 0 || nextX >= S4_MASK_WIDTH || nextY < 0 || nextY >= S4_MASK_HEIGHT) continue;
          const next = nextY * S4_MASK_WIDTH + nextX;
          if (differing[next] === 0) continue;
          differing[next] = 0;
          queue.push(next);
        }
      }
      if (componentSize > largestComponentPixelCount) largestComponentPixelCount = componentSize;
    }
  }
  const meanAggregateDeltaQ16 = differingPixelCount === 0 ? 0 : Math.floor(aggregateDelta * 65_536 / differingPixelCount);
  const severity = differingPixelCount === 0
    ? "none"
    : severityFor(differingPixelCount, largestComponentPixelCount, maxRgbDelta, maxAlphaDelta, aggregateDelta, meanAggregateDeltaQ16);
  return makeResult({
    status: differingPixelCount === 0 ? "PASS" : "MATERIAL_FAIL",
    failureCode: null,
    noOpDetected,
    comparedPixelCount,
    differingPixelCount,
    rgbDifferingPixelCount,
    alphaDifferingPixelCount,
    maxRgbDelta,
    maxAlphaDelta,
    aggregateDelta,
    meanAggregateDeltaQ16,
    componentCount,
    largestComponentPixelCount,
    severity,
  }, ids);
}
