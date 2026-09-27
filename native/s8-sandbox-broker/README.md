# S8 sandbox broker

This Linux x86-64 C11 broker is the only application entry to Bubblewrap. It accepts exactly `--stdio-v1` or root-only `--recover-v1`; it has no caller-selected command, path, bind, environment, UID/GID, ACL, or cleanup operation. The application launcher accepts zero arguments and invokes the broker through the exact sudo tuple in the deployment template.

The stdio protocol is `s8-sandbox-broker-v1`: one 160-byte big-endian request header, the exact bounded payload, and EOF; responses use a 320-byte header and the ordered artifact, Writer receipt, original native stdout, original native stderr, and canonical broker metadata sections. SHA-256 binds the request payload and response sections. Broker diagnostics do not share native stdout/stderr.

The journal schema is `s8-sandbox-broker-journal-v1`. Durable records live only under the fixed private root's `.journal` directory. `.next` records are never authority. Allocation and deletion must be identity-bound, descriptor-relative, no-follow, mount-bounded, and capped at 256 levels, 4096 entries, 512 descriptors, and 30 seconds. Recovery never resumes a Writer or Validator launch.

Policy is read only from `/etc/swooshz/s8-broker-v1.json` and is admitted as root:root mode 0600. The policy contains stable-order runtime paths, host UID/GID, private-root device/inode, and SHA-256 identities for the launcher, broker, Bubblewrap, runner, validator, Writer, exporter, and patch manifest. The application-provided policy and config digests are correlation/admission values only; they never select executable or filesystem authority.

The deployment files in `deploy/` are reviewable candidate artifacts. This run does not install them on a production host.

Build and test on Linux x86-64 with:

```sh
cmake -S native/s8-sandbox-broker -B build/s8-sandbox-broker -DCMAKE_BUILD_TYPE=Release
cmake --build build/s8-sandbox-broker --config Release
ctest --test-dir build/s8-sandbox-broker --output-on-failure
```

## Hosted Route B validation

The hosted Route B check runs the deployment and application proof inside a root-owned mount-namespace holder. Mount propagation is recursively private; the holder mounts a distinct root-controlled tmpfs at `/opt`, leaving the outer host `/opt` unchanged. The private work root is `/var/lib/swooshz/s8`, mode `0710`, with access ACL entries `root:rwx`, the exact runner UID `--x`, owning group `---`, mask `--x`, and other `---`; it has no default ACL.

The generated sudoers rule grants the validated hosted account passwordless root execution only for the installed broker path with exactly `--stdio-v1`, via the `S8_BROKER_STDIO` command alias. The rule includes `NOSETENV` and `stay_setuid`. The recovery command and every other command remain denied. Hosted validation requires the real `visudo` parser and executes positive and negative `sudo` authorization cases, including recovery, alternate paths, wrong run-as/caller, and environment-setting attempts.

A PIDFD-backed supervisor owns and reaps the namespace holder and its children, proves namespace reference closure, handles cancellation at the `/opt` and application stages, and confirms the outer user/PID namespaces and `/opt` are unchanged. Inside that namespace the real broker is built and tested, installed with the exact policy, used by Blender and Writer to produce the FBX and receipt, followed by native validation, readback, semantic comparison, and identity-bound cleanup. These are hosted validation fixtures only; this run does not install or activate deployment files on a production host.
