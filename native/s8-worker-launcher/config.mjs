import { createPrivateKey } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { ReplayLedger } from "./ledger.mjs";

const KEY_ID = /^[A-Za-z0-9._-]{1,80}$/u;
const fingerprint = (value) => String(value ?? "").replaceAll(":", "").toLowerCase();

function privateAddress(address) {
  if (address === "127.0.0.1") return true;
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return false;
}

export function readJsonFile(path, maximum = 1024 * 1024) {
  const absolute = resolve(path);
  const info = lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum || (info.mode & 0o022) !== 0) throw new Error("protected-file");
  return JSON.parse(readFileSync(absolute, "utf8"));
}

function keyMap(environment, name) {
  const value = readJsonFile(environment[name], 256 * 1024);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) throw new Error("keys-missing");
  for (const [id, pem] of Object.entries(value)) if (!KEY_ID.test(id) || typeof pem !== "string" || pem.length > 16384) throw new Error("keys-invalid");
  return value;
}

function imageRepository(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9./:_-]{0,250}$/u.test(value) || value.includes("@")) throw new Error("image-repository-invalid");
  return value;
}

export function loadConfig(environment = process.env) {
  const bindAddress = environment.S8_LAUNCHER_BIND_ADDRESS;
  const port = Number(environment.S8_LAUNCHER_PORT);
  const socket = environment.S8_ROOTLESS_DOCKER_SOCKET;
  if (!bindAddress || !privateAddress(bindAddress) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("private-bind-required");
  if (socket !== "/run/swooshz-s8/docker.sock") throw new Error("rootless-socket-required");
  const required = [
    "S8_LAUNCHER_TLS_KEY_FILE", "S8_LAUNCHER_TLS_CERT_FILE", "S8_LAUNCHER_CLIENT_CA_FILE", "S8_GATEWAY_CLIENT_CERT_SHA256",
    "S8_LAUNCHER_SIGNING_KEY_FILE", "S8_LAUNCHER_KEY_ID", "S8_CAPACITY_PROOF_FILE", "S8_CAPACITY_AUTHORITY_PUBLIC_KEYS_FILE",
    "S8_RELEASE_MANIFEST_FILE", "S8_RELEASE_PUBLIC_KEYS_FILE", "S8_APP_PUBLIC_KEYS_FILE", "S8_WORKLOAD_INVENTORY_FILE",
    "S8_CGROUP_ROOT", "S8_SECCOMP_POLICY_FILE", "S8_ROOTLESSKIT_APPARMOR_PROFILE_FILE", "S8_LEDGER_DIRECTORY",
    "S8_WRITER_IMAGE_REPOSITORY", "S8_VALIDATOR_IMAGE_REPOSITORY",
  ];
  if (required.some((key) => typeof environment[key] !== "string" || environment[key].length === 0)) throw new Error("configuration-incomplete");
  const signingKeyId = environment.S8_LAUNCHER_KEY_ID;
  const signingFingerprint = fingerprint(environment.S8_GATEWAY_CLIENT_CERT_SHA256);
  if (!KEY_ID.test(signingKeyId) || !/^[a-f0-9]{64}$/u.test(signingFingerprint)) throw new Error("key-identity-invalid");
  const privateKeyPath = resolve(environment.S8_LAUNCHER_SIGNING_KEY_FILE);
  const privateKeyInfo = lstatSync(privateKeyPath);
  if (!privateKeyInfo.isFile() || privateKeyInfo.isSymbolicLink() || (privateKeyInfo.mode & 0o077) !== 0) throw new Error("signing-key-permissions");
  const signingPrivateKey = createPrivateKey(readFileSync(privateKeyPath));
  if (signingPrivateKey.asymmetricKeyType !== "ed25519") throw new Error("signing-key-invalid");
  const dockerPath = resolve(environment.S8_DOCKER_BIN ?? "/usr/bin/docker");
  if (!existsSync(dockerPath) || !lstatSync(dockerPath).isFile()) throw new Error("docker-cli-missing");
  const systemctlPath = resolve(environment.S8_SYSTEMCTL_BIN ?? "/usr/bin/systemctl");
  if (!existsSync(systemctlPath) || !lstatSync(systemctlPath).isFile()) throw new Error("systemctl-missing");
  return {
    bindAddress, port, gatewayFingerprint: signingFingerprint, signingKeyId, signingPrivateKey,
    tls: { key: readFileSync(environment.S8_LAUNCHER_TLS_KEY_FILE), cert: readFileSync(environment.S8_LAUNCHER_TLS_CERT_FILE), ca: readFileSync(environment.S8_LAUNCHER_CLIENT_CA_FILE) },
    capacityAuthorityKeys: keyMap(environment, "S8_CAPACITY_AUTHORITY_PUBLIC_KEYS_FILE"),
    releaseAuthorityKeys: keyMap(environment, "S8_RELEASE_PUBLIC_KEYS_FILE"),
    appKeys: keyMap(environment, "S8_APP_PUBLIC_KEYS_FILE"),
    capacityProofFile: resolve(environment.S8_CAPACITY_PROOF_FILE),
    releaseManifestFile: resolve(environment.S8_RELEASE_MANIFEST_FILE),
    workloadInventoryFile: resolve(environment.S8_WORKLOAD_INVENTORY_FILE),
    cgroupRoot: resolve(environment.S8_CGROUP_ROOT),
    procRoot: resolve(environment.S8_PROC_ROOT ?? "/proc"),
    sysRoot: resolve(environment.S8_SYS_ROOT ?? "/sys"),
    etcRoot: resolve(environment.S8_ETC_ROOT ?? "/etc"),
    seccompPolicyFile: resolve(environment.S8_SECCOMP_POLICY_FILE),
    rootlessKitAppArmorProfileFile: resolve(environment.S8_ROOTLESSKIT_APPARMOR_PROFILE_FILE),
    ledger: new ReplayLedger(resolve(environment.S8_LEDGER_DIRECTORY)),
    dockerPath, dockerSocket: socket,
    writerRepository: imageRepository(environment.S8_WRITER_IMAGE_REPOSITORY),
    validatorRepository: imageRepository(environment.S8_VALIDATOR_IMAGE_REPOSITORY),
    launcherCgroupLogicalPath: "/swooshz.slice/swooshz-design.slice/swooshz-design-launcher.slice",
    rootlessDockerPidFile: "/run/swooshz-s8/dockerd.pid",
    workerCgroupParentUnit: "swooshz-s8-workers.slice",
    systemctlPath,
  };
}
