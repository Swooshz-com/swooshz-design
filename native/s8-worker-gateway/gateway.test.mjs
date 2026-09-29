import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalFingerprint, launcherRequest, S8_GATEWAY_OPERATION_CONTENT_TYPES } from "./gateway.mjs";

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


test("launcher forwarding applies the signed deadline remainder as a total wall bound", async () => {
  let captured;
  class TricklingRequest extends EventEmitter {
    setTimeout(timeoutMs) { this.timeoutMs = timeoutMs; }
    end() {
      const response = new EventEmitter();
      response.statusCode = 200;
      this.responseTimer = setInterval(() => response.emit("data", Buffer.from("x")), 4);
      this.onResponse(response);
    }
    destroy(error) {
      if (this.destroyed) return this;
      this.destroyed = true;
      clearInterval(this.responseTimer);
      queueMicrotask(() => this.emit("error", error));
      return this;
    }
  }
  const requestImpl = (_url, _options, onResponse) => {
    captured = new TricklingRequest();
    captured.onResponse = onResponse;
    return captured;
  };
  await assert.rejects(
    launcherRequest(
      { launcherUrl: "https://launcher.invalid" },
      "GET",
      "/v1/admission",
      null,
      1024,
      500,
      "application/octet-stream",
      { deadlineUnixMs: 1025, requestImpl, now: () => 1000 },
    ),
    /launcher-timeout/u,
  );
  assert.equal(captured.timeoutMs, 25);
  assert.equal(captured.destroyed, true);
});

test("launcher forwarding rejects a response completed at the signed deadline", async () => {
  let now = 1000;
  class ImmediateRequest extends EventEmitter {
    setTimeout() {}
    end() {
      const response = new EventEmitter();
      response.statusCode = 200;
      this.onResponse(response);
      queueMicrotask(() => {
        now = 1010;
        response.emit("end");
      });
    }
    destroy(error) { queueMicrotask(() => this.emit("error", error)); return this; }
  }
  const requestImpl = (_url, _options, onResponse) => {
    const request = new ImmediateRequest();
    request.onResponse = onResponse;
    return request;
  };
  await assert.rejects(
    launcherRequest(
      { launcherUrl: "https://launcher.invalid" },
      "GET",
      "/v1/admission",
      null,
      1024,
      500,
      "application/octet-stream",
      { deadlineUnixMs: 1010, requestImpl, now: () => now },
    ),
    /launcher-deadline-expired/u,
  );
});


test("an expired app request disconnect cancels the pending launcher request", async () => {
  let captured;
  class PendingRequest extends EventEmitter {
    setTimeout() {}
    end() {}
    destroy(error) {
      this.destroyed = true;
      this.emit("error", error);
      return this;
    }
  }
  const downstream = new EventEmitter();
  downstream.destroyed = false;
  downstream.writableEnded = false;
  const requestImpl = () => {
    captured = new PendingRequest();
    return captured;
  };
  const pending = launcherRequest(
    { launcherUrl: "https://launcher.invalid" },
    "POST",
    "/v1/status",
    Buffer.from("{}"),
    1024,
    1000,
    "application/json",
    { requestImpl, downstreamResponse: downstream },
  );
  downstream.emit("close");
  await assert.rejects(pending, /launcher-client-disconnected/u);
  assert.equal(captured.destroyed, true);
});
