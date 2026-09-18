import type { S6ToS7Handoff, S7ToS8Handoff } from "./types";
import { buildS8WriterPayload } from "./s8-fbx-payload";
import { compareS8UfbxReadback, type S8SemanticResult, type S8UfbxReadback } from "./s8-fbx-semantic";
import { S8_FBX_PROFILE, S8_SEMANTIC_VERSION } from "./s8-fbx-profile";

export type S8PreparedExport = {
  profile: typeof S8_FBX_PROFILE;
  semanticVersion: typeof S8_SEMANTIC_VERSION;
  sourceRevisionId: string;
  sourceRevisionHash: string;
  objectNames: string[];
  payloadBytes: Buffer;
  payloadSha256: string;
};

export function prepareS8Export(s6: S6ToS7Handoff, s7: S7ToS8Handoff): S8PreparedExport {
  const generated = buildS8WriterPayload(s6, s7);
  return {
    profile: S8_FBX_PROFILE,
    semanticVersion: S8_SEMANTIC_VERSION,
    sourceRevisionId: s6.acceptedRevisionId,
    sourceRevisionHash: s6.acceptedRevisionHash,
    objectNames: generated.payload.objects.map((object) => object.name),
    payloadBytes: generated.bytes,
    payloadSha256: generated.sha256,
  };
}

export function validateS8Readback(s6: S6ToS7Handoff, s7: S7ToS8Handoff, readback: S8UfbxReadback): S8SemanticResult {
  return compareS8UfbxReadback(s6, s7, readback);
}
