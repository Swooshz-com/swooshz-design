import { createHash } from "node:crypto";

export const S8_FBX_PROFILE = "swooshz-fbx-static-mesh-v1" as const;
export const S8_WRITER_INPUT_VERSION = "swooshz-fbx-writer-input-v1" as const;
export const S8_WRITER_RECEIPT_VERSION = "swooshz-fbx-writer-receipt-v1" as const;
export const S8_SEMANTIC_VERSION = "swooshz-fbx-semantic-v1" as const;
export const S8_FBX_HEADER_VERSION = 7400 as const;

export const S8_LIMITS = Object.freeze({
  sourceBytes: 2 * 1024 * 1024,
  payloadBytes: 256 * 1024 * 1024,
  artifactBytes: 128 * 1024 * 1024,
  receiptBytes: 1024 * 1024,
  manifestBytes: 8 * 1024 * 1024,
  readbackBytes: 8 * 1024 * 1024,
  stdoutBytes: 1024 * 1024,
  stderrBytes: 1024 * 1024,
  objects: 256,
  hierarchyDepth: 256,
  sourcePhysicalDepth: 256,
  productionNodeDepthLimit: 257,
  sourceMaterials: 128,
  profileVertices: 24,
  roundSegments: 512,
  controlPoints: 262_656,
  triangles: 524_288,
  metadataBytesPerObject: 4096,
  timeoutMs: 300_000,
  memoryBytes: 4 * 1024 * 1024 * 1024,
});

export const S8_PRECISION = Object.freeze({
  localPositionAbsoluteMm: 0.01,
  localPositionRelative: 2e-7,
  worldPositionAbsoluteMm: 0.05,
  worldPositionRelative: 1e-6,
  dimensionMm: 0.05,
  matrixElement: 5e-6,
  normalDegrees: 0.01,
  roundSagittaMm: 1,
});

export const S8_BLENDER_PIN = Object.freeze({
  version: "5.2.2 LTS",
  versionTuple: [5, 2, 2] as const,
  platform: "linux-x64-official-portable",
  archive: "blender-5.2.2-linux-x64.tar.xz",
  archiveSha256: "84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168",
  sourceTag: "v5.2.2",
  sourceCommit: "d13f752e3b9c4f8c261cda552b1021f8bcc0382c",
  buildHashPrefix: "d13f752e3b9c",
  exporterVersion: "5.15.0",
  exporterTree: "5d4a6806e33cc2c506c69ee669cbf9a8ac3cf57c",
  exporterBlobs: {
    "__init__.py": "72c5a94e31ff783ffdf8145c4da22bd602da8f91",
    "export_fbx_bin.py": "3bb9b1805d0e5293baefa0bf9335203db80d233f",
    "encode_bin.py": "f15fd9f3fa592e85a8f727b37d5745aeec51bada",
    "fbx_utils.py": "4b6c7503c0760a2038a4fb588b036dc0b413a8c6",
  },
});

export const S8_UFBX_PIN = Object.freeze({
  version: "v0.23.0",
  tagObject: "5bde536333381b3c1e421cba2e5cc258244a60fa",
  commit: "fcc5d6ba444cfd3eb80677dba5e37e493941abe5",
  tree: "f99a3b0e775053f91ea16494d7b7be5102812d32",
  license: "MIT",
});

export const S8_EXPORTER_PATCH_PIN = Object.freeze({
  identity: "s8-b3-source-rigid-exporter-v1",
  manifest: "s8-exporter-patch-manifest-v1",
  upstreamExportFbxBin: "3bb9b1805d0e5293baefa0bf9335203db80d233f",
});

export const S8_EXPORTER_SETTINGS = Object.freeze({
  check_existing: false,
  use_selection: false,
  use_visible: false,
  use_active_collection: false,
  collection: "",
  object_types: ["EMPTY", "MESH"] as const,
  global_scale: 1,
  apply_unit_scale: true,
  apply_scale_options: "FBX_SCALE_UNITS",
  axis_forward: "Y",
  axis_up: "Z",
  use_space_transform: false,
  bake_space_transform: false,
  use_mesh_modifiers: false,
  use_mesh_modifiers_render: false,
  use_subsurf: false,
  use_mesh_edges: false,
  use_triangles: false,
  mesh_smooth_type: "OFF",
  use_tspace: false,
  colors_type: "NONE",
  prioritize_active_color: false,
  use_custom_props: true,
  bake_anim: false,
  bake_anim_use_all_bones: false,
  bake_anim_use_nla_strips: false,
  bake_anim_use_all_actions: false,
  bake_anim_force_startend_keying: false,
  add_leaf_bones: false,
  path_mode: "STRIP",
  embed_textures: false,
  batch_mode: "OFF",
  use_batch_own_dir: false,
  use_metadata: false,
});

export function s8Sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function s8StableName(ordinal: number, objectId: string): string {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > 9999) throw new Error("S8_OBJECT_ORDINAL_INVALID");
  return `SWZ_${ordinal.toString().padStart(4, "0")}_${s8Sha256(objectId).slice(0, 16)}`;
}

export function s8Basis([x, y, z]: readonly [number, number, number]): [number, number, number] {
  return [x, -z, y];
}

export function s8LocalPositionTolerance(componentMm: number): number {
  return Math.max(S8_PRECISION.localPositionAbsoluteMm, Math.abs(componentMm) * S8_PRECISION.localPositionRelative);
}

export function s8WorldPositionTolerance(componentMm: number): number {
  return Math.max(S8_PRECISION.worldPositionAbsoluteMm, Math.abs(componentMm) * S8_PRECISION.worldPositionRelative);
}
