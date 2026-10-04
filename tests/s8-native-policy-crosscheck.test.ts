import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { S8_NATIVE_RESOURCE_POLICY_SHA256 as appPolicyHash } from "../src/lib/s8-native-admission";
import { S8_NATIVE_RESOURCE_POLICY_SHA256 as hostPolicyHash } from "../native/s8-worker-common/resource-policy.mjs";

const root = resolve(process.cwd());

test("application and native host enforce the same frozen resource policy digest", () => {
  assert.equal(hostPolicyHash, appPolicyHash);
});

test("Writer and Validator image templates have fixed non-root entrypoints without runtime escape directives", () => {
  for (const image of ["writer", "validator"]) {
    const source = readFileSync(join(root, "native/s8-worker-images", image, "Dockerfile"), "utf8");
    const runtime = source.split("FROM ${S8_RUNTIME_IMAGE} AS runtime", 2)[1]?.replace(/\r\n/gu, "\n");
    assert.ok(runtime, image + " runtime stage is required");
    assert.match(runtime, /^RUN mkdir -p .*\/usr\/share\/doc\/swooshz-s8 /mu);
    assert.match(runtime, /^USER 65532:65532$/mu);
    assert.match(runtime, /^ENTRYPOINT \["node", "\/opt\/s8\/worker-entrypoint\.mjs"\]$/mu);
    assert.doesNotMatch(runtime, /^\s*(?:EXPOSE|VOLUME)\b/mu);
    assert.doesNotMatch(runtime, /(?:docker\.sock|--privileged|--network|--mount|--volume)/iu);
    assert.equal((runtime.match(/^USER /gmu) ?? []).length, 1);
    assert.equal((runtime.match(/^ENTRYPOINT /gmu) ?? []).length, 1);
  }
});
