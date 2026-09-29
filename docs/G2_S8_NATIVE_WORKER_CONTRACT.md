# S8 Native Worker Executable Contract

## Authority and current state

This contract implements the Owner-accepted Run-124 topology and the same Run-125 lock:

- Run: S8_G2_PR47_DEDICATED_NATIVE_WORKER_EXECUTABLE_CONTRACT_125
- Lock: DL-SD-S8-G2-PR47-DEDICATED-NATIVE-WORKER-EXECUTABLE-CONTRACT-001
- Architecture source: issue #29 comment 5881910161
- Capacity sequencing: Owner decision in issue #29 comment 5883045526
- Deferred realized-capacity gate: issue #70
- Frozen product base: PR #47 at ff6a9bada283d36b92637a810a7e9d691b92193e

The Owner sequencing decision in issue #29 comment 5883045526 closes the capacity re-entry for this Run-125 G2: host allocation is deferred to issue #70 as a pre-native-OPEN gate, and this same run and lock may continue. This contract defines the enforceable proof required later; it invents no numeric future allocation and does not claim the current host fits. Repository code, successor PR construction, and Alpha control-plane deployment may proceed without provisioning host capacity. Native Writer/Validator dispatch must remain unavailable until issue #70 is completed and accepted. No Owner-approved capacity allocation exists for the current 2-vCPU, 8,326,631,424-byte VPS.

The contract does not authorize provider, VPS, Coolify, Docker, cgroup, systemd, sibling workload, secret, deployment, native OPEN, G3, G4, Ready, or merge actions.

## Topology and authority

The runtime topology is:

    Design application
      -> private authenticated transport
      -> persistent private Coolify gateway
      -> private authenticated launcher listener
      -> host-owned launcher under a dedicated unprivileged account
      -> dedicated rootless Docker daemon
      -> one new Writer or Validator container for each operation

The gateway is a request verifier and byte relay only. It has no Docker socket, host bind mount, persistent job volume, application/database/storage network, product credentials, signing private key, public domain, reverse-proxy route, or published host port. Coolify project membership is not network-isolation evidence.

The host launcher is the only authority that can create, kill, inspect, or remove job containers. It may control only its dedicated rootless daemon. It has no access to the rootful Coolify Docker socket or unrelated runtimes. The rootless daemon socket is not mounted into the application, gateway, Writer, or Validator.

The reviewable gateway image and private Compose descriptor are under `native/s8-worker-gateway/`. Its TLS listener has no published host port, and the gateway joins only separate app-to-gateway and gateway-to-launcher private networks. The host launcher systemd unit and rootless Docker user-service/cgroup templates are under `native/s8-worker-launcher/deploy/`; they remain candidate artifacts and are not installed by this run.

Writer and Validator use separate immutable images and fresh containers. They never share a writable mount, container, process namespace, executable state, or live container. No fallback to a local process, APS, rootful Docker, unconfined execution, or persistent worker container is permitted.

The application remains the durable job, attempt, source-fence, semantic-validation, and publication authority. Gateway and launcher ledgers contain only bounded metadata required for replay prevention and recovery; they never contain customer payloads.

## Signed request and response protocol

Protocol version is s8-native-worker-v1. Transport is mutually authenticated TLS on private routes. The application-to-gateway message and launcher response also have independent Ed25519 signatures. Gateway verifies requests and launcher responses but has no signing key. Launcher independently verifies every application request.

Canonical signed bodies use the existing RFC 8785 JSON canonicalizer. Protocol strings are ASCII, numeric fields are safe integers, and floating-point values are forbidden. Signatures use these domain prefixes:

- Request: S8-NATIVE-REQUEST-V1 followed by one NUL byte.
- Response: S8-NATIVE-RESPONSE-V1 followed by one NUL byte.
- Capacity proof: S8-CAPACITY-PROOF-V1 followed by one NUL byte.
- Release manifest: S8-RELEASE-MANIFEST-V1 followed by one NUL byte.

The signature is Ed25519 over the domain prefix plus canonical JSON of the body without its signature field. Keys are selected by an explicit key ID. Key rotation uses overlapping key IDs; unknown, revoked, expired, malformed, or mismatched keys fail closed. App signing private keys exist only in the application secret store. Launcher response private keys exist only in the host launcher's protected key store. Gateway has only verification keys and TLS transport identity.

The request body contains exactly:

- schema version and application signing key ID;
- job ID, attempt number, and operation (WRITER or VALIDATOR);
- accepted source-stamp digest and S8 profile/configuration digest;
- input byte length and SHA-256;
- absolute deadline and 32-byte cryptographically random nonce;
- for VALIDATOR only, the opaque release handle issued by WRITER for this same attempt;
- detached request signature.

It does not contain image names/digests, commands, arguments, mounts, capabilities, devices, network settings, or arbitrary environment variables. Image selection is owned by the launcher.

The binary request is length framed: a 32-bit unsigned big-endian header length, the canonical signed header, a 64-bit unsigned big-endian payload length, then exactly that many payload bytes. Header maximum is 64 KiB. The server rejects truncated, extra, oversized, mismatched, or trailing bytes. WRITER input is limited to 256 MiB; VALIDATOR input is limited to 128 MiB.

The response has the same framing shape. Its signed header binds the exact request digest, job/attempt/operation, source digest, release-manifest digest, selected image digest, container identity, input and output hashes/lengths, exit class, enforced limit-policy digest, deadline result, and disposal result. Writer carries a maximum 128 MiB FBX and 1 MiB writer receipt. Validator carries a maximum 8 MiB readback. stdout and stderr are independently capped at 1 MiB and are not returned to the user. Response framing and every hash/length/signature/identity field are verified before the application accepts bytes.

A response is admissible only when native exit is successful, the receipt and output hashes match, the exact release and limits match, the accepted source and attempt match, and disposal is confirmed as killed/reaped/stopped/removed. Exit status by itself never proves success.

## Anti-replay and container lifecycle

Launcher persists an atomic, fsync-backed, metadata-only replay ledger before container creation. Its key is the tuple (job ID, attempt, operation). It records the request digest, nonce digest, state, container ID, release digest, enforced-policy digest, timestamps, outcome class, and disposal state. It never records payload bytes, signed URLs, customer content, environment values, or secrets.

A repeated tuple with a different request digest is rejected. An exact repeated tuple is a status/replay response only; it never creates a second container. Each retry receives a new attempt number, nonce, request signature, and fresh Writer and Validator containers. A launcher restart, corrupt ledger, unknown labeled container, incomplete container inventory, uncertain kill/reap, or unmatched execution closes launcher admission until reconciliation proves every owned container absent or safely terminal.

Each operation is run from a digest-qualified, already-preloaded image. Job admission never pulls. Launcher first reads and hashes the complete bounded input, verifies the declared digest, and confirms there is no conflicting attempt. It then creates one container with fixed arguments and fixed environment. After a terminal outcome, it kills if necessary, verifies all processes are gone, removes the container, verifies it is absent, and only then signs a final response.

If the transport is lost, the application asks the authenticated launcher for a signed status. It never infers completion from a partial stream. A missing or uncertain status keeps the job in reconciliation-required state and native admission CLOSED. One automatic retry is allowed only for a classified transient infrastructure failure after signed proof of disposal. A retry is a new attempt and reruns both operations. No automatic retry is allowed for invalid input, semantic/native validation failure, resource-limit violation, timeout, signature/provenance mismatch, or uncertain disposal.

## Resource and isolation policy

The frozen native maxima are exact:

| Operation | CPU maximum | Memory maximum | PID maximum | Native deadline | Input | Output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| WRITER | 2 CPUs | 4 GiB | 80 | 300 s | 256 MiB | 128 MiB FBX + 1 MiB receipt |
| VALIDATOR | 1 CPU | 1.5 GiB | 32 | 120 s | 128 MiB | 8 MiB readback |

The end-to-end deadlines remain 510 seconds for Writer and 330 seconds for Validator. Temporary filesystem ceilings remain 1 GiB and 256 MiB respectively. Writer stdout and all stderr are capped at 1 MiB; Validator stdout is the bounded readback channel capped at 8 MiB. Initially, the host launcher permits one native operation at a time across the whole Design worker.

Both images run as fixed non-root UIDs, with no supplementary groups, read-only root filesystem, no capabilities, NoNewPrivileges, enforced seccomp, enforced AppArmor where the accepted host supports it, bounded job-local tmpfs only, no bind mounts, no volumes, no devices, no host namespaces, no GPU, network none, no DNS, no inherited secrets, no core dumps, and restart policy disabled. Logs are disabled for payload streams. Fixed launcher-owned arguments/environment are not caller-selectable.

The launcher must prove the dedicated rootless Docker daemon and effective cgroup-v2 CPU, memory, and PID controllers before exposing admission. Rootless Docker resource flags require cgroup v2 with the systemd driver, so the launcher rejects cgroupfs and verifies the actual user-manager, daemon, worker-slice, and worker-scope cgroups. The concrete container ceilings must be verified from the realized cgroup hierarchy, not inferred from CLI flags alone. Docker currently [lists AppArmor as unsupported in rootless mode](https://docs.docker.com/engine/security/rootless/troubleshoot/); this contract retains the accepted AppArmor requirement and the launcher fails closed unless the realized runtime can prove enforcement. Missing delegation/controller support, finite-limit readback failure, seccomp/AppArmor mismatch, image drift, runtime drift, or unknown workload inventory keeps admission CLOSED. A rootful daemon or unconfined fallback is forbidden.

## CLOSED / PROVING / OPEN and deferred capacity proof

The fail-safe state is CLOSED. At application startup, launcher startup, missing configuration, missing capacity proof, expired proof, bad signature, invalid host measurement, failed cgroup reconciliation, incomplete host inventory, resource drift, or failed container teardown, admission is CLOSED.

PROVING permits only operator-controlled synthetic capacity and enforcement probes. It does not permit product jobs or customer payload dispatch. The application and gateway reject WRITER and VALIDATOR operations in both CLOSED and PROVING.

OPEN requires all of the following:

1. Issue #70 has an Owner-approved capacity solution and its result is accepted.
2. The realized physical host has been freshly measured; CPU is based on online CPU capacity, memory on physical MemTotal, and PIDs on the host process ceiling. Instantaneous MemAvailable and sampled spare CPU are not reservations.
3. A current Owner-signed capacity proof and launcher-signed live observation are valid and match the realized host, cgroup tree, release, and resource policy.
4. The allocation arithmetic below passes.
5. Rootless cgroup-v2, finite ceilings, complete workload inventory, host-reserve protection, sibling bounds, and the Design hierarchy are freshly read back.
6. Required contention and resource-limit proofs have passed and remain bound to the proof digests.
7. Startup reconciliation has found no unknown, running, or unreaped job container.

The signed capacity proof binds proof ID, host identity, state, measured-at and expiry times, physical CPU/memory/PID capacity, allocation values, one-operation concurrency, workload-inventory digest, cgroup-tree digest, release-manifest digest, policy digest, and accepted evidence IDs. Its TTL is at most five minutes. The launcher performs the same checks on every operation and signs a fresh observation; the application independently verifies both signatures and the proof arithmetic. Any stale or drifted observation is CLOSED.

Each allocation is a finite positive tuple of CPU milli-CPUs, memory bytes, and PIDs. The signed proof itemizes `quote`, `n8n`, `wordpress`, `other-siblings`, and `future-non-design` under `swooshz-non-design.slice`, with one exact cgroup path per workload ID. Additional sibling entries must be sorted, unique, and fit the signed aggregate. Each maps to `/swooshz.slice/swooshz-non-design.slice/swooshz-non-design-<workloadId>.slice`. This prevents one combined sibling number from hiding an unbounded service or consuming another sibling's allocation.

The systemd hierarchy is rooted at `/swooshz.slice`, with `swooshz-design.slice`, `swooshz-non-design.slice`, and `swooshz-host-reserve.slice` as its exact children. Design then has exact application, gateway, launcher, rootless-Docker, and systemd slices. The launcher service must run below its launcher slice. Rootless Docker runs only as a dedicated systemd user service: a UID-specific system-manager drop-in places `user@<UID>.service` below the rootless-runtime slice and delegates `cpu`, `memory`, and `pids`; the Docker daemon runs in the user's `app.slice`, and `swooshz-s8-workers.slice` is a separate user-manager child used as Docker's systemd `--cgroup-parent`. The launcher reads the daemon PID file and verifies daemon and worker cgroup membership on every admission observation. Unknown user-manager cgroups or extra worker scopes keep admission CLOSED.

The allocation groups are:

- Design application;
- private gateway;
- host launcher;
- dedicated rootless Docker daemon/runtime;
- Design-owned systemd service and launcher overhead;
- streaming buffers (minimum 2 GiB reserved across the bounded application, gateway, and launcher framing buffers);
- Writer;
- Validator;
- aggregate non-Design siblings, including current and future workloads;
- protected Linux/systemd/Coolify/Docker host reserve;
- Design aggregate parent ceiling.

For each resource dimension, Design aggregate covers application + gateway + launcher + rootless-runtime aggregate + Design systemd overhead + streaming. The signed rootless allocation binds the dedicated Docker UID. The rootless-runtime aggregate includes the user manager, daemon, rootlesskit, and worker slice and must be strictly larger than max(Writer, Validator) in CPU, memory, and PIDs; the exact frozen operation ceiling is enforced by `swooshz-s8-workers.slice` and by each Docker worker scope. This avoids counting the nested worker twice in Design arithmetic while leaving positive runtime capacity. The minimum 2 GiB streaming allocation is hard-partitioned 30% to the application cgroup, 30% to the gateway, and 40% to the launcher; each leaf cgroup includes its fixed share in addition to its process budget. The split is part of the signed resource-policy digest. Host total covers Design aggregate + non-Design aggregate + protected host reserve. Writer and Validator proof values must equal the frozen maxima above. The realized cgroup hierarchy enforces the same partition through finite `cpu.max`, `memory.max`, and `pids.max`; CPU shares/weights, MemAvailable, or a semaphore do not substitute for finite hard ceilings.

The current 2-vCPU host cannot pass this arithmetic: Writer's frozen 2-CPU maximum leaves no positive CPU budget for the application, gateway, launcher, rootless runtime, systemd integration, streaming, siblings, or host reserve. Capacity work is deferred to issue #70; no numeric allocation is fabricated in this contract. The systemd user-service and cgroup hierarchy, proof-bound runtime UID, and enforcement readback are specified, but only an Owner-approved future allocation installation can make the readback pass. Until then, native admission is CLOSED.

Until a valid OPEN proof is realized, the Alpha application may run as a control plane, but its S8 export endpoint must not dispatch Writer or Validator. Missing gateway, missing key, missing admission proof, invalid signature, or closed launcher returns a safe unavailable/closed result. The application may keep a durable queued request if it does not start a native operation; retry or reconciliation still rechecks admission before any dispatch.

## Application job, attempt, and publication durability

The application database is durable job truth. A job binds project, idempotency key, accepted source stamp, canonical input hash, status, publication phase, and current claim fence. Each native attempt is persisted before remote dispatch and binds attempt number, source digest, request digests/nonces, release manifest, writer/validator states, staged-object hashes, container identities, failure class, disposal proof, and timestamps. Payloads and private object bytes are not copied into the job database.

The existing accepted-source fence is checked at admission, before each operation, after each response, before promotion, and at commit. Every state mutation is conditional on job claim token, source stamp, attempt, and expected prior state.

Publication order is:

1. Persist the job and attempt.
2. Send the bounded canonical Writer payload through the signed gateway protocol.
3. Verify response signature, source/attempt/release/limit binding, sizes, hashes, and teardown.
4. Write the Writer artifact and receipt to private attempt-scoped staging with no-overwrite semantics; read back and verify the exact hashes.
5. Send those exact verified staged bytes to a new Validator container using the same opaque release handle.
6. Verify the signed response and independently compare the returned readback to accepted S6 truth and S7 same-source cross-output evidence.
7. Persist validation evidence, recheck current source and claim, promote immutable objects, read them back, verify exact hashes, and conditionally commit.
8. Treat any pre-commit crash as incomplete/unpublished. Object existence, process exit, worker receipt, or partial stream never makes a downloadable committed artifact.

If a claim becomes stale, output is invalidated, or storage state is ambiguous, do not overwrite or auto-publish. Recovery is explicit and claim-fenced. Download requires committed state, exact current source, and successful object readback.

## Release manifest and image admission

One signed immutable release manifest names both image digests and binds:

- Writer image digest, Blender archive/version identity, exporter/patch identity, and writer executable hashes;
- Validator image digest, ufbx version/commit/tree and validator executable hash;
- protocol/profile and resource-policy versions/digests;
- seccomp and AppArmor policy digests;
- build provenance and SBOM digests;
- release sequence, signing key ID, and creation time.

Images are built and verified out of band, then preloaded through an operator-controlled update. The launcher accepts only the active Owner-approved manifest and its two exact image digests. Mutable tags, runtime pulls, app-selected images, partial manifest updates, and mixed releases within one attempt are rejected. Rollback is a new verified manifest/admission transition while CLOSED; it does not reuse prior success markers.

## G2 validation boundary and deferred host proof

Repository validation covers protocol canonicalization/signature/replay negatives, bounded framing and hashing, proof arithmetic and fail-closed states, physical-host measurement from online CPUs/MemTotal/pid_max, exact cgroup inventory/readback, launcher/rootless process placement, durable attempt transitions, source/claim fencing, publication recovery, fixed container arguments, image/manifest admission, private gateway routing, and generic error/log redaction.

No Docker daemon, Coolify resource, VPS, cgroup tree, sibling service, capacity proof, or production workload is mutated in this repository task. Real rootless/cgroup enforcement, current/future sibling ceilings, contention/resource-limit demonstrations, realized-host measurement, and CLOSED -> PROVING -> OPEN remain issue #70 pre-OPEN requirements.
