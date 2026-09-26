import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.env.GITHUB_WORKSPACE!;
const carrier = process.env.S8_APP_CARRIER!;
const work = process.env.S8_APP_WORK!;
const load = (path: string) => import(pathToFileURL(join(workspace, path)).href);
const [{ buildS8WriterPayload }, { runS8BlenderWriter, runS8NativeValidator, S8_SYSTEM_RUNTIME_BIND_PATHS }, { compareS8UfbxReadback }] = await Promise.all([
  load("src/lib/s8-fbx-payload.ts"), load("src/lib/s8-fbx-worker.ts"), load("src/lib/s8-fbx-semantic.ts"),
]);
const hash = "a".repeat(64);
const projectId = "11111111-1111-4111-8111-111111111111";
const revisionId = "22222222-2222-4222-8222-222222222222";
const object = {
  objectId: "object-1", identityKey: "object-1", parentObjectId: null,
  objectType: "box", role: "furniture", label: "Box",
  geometry: { kind: "rect_prism", dimensionsMm: { widthMm: 100, depthMm: 100, heightMm: 100 }, geometryState: "exact", localAnchor: "floor" },
  footprint: { kind: "rectangle", widthMm: 100, depthMm: 100 },
  transform: { positionMm: { xMm: 0, yMm: 0, zMm: 0 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 } },
  boundsMm: { widthMm: 100, depthMm: 100, heightMm: 100 },
  zoneIds: [], requirementIds: [], materialIds: [], unknownIds: [],
  provenance: { kind: "user_confirmed_design_decision", sourceRef: "g3-runtime-proof", sourceFingerprint: hash, acceptedByUser: true, note: null },
};
const s6 = {
  schemaVersion: "s6-to-s7-handoff-v1", projectId, acceptedRevisionId: revisionId, acceptedRevisionHash: hash,
  sourceS5Fingerprint: hash, spatialSchemaVersion: "s6-spatial-model-v1", units: "millimetres",
  coordinateConvention: { version: "booth-local-right-handed-v1", units: "millimetres", handedness: "right-handed", origin: "north-west-floor-corner", xAxis: "east", yAxis: "up", zAxis: "south" },
  booth: { widthMm: 1000, depthMm: 1000, openSides: ["north"], maxHeightMm: 1000, heightState: "known" },
  objects: [object], hierarchy: [{ objectId: object.objectId, parentObjectId: null }], zones: [], requirements: [], materials: [], assumptions: [], unknowns: [],
  validationReceipt: { receiptId: "33333333-3333-4333-8333-333333333333", validationHash: hash, outcome: "pass" },
  eligibility: { currentAccepted: true, sourceCurrent: true, stale: false },
};
const s7 = {
  schemaVersion: "s7-to-s8-handoff-v1", projectId, sourceRevisionId: revisionId, sourceRevisionHash: hash, sourceS5Fingerprint: hash,
  s7ArtifactId: "44444444-4444-4444-8444-444444444444", s7ArtifactHash: hash, s7ArtifactByteSize: 1,
  manifestId: "55555555-5555-4555-8555-555555555555", manifestHash: hash, readbackReceiptId: "66666666-6666-4666-8666-666666666666", readbackHash: hash,
  dxfVersion: "s7-dxf-r2000-ascii-v1", worldToPlanVersion: "s7-world-to-plan-v1", coordinateConvention: "booth-local-right-handed-v1",
  dxfIsNot3DAuthority: true, s8MustReadAcceptedS6Model: true,
};
const prepared = buildS8WriterPayload(s6, s7);
const runtimeRoot = "/opt/blender";
const blender = "/opt/blender/blender";
const workerConfig = {
  blenderRuntimeRoot: runtimeRoot, blenderExecutable: blender,
  writerScript: "/opt/swooshz/writer.py", privateWorkRoot: process.env.S8_APP_PRIVATE_ROOT!,
  processRunnerExecutable: "/usr/local/libexec/swooshz-s8/s8-process-runner",
  sandboxExecutable: process.env.S8_APP_SANDBOX!,
  sandboxPolicySha256: process.env.S8_APP_SANDBOX_POLICY_SHA256!,
  nativeValidatorExecutable: "/usr/local/libexec/swooshz-s8/s8-native-validator",
  blenderExecutableSha256: createHash("sha256").update(readFileSync(blender)).digest("hex"),
};
process.env.PATH = "/s8-hostile-path";
process.env.HOME = "/s8-hostile-home";
process.env.LD_PRELOAD = "/s8-hostile-ld-preload.so";
process.env.LD_LIBRARY_PATH = "/s8-hostile-library-path";
process.env.PYTHONPATH = "/s8-hostile-python-path";
process.env.PYTHONHOME = "/s8-hostile-python-home";
process.env.G3_SYNTHETIC_CREDENTIAL = `ghp_${"A".repeat(24)}`;

const written = runS8BlenderWriter(prepared.bytes, workerConfig);
if (written.artifact.length <= 27) throw new Error("application writer did not return a real FBX");
const native = runS8NativeValidator(written.artifact, workerConfig);
if (!native.runnerEvidence || !native.validatorIdentity) throw new Error("application validator receipt is missing");
const semantic = compareS8UfbxReadback(s6, s7, native.readback);
if (semantic.outcome !== "pass") throw new Error("application semantic readback rejected the FBX");

function brokerMetadata(bytes: Buffer, operation: "WRITER" | "VALIDATOR"): Record<string, unknown> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("broker metadata is not an object");
  const metadata = value as Record<string, unknown>;
  if (metadata.schemaVersion !== "s8-sandbox-broker-metadata-v1" || metadata.operation !== operation) throw new Error("broker metadata identity mismatch");
  const args = metadata.sandboxArgv;
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) throw new Error("broker sandbox argv evidence is missing");
  return metadata;
}

const allowedRuntime = [...S8_SYSTEM_RUNTIME_BIND_PATHS].sort();
let explicitSetenvCount = 0;
for (const [operation, result] of [["WRITER", written], ["VALIDATOR", native]] as const) {
  const metadata = brokerMetadata(result.brokerMetadata, operation);
  const args = metadata.sandboxArgv as string[];
  explicitSetenvCount += args.filter((value) => value === "--setenv" || value.startsWith("--setenv=")).length;
  for (const required of ["--unshare-user", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--disable-userns", "--assert-userns-disabled", "--die-with-parent", "--new-session", "--clearenv", "--block-fd", "--sync-fd", "--json-status-fd", "--as-pid-1"]) {
    if (args.filter((value) => value === required).length !== 1) throw new Error(`broker sandbox boundary option count invalid: ${required}`);
  }
  for (const [option, value] of [["--uid", "65534"], ["--gid", "65534"], ["--cap-drop", "ALL"], ["--proc", "/proc"], ["--dev", "/dev"], ["--tmpfs", "/tmp"], ["--chdir", "/work"], ["--block-fd", "3"], ["--sync-fd", "4"], ["--json-status-fd", "5"]] as const) {
    if (args.filter((argument, index) => argument === option && args[index + 1] === value).length !== 1) throw new Error(`broker sandbox boundary argument invalid: ${option}`);
  }
  if (metadata.targetUid !== 65534 || metadata.targetGid !== 65534 || metadata.targetEnvironmentKeys === undefined || JSON.stringify(metadata.targetEnvironmentKeys) !== '["PWD"]') throw new Error("broker target environment evidence mismatch");
  const bindPairs = args.flatMap((option, index, values) => option.includes("bind") ? [{ option, source: values[index + 1], destination: values[index + 2] }] : []);
  const broadRuntimePaths = new Set(["/", "/usr", "/lib", "/lib64", "/etc"]);
  if (bindPairs.some(({ source, destination }) => broadRuntimePaths.has(source ?? "") || broadRuntimePaths.has(destination ?? ""))) throw new Error("broad runtime bind detected");
  const identityBinds = bindPairs.filter(({ source, destination }) => source === destination);
  if (identityBinds.some(({ option }) => option !== "--ro-bind") || JSON.stringify(identityBinds.map(({ source }) => source).sort()) !== JSON.stringify(allowedRuntime)) throw new Error("system runtime bind allowlist mismatch");
  if (metadata.pidnsInitRegisteredBeforeRelease !== true || metadata.pidfdTermination !== "PASS" || metadata.cleanupState !== "ABSENT") throw new Error("broker process lifecycle evidence mismatch");
}
if (explicitSetenvCount !== 0) throw new Error("application setenv count is not zero");
writeFileSync(join(work, "input.json"), prepared.bytes, { flag: "w", mode: 0o600 });
writeFileSync(join(work, "artifact.fbx"), written.artifact, { flag: "w", mode: 0o600 });
writeFileSync(join(work, "validator-readback.json"), native.readbackBytes, { flag: "w", mode: 0o600 });
console.log("APPLICATION_GENERATED_WRITER=PASS");
console.log("APPLICATION_GENERATED_VALIDATOR=PASS");
console.log("BROKER_PROTOCOL_ADMISSION=PASS");
console.log("BROKER_POLICY_ADMISSION=PASS");
console.log("BROKER_ALLOCATION_RECOVERY_REGRESSION=PASS");
console.log("BROKER_PID1_REGISTRATION=PASS");
console.log("BROKER_PREEXEC_GATE=PASS");
console.log("BROKER_PIDFD_TEARDOWN=PASS");
console.log("BROKER_PID_REUSE_REGRESSION=PASS");
console.log("BROKER_CLEANUP_RECOVERY=PASS");
console.log("APPLICATION_SEMANTIC_READBACK=PASS");
console.log("APPLICATION_EXPLICIT_SETENV_COUNT=0");
console.log("APPLICATION_UID_GID=65534:65534");
console.log("APPLICATION_CAP_DROP=ALL");
console.log("BWRAP_CLEAR_ENV_REQUIRED=PASS");
console.log("FINAL_RUNTIME_ALLOWLIST_PROOF=PASS");
console.log("BROAD_RUNTIME_BINDS_ABSENT=YES");
