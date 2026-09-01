import { AppError, type Sha256, type S4MaskPrimitive } from "./types";
import { jcs, sha256, uuidV4Pattern } from "./utils";

export const S4_MASK_WIDTH = 1536 as const;
export const S4_MASK_HEIGHT = 1024 as const;
export const S4_MASK_PIXEL_COUNT = 1_572_864 as const;
export const S4_MASK_MIN_EDITABLE_PIXELS = 256 as const;
export const S4_MASK_MAX_EDITABLE_PIXELS = 1_179_648 as const;
export const S4_MASK_MIN_COMPARISON_PIXELS = 65_536 as const;
export const S4_MASK_GUARD_RADIUS_PX = 6 as const;

export type S4MaskRequest = {
  baseRevisionId: string;
  expectedSelectionVersion: number;
  primitives: S4MaskPrimitive[];
  instructionText: string;
};

export type S4MaskMaterialization = {
  primitives: S4MaskPrimitive[];
  primitiveHash: Sha256;
  raster: Buffer;
  rasterSha256: Sha256;
  providerPng: Buffer;
  providerPngSha256: Sha256;
  editablePixelCount: number;
  protectedPixelCount: number;
  comparisonPixelCount: number;
  maskIdentityHash: Sha256;
};

function invalid(code: string, field = "primitives"): never {
  throw new AppError(400, code, [{ field, code }]);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const expected = new Set(keys);
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !expected.has(key))) {
    invalid("S4_MASK_INVALID", field);
  }
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid("S4_MASK_INVALID", field);
  }
  return value;
}

function primitive(value: unknown, index: number): S4MaskPrimitive {
  const context = "primitives[" + String(index) + "]";
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("S4_MASK_INVALID", context);
  const item = value as Record<string, unknown>;
  if (item.kind === "rectangle") {
    exactKeys(item, ["kind", "xQ16", "yQ16", "widthQ16", "heightQ16"], context);
    const xQ16 = integer(item.xQ16, context + ".xQ16", 0, 65_536);
    const yQ16 = integer(item.yQ16, context + ".yQ16", 0, 65_536);
    const widthQ16 = integer(item.widthQ16, context + ".widthQ16", 1, 65_536);
    const heightQ16 = integer(item.heightQ16, context + ".heightQ16", 1, 65_536);
    if (xQ16 + widthQ16 > 65_536 || yQ16 + heightQ16 > 65_536) invalid("S4_MASK_INVALID", context);
    const left = Number((BigInt(xQ16) * BigInt(S4_MASK_WIDTH)) / 65_536n);
    const top = Number((BigInt(yQ16) * BigInt(S4_MASK_HEIGHT)) / 65_536n);
    const right = Number((BigInt(xQ16 + widthQ16) * BigInt(S4_MASK_WIDTH) + 65_535n) / 65_536n);
    const bottom = Number((BigInt(yQ16 + heightQ16) * BigInt(S4_MASK_HEIGHT) + 65_535n) / 65_536n);
    if (right <= left || bottom <= top) invalid("S4_MASK_INVALID", context);
    return { kind: "rectangle", xQ16, yQ16, widthQ16, heightQ16 };
  }
  if (item.kind === "brush") {
    exactKeys(item, ["kind", "radiusQ8", "points"], context);
    const radiusQ8 = integer(item.radiusQ8, context + ".radiusQ8", 64, 25_600);
    if (!Array.isArray(item.points) || item.points.length < 1 || item.points.length > 1_024) {
      invalid("S4_MASK_INVALID", context + ".points");
    }
    const points: Array<{ xQ16: number; yQ16: number }> = [];
    const seen = new Set<string>();
    for (let pointIndex = 0; pointIndex < item.points.length; pointIndex += 1) {
      const point = item.points[pointIndex];
      const pointContext = context + ".points[" + String(pointIndex) + "]";
      if (typeof point !== "object" || point === null || Array.isArray(point)) invalid("S4_MASK_INVALID", pointContext);
      const parsed = point as Record<string, unknown>;
      exactKeys(parsed, ["xQ16", "yQ16"], pointContext);
      const xQ16 = integer(parsed.xQ16, pointContext + ".xQ16", 0, 65_536);
      const yQ16 = integer(parsed.yQ16, pointContext + ".yQ16", 0, 65_536);
      const identity = String(xQ16) + "," + String(yQ16);
      if (seen.has(identity)) invalid("S4_MASK_INVALID", context + ".points");
      seen.add(identity);
      points.push({ xQ16, yQ16 });
    }
    return { kind: "brush", radiusQ8, points };
  }
  invalid("S4_MASK_INVALID", context + ".kind");
}

export function parseS4MaskRequest(value: unknown): S4MaskRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("S4_MASK_INVALID", "body");
  const body = value as Record<string, unknown>;
  exactKeys(body, ["baseRevisionId", "expectedSelectionVersion", "primitives", "instructionText"], "body");
  if (typeof body.baseRevisionId !== "string" || !uuidV4Pattern.test(body.baseRevisionId)) invalid("S4_MASK_INVALID", "baseRevisionId");
  const expectedSelectionVersion = integer(body.expectedSelectionVersion, "expectedSelectionVersion", 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(body.primitives) || body.primitives.length < 1 || body.primitives.length > 64) invalid("S4_MASK_INVALID", "primitives");
  const primitives = body.primitives.map((item, index) => primitive(item, index));
  if (primitives.reduce((count, item) => count + (item.kind === "brush" ? item.points.length : 0), 0) > 4_096) invalid("S4_MASK_INVALID", "primitives");
  const identities = new Set(primitives.map((item) => jcs(item)));
  if (identities.size !== primitives.length) invalid("S4_MASK_INVALID", "primitives");
  if (typeof body.instructionText !== "string") invalid("S4_INSTRUCTION_INVALID", "instructionText");
  return {
    baseRevisionId: body.baseRevisionId,
    expectedSelectionVersion,
    primitives,
    instructionText: body.instructionText,
  };
}

export function validateS4MaskPrimitives(value: unknown): S4MaskPrimitive[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) invalid("S4_MASK_INVALID", "primitives");
  const primitives = value.map((item, index) => primitive(item, index));
  if (primitives.reduce((count, item) => count + (item.kind === "brush" ? item.points.length : 0), 0) > 4_096) {
    invalid("S4_MASK_INVALID", "primitives");
  }
  if (new Set(primitives.map((item) => jcs(item))).size !== primitives.length) invalid("S4_MASK_INVALID", "primitives");
  return primitives;
}

export function primitiveIdentityHash(primitives: readonly S4MaskPrimitive[]): Sha256 {
  return sha256(Buffer.from(jcs({ schemaVersion: "s4-mask-primitives-v1", primitives }), "utf8"));
}

function floorDiv(value: bigint, divisor: bigint): bigint {
  if (value >= 0n) return value / divisor;
  return -((-value + divisor - 1n) / divisor);
}

function ceilDiv(value: bigint, divisor: bigint): bigint {
  return -floorDiv(-value, divisor);
}

function pixelQ8(q: number, extent: number): bigint {
  return (BigInt(q) * BigInt(extent) * 256n) / 65_536n;
}

function pixelRange(minQ8: bigint, maxQ8: bigint, limit: number): [number, number] {
  const start = Math.max(0, Number(ceilDiv(minQ8 - 128n, 256n)));
  const end = Math.min(limit - 1, Number(floorDiv(maxQ8 - 128n, 256n)));
  return [start, end];
}

function diskContains(cx: bigint, cy: bigint, px: bigint, py: bigint, radius: bigint): boolean {
  const dx = cx - px;
  const dy = cy - py;
  return dx * dx + dy * dy <= radius * radius;
}

function segmentContains(
  ax: bigint,
  ay: bigint,
  bx: bigint,
  by: bigint,
  px: bigint,
  py: bigint,
  radius: bigint,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const dot = wx * dx + wy * dy;
  const lengthSquared = dx * dx + dy * dy;
  if (dot <= 0n) return diskContains(ax, ay, px, py, radius);
  if (dot >= lengthSquared) return diskContains(bx, by, px, py, radius);
  const cross = wx * dy - wy * dx;
  return cross * cross <= radius * radius * lengthSquared;
}

function rectangleEdges(item: Extract<S4MaskPrimitive, { kind: "rectangle" }>): [number, number, number, number] {
  const left = Number((BigInt(item.xQ16) * BigInt(S4_MASK_WIDTH)) / 65_536n);
  const top = Number((BigInt(item.yQ16) * BigInt(S4_MASK_HEIGHT)) / 65_536n);
  const right = Number((BigInt(item.xQ16 + item.widthQ16) * BigInt(S4_MASK_WIDTH) + 65_535n) / 65_536n);
  const bottom = Number((BigInt(item.yQ16 + item.heightQ16) * BigInt(S4_MASK_HEIGHT) + 65_535n) / 65_536n);
  return [
    Math.max(0, Math.min(S4_MASK_WIDTH, left)),
    Math.max(0, Math.min(S4_MASK_HEIGHT, top)),
    Math.max(0, Math.min(S4_MASK_WIDTH, right)),
    Math.max(0, Math.min(S4_MASK_HEIGHT, bottom)),
  ];
}

export function rasterizeS4Mask(input: readonly S4MaskPrimitive[]): {
  raster: Buffer;
  editablePixelCount: number;
  protectedPixelCount: number;
  comparisonPixelCount: number;
} {
  const primitives = validateS4MaskPrimitives(input);
  const raster = Buffer.alloc(S4_MASK_PIXEL_COUNT, 0);
  const xCenters = Array.from({ length: S4_MASK_WIDTH }, (_, x) => (2n * BigInt(x) + 1n) * 128n);
  const yCenters = Array.from({ length: S4_MASK_HEIGHT }, (_, y) => (2n * BigInt(y) + 1n) * 128n);
  const mark = (x: number, y: number): void => { raster[y * S4_MASK_WIDTH + x] = 0xff; };

  for (const item of primitives) {
    if (item.kind === "rectangle") {
      const [left, top, right, bottom] = rectangleEdges(item);
      for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) mark(x, y);
      continue;
    }
    const radius = BigInt(item.radiusQ8);
    const points = item.points.map((point) => ({
      x: pixelQ8(point.xQ16, S4_MASK_WIDTH),
      y: pixelQ8(point.yQ16, S4_MASK_HEIGHT),
    }));
    const coverBox = (minX: bigint, minY: bigint, maxX: bigint, maxY: bigint, covers: (x: bigint, y: bigint) => boolean): void => {
      const [left, right] = pixelRange(minX, maxX, S4_MASK_WIDTH);
      const [top, bottom] = pixelRange(minY, maxY, S4_MASK_HEIGHT);
      if (right < left || bottom < top) return;
      for (let y = top; y <= bottom; y += 1) {
        for (let x = left; x <= right; x += 1) {
          if (covers(xCenters[x], yCenters[y])) mark(x, y);
        }
      }
    };
    for (const point of points) {
      coverBox(point.x - radius, point.y - radius, point.x + radius, point.y + radius,
        (x, y) => diskContains(point.x, point.y, x, y, radius));
    }
    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1];
      const to = points[index];
      coverBox(
        (from.x < to.x ? from.x : to.x) - radius,
        (from.y < to.y ? from.y : to.y) - radius,
        (from.x > to.x ? from.x : to.x) + radius,
        (from.y > to.y ? from.y : to.y) + radius,
        (x, y) => segmentContains(from.x, from.y, to.x, to.y, x, y, radius),
      );
    }
  }

  let editablePixelCount = 0;
  for (const value of raster) if (value === 0xff) editablePixelCount += 1;
  const protectedPixelCount = S4_MASK_PIXEL_COUNT - editablePixelCount;
  const guard = s4GuardMask(raster);
  let comparisonPixelCount = 0;
  for (let index = 0; index < raster.length; index += 1) {
    if (raster[index] === 0 && guard[index] === 0) comparisonPixelCount += 1;
  }
  return { raster, editablePixelCount, protectedPixelCount, comparisonPixelCount };
}

export function s4GuardMask(raster: Uint8Array): Uint8Array {
  if (raster.length !== S4_MASK_PIXEL_COUNT) throw new Error("invalid S4 raster length");
  const horizontal = new Uint8Array(S4_MASK_PIXEL_COUNT);
  const guard = new Uint8Array(S4_MASK_PIXEL_COUNT);
  const radius = S4_MASK_GUARD_RADIUS_PX;
  for (let y = 0; y < S4_MASK_HEIGHT; y += 1) {
    let count = 0;
    for (let x = 0; x < S4_MASK_WIDTH + radius; x += 1) {
      if (x < S4_MASK_WIDTH && raster[y * S4_MASK_WIDTH + x] === 0xff) count += 1;
      const remove = x - (2 * radius + 1);
      if (remove >= 0 && raster[y * S4_MASK_WIDTH + remove] === 0xff) count -= 1;
      const output = x - radius;
      if (output >= 0 && output < S4_MASK_WIDTH) horizontal[y * S4_MASK_WIDTH + output] = count > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < S4_MASK_WIDTH; x += 1) {
    let count = 0;
    for (let y = 0; y < S4_MASK_HEIGHT + radius; y += 1) {
      if (y < S4_MASK_HEIGHT && horizontal[y * S4_MASK_WIDTH + x] !== 0) count += 1;
      const remove = y - (2 * radius + 1);
      if (remove >= 0 && horizontal[remove * S4_MASK_WIDTH + x] !== 0) count -= 1;
      const output = y - radius;
      if (output >= 0 && output < S4_MASK_HEIGHT) guard[output * S4_MASK_WIDTH + x] = count > 0 ? 1 : 0;
    }
  }
  return guard;
}

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, value: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, Buffer.from(value)]);
  const result = Buffer.alloc(12 + value.byteLength);
  result.writeUInt32BE(value.byteLength, 0);
  body.copy(result, 4);
  result.writeUInt32BE(crc32(body), 8 + value.byteLength);
  return result;
}

function adler32(value: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of value) {
    a = (a + byte) % 65_521;
    b = (b + a) % 65_521;
  }
  return (((b << 16) | a) >>> 0);
}

function storedZlib(value: Uint8Array): Buffer {
  const blocks: Buffer[] = [Buffer.from([0x78, 0x01])];
  let offset = 0;
  while (offset < value.length) {
    const length = Math.min(65_535, value.length - offset);
    const block = Buffer.alloc(5 + length);
    block[0] = offset + length === value.length ? 0x01 : 0x00;
    block.writeUInt16LE(length, 1);
    block.writeUInt16LE((~length) & 0xffff, 3);
    Buffer.from(value.subarray(offset, offset + length)).copy(block, 5);
    blocks.push(block);
    offset += length;
  }
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(adler32(value), 0);
  blocks.push(checksum);
  return Buffer.concat(blocks);
}

export function encodeS4ProviderMaskPng(raster: Uint8Array): Buffer {
  if (raster.length !== S4_MASK_PIXEL_COUNT) throw new Error("invalid S4 raster length");
  const scanlineSize = 1 + S4_MASK_WIDTH * 4;
  const scanlines = Buffer.alloc(S4_MASK_HEIGHT * scanlineSize);
  for (let y = 0; y < S4_MASK_HEIGHT; y += 1) {
    const scanline = y * scanlineSize;
    scanlines[scanline] = 0;
    for (let x = 0; x < S4_MASK_WIDTH; x += 1) {
      const pixel = scanline + 1 + x * 4;
      const alpha = raster[y * S4_MASK_WIDTH + x] === 0xff ? 0 : 0xff;
      scanlines[pixel] = 0;
      scanlines[pixel + 1] = 0;
      scanlines[pixel + 2] = 0;
      scanlines[pixel + 3] = alpha;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S4_MASK_WIDTH, 0);
  ihdr.writeUInt32BE(S4_MASK_HEIGHT, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const png = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", storedZlib(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  if (png.byteLength > 16 * 1024 * 1024) throw new AppError(400, "S4_MASK_INVALID", [{ field: "primitives", code: "S4_MASK_INVALID" }]);
  return png;
}

export function materializeS4Mask(input: readonly S4MaskPrimitive[]): S4MaskMaterialization {
  const primitives = validateS4MaskPrimitives(input);
  const rasterized = rasterizeS4Mask(primitives);
  if (rasterized.editablePixelCount === S4_MASK_PIXEL_COUNT) invalid("S4_MASK_FULL_IMAGE", "primitives");
  if (rasterized.editablePixelCount < S4_MASK_MIN_EDITABLE_PIXELS) invalid("S4_MASK_AREA_TOO_SMALL", "primitives");
  if (rasterized.editablePixelCount > S4_MASK_MAX_EDITABLE_PIXELS) invalid("S4_MASK_AREA_TOO_LARGE", "primitives");
  if (rasterized.comparisonPixelCount < S4_MASK_MIN_COMPARISON_PIXELS) invalid("S4_MASK_COMPARISON_TOO_SMALL", "primitives");
  const primitiveHash = primitiveIdentityHash(primitives);
  const rasterSha256 = sha256(rasterized.raster);
  const providerPng = encodeS4ProviderMaskPng(rasterized.raster);
  const providerPngSha256 = sha256(providerPng);
  const maskIdentityHash = sha256(Buffer.from(jcs({
    schemaVersion: "s4-mask-raster-v1",
    width: S4_MASK_WIDTH,
    height: S4_MASK_HEIGHT,
    protectedValue: 0,
    editableValue: 255,
    layout: "row-major-top-left-one-byte-per-pixel",
    primitiveHash,
    rasterSha256,
    editablePixelCount: rasterized.editablePixelCount,
    comparisonPixelCount: rasterized.comparisonPixelCount,
  }), "utf8"));
  return {
    primitives,
    primitiveHash,
    raster: rasterized.raster,
    rasterSha256,
    providerPng,
    providerPngSha256,
    editablePixelCount: rasterized.editablePixelCount,
    protectedPixelCount: rasterized.protectedPixelCount,
    comparisonPixelCount: rasterized.comparisonPixelCount,
    maskIdentityHash,
  };
}
