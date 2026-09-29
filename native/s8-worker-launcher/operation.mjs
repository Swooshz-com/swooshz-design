import { randomBytes } from "node:crypto";
import { MAX_WRITER_INPUT_BYTES, MAX_VALIDATOR_INPUT_BYTES } from "../s8-worker-common/protocol.mjs";
import { S8_NATIVE_RESOURCE_POLICY_SHA256 } from "../s8-worker-common/resource-policy.mjs";
import { admissionSnapshot, runDocker } from "./host-state.mjs";
import { createArguments, inspectAndVerify, removeContainer, startContainer, workerBudget } from "./container-runtime.mjs";
import { createResponse, parseContainerResult, verifyRunnerEvidence, verifyWriterReceipt } from "./result.mjs";

export async function runNativeOperation(config, request, startupReady, closeAdmission) {
  const previous = config.ledger.get(request.body);
  if (previous) {
    if (previous.requestSha256 !== request.requestSha256) throw new Error("request-tuple-conflict");
    if (previous.state === "FAILED" && previous.signedFailureFrame) return Buffer.from(previous.signedFailureFrame, "base64url");
    throw new Error("request-reconciliation-required");
  }
  const snapshot = await admissionSnapshot(config, startupReady);
  if (snapshot.capacity.proof.state !== "OPEN") throw new Error("admission-not-open");
  if (request.body.operation === "VALIDATOR") {
    const writer = config.ledger.get({ ...request.body, operation: "WRITER" });
    if (!writer || writer.state !== "SUCCEEDED" || writer.disposalState !== "REAPED_REMOVED"
      || writer.projectId !== request.body.projectId || writer.artifactId !== request.body.artifactId
      || writer.sourceSha256 !== request.body.sourceSha256 || writer.outputSha256 !== request.body.inputSha256
      || writer.releaseHandle !== request.body.releaseHandle || writer.releaseManifestSha256 !== snapshot.release.sha256
      || writer.resourcePolicySha256 !== S8_NATIVE_RESOURCE_POLICY_SHA256) throw new Error("writer-release-binding-invalid");
  }
  if (request.body.deadlineUnixMs <= Date.now()) throw new Error("deadline-expired");
  const maximum = request.body.operation === "WRITER" ? MAX_WRITER_INPUT_BYTES : MAX_VALIDATOR_INPUT_BYTES;
  if (request.payload.length < 1 || request.payload.length > maximum) throw new Error("request-size-invalid");
  const release = snapshot.release;
  config.ledger.begin(request.body, request.requestSha256, release.sha256, S8_NATIVE_RESOURCE_POLICY_SHA256);
  let containerId = null;
  let running = null;
  let nativeStarted = false;
  let failureClass = "PERMANENT";
  let outcome = "PERMANENT_FAILURE";
  try {
    containerId = (await runDocker(config, createArguments(config, snapshot.capacity, release, request.body.operation, request.requestSha256), 30000)).trim();
    if (!/^[0-9a-f]{64}$/u.test(containerId)) throw new Error("container-create-invalid");
    config.ledger.update(request.body, { containerId, disposalState: "RUNNING" });
    running = await startContainer(config, containerId, request.payload, request.body.operation);
    await inspectAndVerify(config, containerId, release, request.body.operation, workerBudget(snapshot.capacity.proof, request.body.operation), snapshot.capacity);
    await running.release();
    nativeStarted = true;
    const captured = await running.close(Math.max(1000, request.body.deadlineUnixMs - Date.now()));
    running = null;
    if (captured.overflow || captured.code !== 0 || captured.signal !== null) throw new Error("worker-process-failed");
    const result = parseContainerResult(captured.stdout, request.body.operation);
    const runnerEvidence = verifyRunnerEvidence(result, request.body.operation, release);
    if (request.body.operation === "WRITER") verifyWriterReceipt(result, request, release);
    if (!await removeContainer(config, containerId, snapshot.capacity.proof.allocation.rootlessDockerUid)) throw new Error("container-removal-unproven");
    const releaseHandle = request.body.operation === "WRITER" ? randomBytes(32).toString("base64url") : request.body.releaseHandle;
    const response = createResponse(config, request, release, containerId, "EXIT_0", result.output, result.auxiliary, runnerEvidence, releaseHandle);
    config.ledger.update(request.body, {
      state: "SUCCEEDED", outcome: "EXIT_0", disposalState: "REAPED_REMOVED",
      responseSha256: response.responseSha256, outputSha256: response.signed.body.outputSha256,
      releaseHandle: response.signed.body.releaseHandle, failureClass: null, signedFailureFrame: null,
    });
    return response.frame;
  } catch (error) {
    let attachedProcessUnproven = Boolean(error && typeof error === "object" && error.disposalUnproven === true);
    if (running) {
      try { await running.abort(); }
      catch { attachedProcessUnproven = true; }
    }
    let removed = false;
    try { removed = await removeContainer(config, containerId, snapshot.capacity.proof.allocation.rootlessDockerUid); } catch { /* quiescence remains unproven */ }
    if (!removed || !containerId || attachedProcessUnproven) {
      closeAdmission();
      config.ledger.update(request.body, { state: "UNKNOWN", outcome: null, disposalState: containerId ? "UNKNOWN" : "NOT_STARTED", failureClass: "UNCERTAIN", signedFailureFrame: null });
      throw new Error("disposal-unproven");
    }
    const message = error instanceof Error ? error.message : "worker-failure";
    if (message.includes("drift") || message.includes("limit") || message.includes("cgroup") || message.includes("security")) closeAdmission();
    if (!nativeStarted && message === "worker-ready-timeout") {
      outcome = "TRANSIENT_INFRASTRUCTURE_FAILURE";
      failureClass = "TRANSIENT";
    }
    const response = createResponse(config, request, release, containerId, outcome);
    config.ledger.update(request.body, {
      state: "FAILED",
      outcome,
      disposalState: "REAPED_REMOVED",
      responseSha256: response.responseSha256,
      outputSha256: null,
      releaseHandle: null,
      failureClass,
      signedFailureFrame: response.frame.toString("base64url"),
    });
    return response.frame;
  }
}
