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
