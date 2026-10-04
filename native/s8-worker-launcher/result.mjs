import { sign } from "node:crypto";
import {
  MAX_HEADER_BYTES, MAX_VALIDATOR_OUTPUT_BYTES, MAX_WRITER_OUTPUT_BYTES, MAX_WRITER_RECEIPT_BYTES,
  encodeResponseFrame, jcs, sha256,
} from "../s8-worker-common/protocol.mjs";
import { S8_NATIVE_RESOURCE_POLICY, S8_NATIVE_RESOURCE_POLICY_SHA256 } from "../s8-worker-common/resource-policy.mjs";

const HEX64 = /^[0-9a-f]{64}$/u;

export function parseContainerResult(bytes, operation) {
  if (bytes.length < 4 + 8 + 8) throw new Error("container-result-invalid");
  const headerLength = bytes.readUInt32BE(0);
  if (headerLength < 1 || headerLength > MAX_HEADER_BYTES || bytes.length < 4 + headerLength + 16) throw new Error("container-result-invalid");
  const headerBytes = bytes.subarray(4, 4 + headerLength);
  const headerText = headerBytes.toString("utf8");
  const header = JSON.parse(headerText);
  const keys = ["auxiliarySha256", "operation", "outerExitStatus", "outerSignal", "outerStderrBytes", "outerStderrSha256", "outputSha256", "runnerEvidence", "schemaVersion", "targetStdoutBytes", "targetStdoutSha256"].sort();
  if (jcs(header) !== headerText || header.schemaVersion !== "s8-container-result-v1" || header.operation !== operation
    || Object.keys(header).sort().join(",") !== keys.join(",")) throw new Error("container-result-invalid");
  const outputLength = bytes.readBigUInt64BE(4 + headerLength);
  const outputStart = 4 + headerLength + 8;
  if (outputLength > BigInt(operation === "WRITER" ? MAX_WRITER_OUTPUT_BYTES : MAX_VALIDATOR_OUTPUT_BYTES)) throw new Error("container-output-limit");
  const auxiliaryOffset = outputStart + Number(outputLength);
  if (auxiliaryOffset + 8 > bytes.length) throw new Error("container-result-invalid");
  const auxiliaryLength = bytes.readBigUInt64BE(auxiliaryOffset);
  if (auxiliaryLength > BigInt(MAX_WRITER_RECEIPT_BYTES) || auxiliaryOffset + 8 + Number(auxiliaryLength) !== bytes.length) throw new Error("container-result-invalid");
  const output = bytes.subarray(outputStart, auxiliaryOffset);
  const auxiliary = bytes.subarray(auxiliaryOffset + 8);
  if (header.outerExitStatus !== 0 || header.outerSignal !== null || !Number.isSafeInteger(header.targetStdoutBytes) || header.targetStdoutBytes < 0
    || !Number.isSafeInteger(header.outerStderrBytes) || header.outerStderrBytes < 0 || header.outerStderrBytes > 1024 * 1024
    || header.outputSha256 !== sha256(output) || header.auxiliarySha256 !== sha256(auxiliary)
    || !HEX64.test(header.targetStdoutSha256) || !HEX64.test(header.outerStderrSha256)) throw new Error("container-result-invalid");
  if (operation === "WRITER" && (output.length <= 27 || auxiliary.length === 0 || header.targetStdoutBytes !== 0)) throw new Error("container-result-invalid");
  if (operation === "VALIDATOR" && (output.length === 0 || auxiliary.length !== 0)) throw new Error("container-result-invalid");
  return { header, output, auxiliary };
}

function canonicalRunnerReceipt(evidence) {
  return Buffer.from(JSON.stringify({
    schemaVersion: evidence.schemaVersion,
    protocol: evidence.protocol,
    policyId: evidence.policyId,
    requested: evidence.requested,
    appliedByChild: evidence.appliedByChild,
    observedByRunnerParent: evidence.observedByRunnerParent,
    runnerParentVerification: evidence.runnerParentVerification,
    runnerBinary: evidence.runnerBinary,
    result: evidence.result,
  }), "utf8");
}

export function verifyRunnerEvidence(result, operation, release) {
  const evidence = result.header.runnerEvidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)
    || evidence.schemaVersion !== "s8-process-runner-receipt-v2" || evidence.protocol !== "s8-process-runner-receipt-v2"
    || evidence.policyId !== "s8-zero-child-seccomp-x86_64-v2" || evidence.runnerParentVerification?.status !== "PASS"
    || evidence.runnerParentVerification?.mismatchCode !== null || evidence.runnerBinary?.selfSha256 !== release.manifest.processRunnerSha256) throw new Error("runner-evidence-invalid");
  const limit = operation === "WRITER" ? S8_NATIVE_RESOURCE_POLICY.writer : S8_NATIVE_RESOURCE_POLICY.validator;
  const expected = {
    rlimitAsBytes: limit.memoryBytes,
    rlimitFsizeBytes: operation === "WRITER" ? limit.outputBytes : limit.tmpBytes,
    rlimitCpuSeconds: Math.ceil(limit.nativeDeadlineMs / 1000) + 1,
    rlimitNproc: 64,
    wallTimeoutMs: limit.nativeDeadlineMs,
    stdoutBytes: limit.stdoutBytes,
    stderrBytes: limit.stderrBytes,
    maxChildren: 0,
  };
  if (jcs(evidence.requested) !== jcs(expected)) throw new Error("runner-policy-invalid");
  for (const section of [evidence.appliedByChild, evidence.observedByRunnerParent]) {
    if (section.rlimitAsBytes !== expected.rlimitAsBytes || section.rlimitFsizeBytes !== expected.rlimitFsizeBytes
      || section.rlimitCpuSeconds !== expected.rlimitCpuSeconds || section.rlimitNproc !== expected.rlimitNproc
      || section.noNewPrivs !== 1 || section.seccompMode !== 2) throw new Error("runner-applied-limits-invalid");
  }
  const native = evidence.result;
  if (native.code !== 0 || native.name !== "S8_RUNNER_SUCCESS" || native.terminationClass !== "target-exit-zero"
    || native.targetExit !== 0 || native.targetSignal !== null || native.setupStage !== null || native.evidenceCode !== null
    || !Number.isSafeInteger(native.elapsedMs) || native.elapsedMs < 0 || native.elapsedMs > limit.nativeDeadlineMs
    || native.stdoutBytes !== result.header.targetStdoutBytes || native.stderrBytes !== result.header.outerStderrBytes
    || native.stdoutBytes > limit.stdoutBytes || native.stderrBytes > limit.stderrBytes
    || (operation === "WRITER" && native.stdoutBytes !== 0)) throw new Error("runner-result-invalid");
  const runnerHash = evidence.runnerBinary.selfSha256;
  if (!HEX64.test(runnerHash)) throw new Error("runner-hash-invalid");
  return {
    ...evidence,
    verifiedByCaller: {
      schemaVersion: "s8-runner-caller-verification-v2",
      status: "VERIFIED_BY_CALLER",
      preLaunchSha256: runnerHash,
      postLaunchSha256: runnerHash,
      runnerReportedSelfSha256: runnerHash,
      outerExitStatus: result.header.outerExitStatus,
      outerSignal: result.header.outerSignal,
      observedStdoutBytes: native.stdoutBytes,
      observedStderrBytes: native.stderrBytes,
      receiptSha256: sha256(canonicalRunnerReceipt(evidence)),
    },
  };
}

export function createResponse(config, request, release, containerId, exitClass, output = Buffer.alloc(0), auxiliary = Buffer.alloc(0), runnerEvidence = null, releaseHandle = null) {
  const body = {
    schemaVersion: "s8-native-response-v1",
    launcherKeyId: config.signingKeyId,
    requestSha256: request.requestSha256,
    projectId: request.body.projectId,
    jobId: request.body.jobId,
    artifactId: request.body.artifactId,
    attempt: request.body.attempt,
    operation: request.body.operation,
    sourceSha256: request.body.sourceSha256,
    releaseManifestSha256: release.sha256,
    imageDigest: request.body.operation === "WRITER" ? release.manifest.writer.imageDigest : release.manifest.validator.imageDigest,
    containerId,
    inputSha256: request.body.inputSha256,
    inputBytes: request.body.inputBytes,
    outputSha256: sha256(output),
    outputBytes: output.length,
    auxiliarySha256: sha256(auxiliary),
    auxiliaryBytes: auxiliary.length,
    exitClass,
    limitProfileSha256: S8_NATIVE_RESOURCE_POLICY_SHA256,
    disposalState: "REAPED_REMOVED",
    releaseHandle: request.body.operation === "WRITER" ? releaseHandle : request.body.releaseHandle,
    validatorIdentity: exitClass === "EXIT_0" && request.body.operation === "VALIDATOR" ? `s8-validator-sha256:${release.manifest.validator.executableSha256}` : null,
    runnerEvidence,
  };
  const signature = sign(null, Buffer.concat([Buffer.from("S8-NATIVE-RESPONSE-V1\0", "ascii"), Buffer.from(jcs(body), "utf8")]), config.signingPrivateKey).toString("base64url");
  const signed = { body, signature };
  return { signed, frame: encodeResponseFrame(signed, output, auxiliary), responseSha256: sha256(Buffer.from(jcs(signed), "utf8")) };
}

export function verifyWriterReceipt(result, request, release) {
  const text = result.auxiliary.toString("utf8");
  const receipt = JSON.parse(text);
  if (jcs(receipt) !== text || receipt.payloadSha256 !== request.body.inputSha256
    || receipt.writerScriptSha256 !== release.manifest.writer.writerScriptSha256
    || receipt.artifactSha256 !== sha256(result.output) || receipt.artifactByteSize !== result.output.length) throw new Error("writer-receipt-invalid");
}
