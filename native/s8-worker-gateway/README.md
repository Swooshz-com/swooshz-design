# S8 private gateway

The gateway verifies signed application frames, relays them to the host launcher over mutually authenticated TLS, and verifies the launcher's signed result. It has no Docker socket, signing key, payload volume, application database credential, or public listener.

Build the image with `native/s8-worker-images/build-image.sh gateway <local-tag>` and a digest-pinned `S8_RUNTIME_IMAGE`. Supply the deployed image as a repository plus SHA-256 digest in `S8_GATEWAY_IMAGE`.

The Compose service has no published `ports`. It exposes TLS port 8443 only to two separately provisioned private Docker networks:

- `S8_APP_GATEWAY_NETWORK` joins only the application and gateway.
- `S8_GATEWAY_LAUNCHER_NETWORK` joins only the gateway and the private launcher route.

Both external networks must be internal, have no public route, and have an inventory limited to their named participants. The host route to `S8_LAUNCHER_PRIVATE_IP` must stay private and be firewall-limited to the gateway. TLS pins and mTLS peer identities are checked in code. Do not attach the gateway to the application database/storage network or a public/reverse-proxy network.

Mounted TLS private keys and trust files must exist before starting the service, be read-only mounts, and be readable by UID/GID 65532 without world access. Private key source files should be root-owned and readable only by the gateway group. Trust JSON files contain public keys and the active signed release manifest.

The service cgroup parent is `swooshz-design-gateway.slice`. The cgroup limits are intentionally supplied by the realized Owner-approved capacity allocation, not invented here. Without a current signed proof, matching live cgroups, rootless runtime, and passed contention/resource-limit evidence, application admission remains CLOSED.

This descriptor is a reviewable candidate. It does not create networks, change Coolify configuration, deploy, or open native worker admission.
