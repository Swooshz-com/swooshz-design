import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { AppError } from "./types";
import type { S8AdmissionTrust } from "./s8-native-admission";
import type { S8SignedReleaseManifest } from "./s8-native-release";

export type S8NativeWorkerConfig = S8AdmissionTrust & {
  gatewayUrl: string;
  appSigningKeyId: string;
  appSigningPrivateKeyPem: string;
  releaseManifest: S8SignedReleaseManifest;
  releaseAuthorityKeys: Readonly<Record<string, string>>;
  tlsCaPem: string;
  tlsClientCertPem: string;
  tlsClientKeyPem: string;
};

const KEYS = [
  "S8_WORKER_GATEWAY_URL",
  "S8_APP_SIGNING_KEY_ID",
  "S8_APP_SIGNING_PRIVATE_KEY_PEM",
  "S8_CAPACITY_AUTHORITY_PUBLIC_KEYS_JSON",
  "S8_LAUNCHER_PUBLIC_KEYS_JSON",
  "S8_RELEASE_MANIFEST_JSON",
  "S8_RELEASE_PUBLIC_KEYS_JSON",
  "S8_WORKER_TLS_CA_PEM",
  "S8_WORKER_TLS_CLIENT_CERT_PEM",
  "S8_WORKER_TLS_CLIENT_KEY_PEM",
] as const;

type Environment = Partial<Record<(typeof KEYS)[number], string | undefined>>;
const KEY_ID = /^[A-Za-z0-9._-]{1,80}$/u;

function invalid(field: string): never {
  throw new AppError(500, "S8_NATIVE_WORKER_CONFIG_INVALID", [{ field: "configuration", code: "INVALID" }], { field });
}

function publicKeyMap(raw: string, field: string): Record<string, string> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return invalid(field); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalid(field);
  const result: Record<string, string> = {};
  for (const [keyId, pem] of Object.entries(parsed as Record<string, unknown>)) {
    if (!KEY_ID.test(keyId) || typeof pem !== "string" || pem.length < 1 || pem.length > 16_384) return invalid(field);
    try {
      if (createPublicKey(pem).asymmetricKeyType !== "ed25519") return invalid(field);
    } catch { return invalid(field); }
    result[keyId] = pem;
  }
  if (Object.keys(result).length === 0) return invalid(field);
  return result;
}

function assertPemCertificate(value: string, field: string, now = Date.now()): void {
  try {
    const certificate = new X509Certificate(value);
    if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) return invalid(field);
  } catch { return invalid(field); }
}

export function readS8RuntimeConfig(environment: Environment = process.env as Environment): S8NativeWorkerConfig | undefined {
  const values = KEYS.map((key) => environment[key]);
  if (values.every((value) => value === undefined || value === "")) return undefined;

  const missing = KEYS.find((key) => typeof environment[key] !== "string" || environment[key]!.length === 0);
  if (missing) return invalid(missing);

  const gatewayUrl = environment.S8_WORKER_GATEWAY_URL!;
  let parsedUrl: URL;
  try { parsedUrl = new URL(gatewayUrl); } catch { return invalid("S8_WORKER_GATEWAY_URL"); }
  if (parsedUrl.protocol !== "https:" || parsedUrl.username !== "" || parsedUrl.password !== "" || parsedUrl.pathname !== "/" || parsedUrl.search !== "" || parsedUrl.hash !== "") return invalid("S8_WORKER_GATEWAY_URL");

  const appSigningKeyId = environment.S8_APP_SIGNING_KEY_ID!;
  if (!KEY_ID.test(appSigningKeyId)) return invalid("S8_APP_SIGNING_KEY_ID");
  const appSigningPrivateKeyPem = environment.S8_APP_SIGNING_PRIVATE_KEY_PEM!;
  try {
    if (createPrivateKey(appSigningPrivateKeyPem).asymmetricKeyType !== "ed25519") return invalid("S8_APP_SIGNING_PRIVATE_KEY_PEM");
  } catch { return invalid("S8_APP_SIGNING_PRIVATE_KEY_PEM"); }

  const capacityAuthorityKeys = publicKeyMap(environment.S8_CAPACITY_AUTHORITY_PUBLIC_KEYS_JSON!, "S8_CAPACITY_AUTHORITY_PUBLIC_KEYS_JSON");
  const launcherKeys = publicKeyMap(environment.S8_LAUNCHER_PUBLIC_KEYS_JSON!, "S8_LAUNCHER_PUBLIC_KEYS_JSON");
  const releaseAuthorityKeys = publicKeyMap(environment.S8_RELEASE_PUBLIC_KEYS_JSON!, "S8_RELEASE_PUBLIC_KEYS_JSON");
  let releaseManifest: unknown;
  try { releaseManifest = JSON.parse(environment.S8_RELEASE_MANIFEST_JSON!); } catch { return invalid("S8_RELEASE_MANIFEST_JSON"); }
  if (!releaseManifest || typeof releaseManifest !== "object" || Array.isArray(releaseManifest)) return invalid("S8_RELEASE_MANIFEST_JSON");
  const tlsCaPem = environment.S8_WORKER_TLS_CA_PEM!;
  const tlsClientCertPem = environment.S8_WORKER_TLS_CLIENT_CERT_PEM!;
  const tlsClientKeyPem = environment.S8_WORKER_TLS_CLIENT_KEY_PEM!;
  assertPemCertificate(tlsCaPem, "S8_WORKER_TLS_CA_PEM");
  assertPemCertificate(tlsClientCertPem, "S8_WORKER_TLS_CLIENT_CERT_PEM");
  try {
    const key = createPrivateKey(tlsClientKeyPem);
    if (key.asymmetricKeyType !== "rsa" && key.asymmetricKeyType !== "ec" && key.asymmetricKeyType !== "ed25519") return invalid("S8_WORKER_TLS_CLIENT_KEY_PEM");
  } catch { return invalid("S8_WORKER_TLS_CLIENT_KEY_PEM"); }

  return {
    gatewayUrl: parsedUrl.origin,
    appSigningKeyId,
    appSigningPrivateKeyPem,
    releaseManifest: releaseManifest as S8SignedReleaseManifest,
    releaseAuthorityKeys,
    capacityAuthorityKeys,
    launcherKeys,
    tlsCaPem,
    tlsClientCertPem,
    tlsClientKeyPem,
  };
}
