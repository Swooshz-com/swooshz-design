import { randomBytes } from "node:crypto";
import { MAX_WRITER_INPUT_BYTES, MAX_VALIDATOR_INPUT_BYTES } from "../s8-worker-common/protocol.mjs";
import { S8_NATIVE_RESOURCE_POLICY_SHA256 } from "../s8-worker-common/resource-policy.mjs";
import { admissionSnapshot, deadlineBoundDocker, deadlineRemainingMs, DockerControlPlaneUnavailable, dockerVolumeNames, runDocker } from "./host-state.mjs";
import { createArguments, inspectAndVerify, inspectCreatedContainer, removeContainer, startContainer, workerBudget } from "./container-runtime.mjs";
import { createResponse, parseContainerResult, verifyRunnerEvidence, verifyWriterReceipt } from "./result.mjs";

export function createResponseBeforeDeadline(deadlineUnixMs, now, create) {
  deadlineRemainingMs(deadlineUnixMs, now);
  const response = create();
  deadlineRemainingMs(deadlineUnixMs, now);
  return response;
}

function deadlineHasExpired(deadlineUnixMs, now) {
  try { deadlineRemainingMs(deadlineUnixMs, now); return false; }
  catch (error) { if (error instanceof Error && error.message === "deadline-expired") return true; throw error; }
}

function isTimeoutFailure(error) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("timeout") || message.includes("timed out") || error?.code === "ETIMEDOUT";
}

export function classifyNativeFailure(error) {
  if (isTimeoutFailure(error)) return "PERMANENT";
  return error instanceof DockerControlPlaneUnavailable ? "TRANSIENT" : "PERMANENT";
}

function recordTimeoutWithoutResponse(config, body) {
  config.ledger.update(body, {
    state: "FAILED", outcome: "PERMANENT_FAILURE", disposalState: "REAPED_REMOVED",
    responseSha256: null, outputSha256: null, releaseHandle: null,
    failureClass: "PERMANENT", signedFailureFrame: null,
  });
}

export async function runNativeOperation(config, request, startupReady, closeAdmission, now = Date.now, dependencies = {}) {
  const deadlineUnixMs = request.body.deadlineUnixMs;
  deadlineRemainingMs(deadlineUnixMs, now);
  const previous = config.ledger.get(request.body);
  if (previous) {
    if (previous.requestSha256 !== request.requestSha256) throw new Error("request-tuple-conflict");
    if (previous.state === "FAILED" && previous.signedFailureFrame) return Buffer.from(previous.signedFailureFrame, "base64url");
    throw new Error("request-reconciliation-required");
  }
  const executeDocker = dependencies.docker ?? runDocker;
  const snapshot = await admissionSnapshot(config, startupReady, deadlineUnixMs, now, { docker: executeDocker });
  deadlineRemainingMs(deadlineUnixMs, now);
  if (snapshot.capacity.proof.state !== "OPEN") throw new Error("admission-not-open");
  if (request.body.operation === "VALIDATOR") {
    const writer = config.ledger.get({ ...request.body, operation: "WRITER" });
    if (!writer || writer.state !== "SUCCEEDED" || writer.disposalState !== "REAPED_REMOVED"
      || writer.projectId !== request.body.projectId || writer.artifactId !== request.body.artifactId
      || writer.sourceSha256 !== request.body.sourceSha256 || writer.outputSha256 !== request.body.inputSha256
      || writer.releaseHandle !== request.body.releaseHandle || writer.releaseManifestSha256 !== snapshot.release.sha256
      || writer.resourcePolicySha256 !== S8_NATIVE_RESOURCE_POLICY_SHA256) throw new Error("writer-release-binding-invalid");
  }
  deadlineRemainingMs(deadlineUnixMs, now);
  const maximum = request.body.operation === "WRITER" ? MAX_WRITER_INPUT_BYTES : MAX_VALIDATOR_INPUT_BYTES;
  if (request.payload.length < 1 || request.payload.length > maximum) throw new Error("request-size-invalid");
  const release = snapshot.release;
  const docker = deadlineBoundDocker(deadlineUnixMs, now, executeDocker);
  const volumeBaselineNames = dockerVolumeNames(await docker(config, ["volume", "ls", "--quiet"]));
  deadlineRemainingMs(deadlineUnixMs, now);
  if (volumeBaselineNames.length !== 0) throw new Error("docker-volume-inventory-not-empty");
  config.ledger.begin(request.body, request.requestSha256, release.sha256, S8_NATIVE_RESOURCE_POLICY_SHA256);
  deadlineRemainingMs(deadlineUnixMs, now);
  let containerId = null;
  let running = null;
  let containerRemoved = false;
  let successCommitted = false;
  let failureClass = "PERMANENT";
  let outcome = "PERMANENT_FAILURE";
  try {
    containerId = (await docker(config, createArguments(config, snapshot.capacity, release, request.body.operation, request.requestSha256), 30000)).trim();
    deadlineRemainingMs(deadlineUnixMs, now);
    if (!/^[0-9a-f]{64}$/u.test(containerId)) throw new Error("container-create-invalid");
    config.ledger.update(request.body, { containerId, disposalState: "RUNNING" });
    deadlineRemainingMs(deadlineUnixMs, now);
    await inspectCreatedContainer(config, containerId, docker);
    deadlineRemainingMs(deadlineUnixMs, now);
    running = await startContainer(config, containerId, request.payload, request.body.operation, undefined, deadlineUnixMs, now);
    deadlineRemainingMs(deadlineUnixMs, now);
    await inspectAndVerify(config, containerId, release, request.body.operation, workerBudget(snapshot.capacity.proof, request.body.operation), snapshot.capacity, docker);
    deadlineRemainingMs(deadlineUnixMs, now);
    await running.release();
    deadlineRemainingMs(deadlineUnixMs, now);
    const captured = await running.close();
    running = null;
    deadlineRemainingMs(deadlineUnixMs, now);
    if (captured.closedAtMs > deadlineUnixMs || captured.overflow || captured.code !== 0 || captured.signal !== null) throw new Error(captured.closedAtMs > deadlineUnixMs ? "deadline-expired" : "worker-process-failed");
    const result = parseContainerResult(captured.stdout, request.body.operation);
    deadlineRemainingMs(deadlineUnixMs, now);
    const runnerEvidence = verifyRunnerEvidence(result, request.body.operation, release);
    if (request.body.operation === "WRITER") verifyWriterReceipt(result, request, release);
    deadlineRemainingMs(deadlineUnixMs, now);
    if (!await removeContainer(config, containerId, snapshot.capacity.proof.allocation.rootlessDockerUid, docker, volumeBaselineNames)) throw new Error("container-removal-unproven");
    containerRemoved = true;
    deadlineRemainingMs(deadlineUnixMs, now);
    const releaseHandle = request.body.operation === "WRITER" ? randomBytes(32).toString("base64url") : request.body.releaseHandle;
    const response = createResponseBeforeDeadline(deadlineUnixMs, now, () => createResponse(config, request, release, containerId, "EXIT_0", result.output, result.auxiliary, runnerEvidence, releaseHandle));
    config.ledger.update(request.body, {
      state: "SUCCEEDED", outcome: "EXIT_0", disposalState: "REAPED_REMOVED",
      responseSha256: response.responseSha256, outputSha256: response.signed.body.outputSha256,
      releaseHandle: response.signed.body.releaseHandle, failureClass: null, signedFailureFrame: null,
    });
    successCommitted = true;
    deadlineRemainingMs(deadlineUnixMs, now);
    return response.frame;
  } catch (error) {
    let attachedProcessUnproven = Boolean(error && typeof error === "object" && error.disposalUnproven === true);
    if (running) {
      try { await running.abort(); }
      catch { attachedProcessUnproven = true; }
    }
    let removed = containerRemoved;
    if (!removed) {
      try { removed = await removeContainer(config, containerId, snapshot.capacity.proof.allocation.rootlessDockerUid, docker, volumeBaselineNames); } catch { /* quiescence remains unproven */ }
    }
    if (!removed || !containerId || attachedProcessUnproven) {
      closeAdmission();
      config.ledger.update(request.body, { state: "UNKNOWN", outcome: null, disposalState: containerId ? "UNKNOWN" : "NOT_STARTED", responseSha256: null, outputSha256: null, releaseHandle: null, failureClass: "UNCERTAIN", signedFailureFrame: null });
      throw new Error("disposal-unproven");
    }
    const message = error instanceof Error ? error.message : "worker-failure";
    if (message.includes("drift") || message.includes("limit") || message.includes("cgroup") || message.includes("security")) closeAdmission();
    if (!deadlineHasExpired(deadlineUnixMs, now) && classifyNativeFailure(error) === "TRANSIENT") {
      outcome = "TRANSIENT_INFRASTRUCTURE_FAILURE";
      failureClass = "TRANSIENT";
    }
    if (deadlineHasExpired(deadlineUnixMs, now)) {
      recordTimeoutWithoutResponse(config, request.body);
      throw new Error("deadline-expired");
    }
    let response;
    try {
      response = createResponseBeforeDeadline(deadlineUnixMs, now, () => createResponse(config, request, release, containerId, outcome));
    } catch (responseError) {
      if (deadlineHasExpired(deadlineUnixMs, now)) {
        recordTimeoutWithoutResponse(config, request.body);
        throw new Error("deadline-expired");
      }
      throw responseError;
    }
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
    if (deadlineHasExpired(deadlineUnixMs, now)) throw new Error("deadline-expired");
    if (successCommitted) throw new Error("deadline-expired");
    return response.frame;
  }
}
