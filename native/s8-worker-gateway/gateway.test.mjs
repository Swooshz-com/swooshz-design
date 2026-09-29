import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalFingerprint, S8_GATEWAY_OPERATION_CONTENT_TYPES } from "./gateway.mjs";

test("gateway accepts the application signed-frame content type and the launcher binary response type", () => {
  assert.equal(S8_GATEWAY_OPERATION_CONTENT_TYPES.includes("application/vnd.s8-native-frame-v1"), true);
  assert.equal(S8_GATEWAY_OPERATION_CONTENT_TYPES.includes("application/octet-stream"), true);
  assert.equal(S8_GATEWAY_OPERATION_CONTENT_TYPES.includes("application/json"), false);
});

test("gateway Compose descriptor has no published ports or Docker socket mount", () => {
  const compose = readFileSync(new URL("./compose.yaml", import.meta.url), "utf8");
  assert.doesNotMatch(compose, /^\s{4}ports:/mu);
  assert.doesNotMatch(compose, /docker\.sock/u);
  assert.match(compose, /^\s{4}expose:/mu);
  assert.match(compose, /read_only:\s*true/u);
  assert.match(compose, /cap_drop:[\s\S]*?ALL/u);
  const fingerprintEnv = 'S8_APP_CLIENT_CERT_SHA256S_JSON: "' + "$" + "{S8_APP_CLIENT_CERT_SHA256S_JSON:?set the app mTLS certificate fingerprints}" + '"';
  assert.equal(compose.includes(fingerprintEnv), true);
});

test("gateway TLS pins accept only canonical SHA-256 certificate fingerprints", () => {
  assert.equal(canonicalFingerprint("AA:".repeat(31) + "AA"), "aa".repeat(32));
  assert.equal(canonicalFingerprint("z".repeat(64)), null);
  assert.equal(canonicalFingerprint("a".repeat(63)), null);
});
