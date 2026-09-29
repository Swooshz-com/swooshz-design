# S8 native worker host launcher

The launcher is a dedicated systemd service, separate from Coolify and the gateway. It controls only the dedicated rootless Docker socket at `/run/swooshz-s8/docker.sock`. It never receives the rootful Docker socket.

## Capacity hierarchy

The launcher is a system service; rootless Docker runs as a dedicated, lingered systemd user service. Docker's [rootless resource-limit guidance](https://docs.docker.com/engine/security/rootless/tips/) requires cgroup v2 with the systemd driver and [does not support a system-wide `User=` service](https://docs.docker.com/engine/security/rootless/tips/). The repository candidates under `deploy/user/` and `deploy/user-manager/` reflect that model. They are templates only.

- `swooshz-design.slice` contains the Design application, gateway, launcher, rootless Docker, and systemd overhead slices.
- `swooshz-non-design.slice` contains one finite slice per item in the signed sibling inventory: quote, n8n, wordpress, other-siblings, and future-non-design.
- `swooshz-host-reserve.slice` protects the approved host reserve.
- A UID-specific system-manager drop-in moves `user@<UID>.service` beneath `swooshz-design-rootless-docker.slice` and delegates `cpu`, `memory`, and `pids`. The `swooshz-s8-rootless-docker.service` user unit runs in `app.slice`; the `swooshz-s8-workers.slice` user slice is its sibling and carries the larger frozen Writer/Validator ceiling. Docker receives the slice unit name as `--cgroup-parent`, and the launcher checks the daemon PID and each worker process in the exact realized cgroups. The aggregate rootless runtime ceiling must exceed the worker ceiling in every dimension to leave positive capacity for dockerd, rootlesskit, and the user manager.

Streaming reserves at least 2 GiB and is partitioned 30% to the application cgroup, 30% to the gateway, and 40% to the launcher. Every budget is finite and checked against `cpu.max`, `memory.max`, and `pids.max`; the same values must be visible at both each allocation slice and the relevant systemd service cgroup.

Capacity issue #70 owns the future allocation values and their installation. The candidate units do not contain invented limits. Host installation must enable lingering for the dedicated runtime account; install its UID-specific user-manager drop-in; apply exact Owner-approved CPU, memory, and PID limits to the system slices, the UID-specific user-manager/app/daemon cgroups, and the user-manager worker slice; create `/run/swooshz-s8` with the specified owner/group/mode; enable cpu/memory/pids delegation along the tree; assign existing/future workloads to named slices; and prove the complete inventory before admission can become OPEN. The launcher fails closed if the proof, user service, cgroup driver, process placement, or resource readback is absent or mismatched. Per-job AppArmor is `unsupported-not-relied-upon` in the selected rootless Docker runtime, so the launcher emits no container AppArmor option. The signed release binds a separate RootlessKit host profile at `S8_ROOTLESSKIT_APPARMOR_PROFILE_FILE`; the launcher checks its digest, AppArmor enabled state, loaded enforce-mode profile, and the RootlessKit process label on each admission observation. Seccomp and NoNewPrivileges remain mandatory. `seccomp=unconfined` and `apparmor=unconfined` are rejected; any missing or drifting RootlessKit host profile keeps admission CLOSED.

The current 2-vCPU host cannot fit the frozen Writer CPU maximum plus positive runtime, sibling, and host budgets. No host change or native OPEN is authorized by these repository artifacts.

## Host services

- `user/swooshz-s8-rootless-docker.service` runs inside the dedicated `s8-worker-docker` user manager, binds only a Unix socket, uses the systemd cgroup driver, and has no network-published Docker API. The account must have no interactive login sessions; its user-manager slice is isolated by the exact-UID system drop-in.
- `swooshz-s8-worker-launcher.service` runs as `s8-worker-launcher` with access to the rootless socket and daemon PID file through the dedicated group. Its service cgroup must be beneath the launcher allocation slice. It has no cgroup write access and can only read the host's cgroup evidence.
- Runtime trust/proof files, TLS material, and signing keys are mounted or stored read-only to their consumers. The launcher's Ed25519 key remains in its protected host key store. Configure the paths through `/etc/swooshz/s8-worker-launcher.env`; do not put credentials in this repository.

These unit files are candidate artifacts. Do not install or start them as part of repository validation. They do not alter current systemd, Docker, Coolify, cgroups, siblings, or VPS configuration.
