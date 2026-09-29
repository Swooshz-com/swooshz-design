import assert from "node:assert/strict";
import test from "node:test";
import { S8_NATIVE_RESOURCE_POLICY_SHA256 as appPolicyHash } from "../src/lib/s8-native-admission";
import { S8_NATIVE_RESOURCE_POLICY_SHA256 as hostPolicyHash } from "../native/s8-worker-common/resource-policy.mjs";

test("application and native host enforce the same frozen resource policy digest", () => {
  assert.equal(hostPolicyHash, appPolicyHash);
});
