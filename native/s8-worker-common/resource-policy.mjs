import { jcs, sha256 } from "./protocol.mjs";

export const S8_NATIVE_RESOURCE_POLICY = Object.freeze({
  schemaVersion: "s8-native-resource-policy-v1",
  oneOperationAtATime: true,
  streaming: Object.freeze({ minimumMemoryBytes: 2 * 1024 * 1024 * 1024, applicationPercent: 30, gatewayPercent: 30, launcherPercent: 40 }),
  writer: Object.freeze({
    cpuMilli: 2000,
    memoryBytes: 4 * 1024 * 1024 * 1024,
    pids: 80,
    inputBytes: 256 * 1024 * 1024,
    outputBytes: 128 * 1024 * 1024,
    receiptBytes: 1024 * 1024,
    stdoutBytes: 1024 * 1024,
    stderrBytes: 1024 * 1024,
    nativeDeadlineMs: 300000,
    endToEndDeadlineMs: 510000,
    tmpBytes: 1024 * 1024 * 1024,
  }),
  validator: Object.freeze({
    cpuMilli: 1000,
    memoryBytes: 1536 * 1024 * 1024,
    pids: 32,
    inputBytes: 128 * 1024 * 1024,
    outputBytes: 8 * 1024 * 1024,
    stdoutBytes: 8 * 1024 * 1024,
    stderrBytes: 1024 * 1024,
    nativeDeadlineMs: 120000,
    endToEndDeadlineMs: 330000,
    tmpBytes: 256 * 1024 * 1024,
  }),
});

export const S8_NATIVE_RESOURCE_POLICY_SHA256 = sha256(Buffer.from(jcs(S8_NATIVE_RESOURCE_POLICY), "utf8"));
