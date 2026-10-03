import { AppError } from "./types";
import { createPrivateKey, createPublicKey, X509Certificate, type KeyObject } from "node:crypto";
import { sha256 } from "./utils";
import type { S8AdmissionTrust } from "./s8-native-admission";
import type { S8SignedReleaseManifest } from "./s8-native-release";

export type S8ApplicationTrust = Readonly<{
  currentKeyId: string | null;
  signingKey: KeyObject | null;
  verificationKeys: ReadonlyMap<string, KeyObject>;
  keyDerIdentities: ReadonlyMap<string, string>;
  processBootstrapIdentity: object;
}>;

export type S8NativeWorkerConfig = S8AdmissionTrust & Readonly<{
  gatewayUrl: string;
  appSigningKeyId: string;
  appSigningPrivateKeyPem: string;
  releaseManifest: S8SignedReleaseManifest;
  releaseAuthorityKeys: Readonly<Record<string, string>>;
  tlsCaPem: string;
  tlsClientCertPem: string;
  tlsClientKeyPem: string;
}>;

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;
  constructor(values: ReadonlyMap<K, V>) { this.#values = new Map(values); Object.freeze(this); }
  get size(): number { return this.#values.size; }
  get(key: K): V | undefined { return this.#values.get(key); }
  has(key: K): boolean { return this.#values.has(key); }
  entries(): MapIterator<[K, V]> { return this.#values.entries(); }
  keys(): MapIterator<K> { return this.#values.keys(); }
  values(): MapIterator<V> { return this.#values.values(); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.#values.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.#values[Symbol.iterator](); }
  get [Symbol.toStringTag](): string { return "ImmutableMap"; }
}

const PROCESS_BOOTSTRAP_IDENTITY = Object.freeze({});

export function parseStrictJson(bytes: Buffer): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let offset = 0;
  const whitespace = () => { while (offset < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[offset]!)) offset++; };
  const parseString = (): string => {
    const start = offset;
    if (text[offset] !== '"') throw new Error("invalid JSON string");
    offset++;
    while (offset < text.length) {
      const character = text[offset++]!;
      if (character === '"') return JSON.parse(text.slice(start, offset)) as string;
      if (character === "\\") {
        if (offset >= text.length) throw new Error("invalid JSON escape");
        offset++;
      } else if (character.charCodeAt(0) < 0x20) throw new Error("invalid JSON control character");
    }
    throw new Error("unterminated JSON string");
  };
  const parseValue = (): void => {
    whitespace();
    const token = text[offset];
    if (token === '"') { parseString(); return; }
    if (token === "{") {
      offset++; whitespace();
      const keys = new Set<string>();
      if (text[offset] === "}") { offset++; return; }
      while (offset < text.length) {
        whitespace();
        const key = parseString();
        if (keys.has(key)) throw new Error("duplicate JSON object key");
        keys.add(key); whitespace();
        if (text[offset++] !== ":") throw new Error("invalid JSON object");
        parseValue(); whitespace();
        const delimiter = text[offset++];
        if (delimiter === "}") return;
        if (delimiter !== ",") throw new Error("invalid JSON object delimiter");
      }
      throw new Error("unterminated JSON object");
    }
    if (token === "[") {
      offset++; whitespace();
      if (text[offset] === "]") { offset++; return; }
      while (offset < text.length) {
        parseValue(); whitespace();
        const delimiter = text[offset++];
        if (delimiter === "]") return;
        if (delimiter !== ",") throw new Error("invalid JSON array delimiter");
      }
      throw new Error("unterminated JSON array");
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, offset)) { offset += literal.length; return; }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(text.slice(offset));
    if (number) { offset += number[0].length; return; }
    throw new Error("invalid JSON value");
  };
  parseValue(); whitespace();
  if (offset !== text.length) throw new Error("trailing JSON data");
  return JSON.parse(text) as unknown;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid record");
  const item = value as Record<string, unknown>;
  const actual = Object.keys(item).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error("invalid record keys");
  return item;
}

export function readS8ApplicationTrust(environment: Readonly<Record<string, string | undefined>> = process.env): S8ApplicationTrust {
  const currentKeyId = environment.S8_APP_SIGNING_KEY_ID;
  const privatePem = environment.S8_APP_SIGNING_PRIVATE_KEY_PEM;
  const keysetJson = environment.S8_APP_ACCEPTANCE_PUBLIC_KEYS_JSON;
  const configured = [currentKeyId, privatePem, keysetJson].map((value) => value !== undefined && value !== "");
  if (!configured.some(Boolean)) {
    return Object.freeze({ currentKeyId: null, signingKey: null, verificationKeys: new ImmutableMap(new Map()),
      keyDerIdentities: new ImmutableMap(new Map()), processBootstrapIdentity: PROCESS_BOOTSTRAP_IDENTITY });
  }
  if (!configured.every(Boolean) || keysetJson!.length > 1048576) {
    throw new AppError(500, "S8_RUNTIME_CONFIG_INVALID");
  }
  try {
    if (!/^[A-Za-z0-9._-]{1,80}$/u.test(currentKeyId!)) throw new Error("invalid current key id");
    const privateKey = createPrivateKey(privatePem!);
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("invalid signing key type");
    const currentPublic = createPublicKey(privateKey);
    const currentDer = currentPublic.export({ format: "der", type: "spki" });
    const parsed = exactRecord(parseStrictJson(Buffer.from(keysetJson!, "utf8")), ["schemaVersion", "keys"]);
    if (parsed.schemaVersion !== "s8-app-acceptance-keyset-v1" || !Array.isArray(parsed.keys) ||
        parsed.keys.length < 1 || parsed.keys.length > 128) throw new Error("invalid keyset");
    const keys = new Map<string, KeyObject>();
    const identities = new Map<string, string>();
    const seenDer = new Set<string>();
    let currentCount = 0;
    for (const raw of parsed.keys) {
      const entry = exactRecord(raw, ["keyId", "publicKeyPem"]);
      if (typeof entry.keyId !== "string" || !/^[A-Za-z0-9._-]{1,80}$/u.test(entry.keyId) ||
          typeof entry.publicKeyPem !== "string" || entry.publicKeyPem.length < 1 || entry.publicKeyPem.length > 16384 ||
          /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(entry.publicKeyPem) || keys.has(entry.keyId)) throw new Error("invalid public key entry");
      const key = createPublicKey(entry.publicKeyPem);
      if (key.asymmetricKeyType !== "ed25519") throw new Error("invalid public key type");
      const der = key.export({ format: "der", type: "spki" });
      const identity = sha256(der);
      if (seenDer.has(identity)) throw new Error("duplicate public key material");
      seenDer.add(identity);
      keys.set(entry.keyId, key);
      identities.set(entry.keyId, identity);
      if (entry.keyId === currentKeyId) {
        currentCount++;
        if (!der.equals(currentDer)) throw new Error("current key pair mismatch");
      }
    }
    if (currentCount !== 1) throw new Error("current key missing");
    return Object.freeze({ currentKeyId: currentKeyId!, signingKey: privateKey,
      verificationKeys: new ImmutableMap(keys), keyDerIdentities: new ImmutableMap(identities),
      processBootstrapIdentity: PROCESS_BOOTSTRAP_IDENTITY });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, "S8_RUNTIME_CONFIG_INVALID");
  }
}

const NATIVE_CONFIG_KEYS = [
  "S8_WORKER_GATEWAY_URL", "S8_APP_SIGNING_KEY_ID", "S8_APP_SIGNING_PRIVATE_KEY_PEM",
  "S8_CAPACITY_AUTHORITY_PUBLIC_KEYS_JSON", "S8_LAUNCHER_PUBLIC_KEYS_JSON", "S8_RELEASE_MANIFEST_JSON",
  "S8_RELEASE_PUBLIC_KEYS_JSON", "S8_WORKER_TLS_CA_PEM", "S8_WORKER_TLS_CLIENT_CERT_PEM",
  "S8_WORKER_TLS_CLIENT_KEY_PEM",
] as const;

type S8NativeEnvironment = Readonly<Record<string, string | undefined>>;
const KEY_ID = /^[A-Za-z0-9._-]{1,80}$/u;

function nativeConfigInvalid(field: string): never {
  throw new AppError(500, "S8_NATIVE_WORKER_CONFIG_INVALID", [{ field: "configuration", code: "INVALID" }], { field });
}

function nativePublicKeyMap(raw: string, field: string): Readonly<Record<string, string>> {
  try {
    const parsed = parseStrictJson(Buffer.from(raw, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return nativeConfigInvalid(field);
    const result: Record<string, string> = {};
    for (const [keyId, pem] of Object.entries(parsed as Record<string, unknown>)) {
      if (!KEY_ID.test(keyId) || typeof pem !== "string" || pem.length < 1 || pem.length > 16_384 ||
          /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(pem) ||
          createPublicKey(pem).asymmetricKeyType !== "ed25519") return nativeConfigInvalid(field);
      result[keyId] = pem;
    }
    if (Object.keys(result).length === 0) return nativeConfigInvalid(field);
    return Object.freeze(result);
  } catch {
    return nativeConfigInvalid(field);
  }
}

function checkedCertificate(value: string, field: string, nowMs: number): X509Certificate {
  try {
    const certificate = new X509Certificate(value);
    if (Date.parse(certificate.validFrom) > nowMs || Date.parse(certificate.validTo) <= nowMs) return nativeConfigInvalid(field);
    return certificate;
  } catch {
    return nativeConfigInvalid(field);
  }
}

export function readS8RuntimeConfig(environment: S8NativeEnvironment = process.env as S8NativeEnvironment): S8NativeWorkerConfig | undefined {
  const workerOnlyKeys = NATIVE_CONFIG_KEYS.filter((key) =>
    key !== "S8_APP_SIGNING_KEY_ID" && key !== "S8_APP_SIGNING_PRIVATE_KEY_PEM");
  if (workerOnlyKeys.every((key) => environment[key] === undefined)) return undefined;
  const missing = NATIVE_CONFIG_KEYS.find((key) => typeof environment[key] !== "string" || environment[key]!.length === 0);
  if (missing) return nativeConfigInvalid(missing);

  const gatewayUrl = environment.S8_WORKER_GATEWAY_URL!;
  let parsedUrl: URL;
  try { parsedUrl = new URL(gatewayUrl); } catch { return nativeConfigInvalid("S8_WORKER_GATEWAY_URL"); }
  if (parsedUrl.protocol !== "https:" || parsedUrl.username !== "" || parsedUrl.password !== "" ||
      parsedUrl.pathname !== "/" || parsedUrl.search !== "" || parsedUrl.hash !== "") return nativeConfigInvalid("S8_WORKER_GATEWAY_URL");

  const appSigningKeyId = environment.S8_APP_SIGNING_KEY_ID!;
  if (!KEY_ID.test(appSigningKeyId)) return nativeConfigInvalid("S8_APP_SIGNING_KEY_ID");
  const appSigningPrivateKeyPem = environment.S8_APP_SIGNING_PRIVATE_KEY_PEM!;
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(appSigningPrivateKeyPem);
    if (privateKey.asymmetricKeyType !== "ed25519") return nativeConfigInvalid("S8_APP_SIGNING_PRIVATE_KEY_PEM");
  } catch {
    return nativeConfigInvalid("S8_APP_SIGNING_PRIVATE_KEY_PEM");
  }
  let applicationTrust: S8ApplicationTrust;
  try { applicationTrust = readS8ApplicationTrust(environment as Readonly<Record<string, string | undefined>>); }
  catch { return nativeConfigInvalid("S8_APP_ACCEPTANCE_PUBLIC_KEYS_JSON"); }
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const configuredIdentity = applicationTrust.keyDerIdentities.get(appSigningKeyId);
  if (applicationTrust.currentKeyId !== appSigningKeyId || !configuredIdentity || sha256(publicKey) !== configuredIdentity) {
    return nativeConfigInvalid("S8_APP_SIGNING_KEY_ID");
  }

  const capacityAuthorityKeys = nativePublicKeyMap(environment.S8_CAPACITY_AUTHORITY_PUBLIC_KEYS_JSON!, "S8_CAPACITY_AUTHORITY_PUBLIC_KEYS_JSON");
  const launcherKeys = nativePublicKeyMap(environment.S8_LAUNCHER_PUBLIC_KEYS_JSON!, "S8_LAUNCHER_PUBLIC_KEYS_JSON");
  const releaseAuthorityKeys = nativePublicKeyMap(environment.S8_RELEASE_PUBLIC_KEYS_JSON!, "S8_RELEASE_PUBLIC_KEYS_JSON");
  let releaseManifest: unknown;
  try { releaseManifest = parseStrictJson(Buffer.from(environment.S8_RELEASE_MANIFEST_JSON!, "utf8")); }
  catch { return nativeConfigInvalid("S8_RELEASE_MANIFEST_JSON"); }
  if (!releaseManifest || typeof releaseManifest !== "object" || Array.isArray(releaseManifest)) return nativeConfigInvalid("S8_RELEASE_MANIFEST_JSON");

  const nowMs = Date.now();
  const tlsCaPem = environment.S8_WORKER_TLS_CA_PEM!;
  const tlsClientCertPem = environment.S8_WORKER_TLS_CLIENT_CERT_PEM!;
  const tlsClientKeyPem = environment.S8_WORKER_TLS_CLIENT_KEY_PEM!;
  checkedCertificate(tlsCaPem, "S8_WORKER_TLS_CA_PEM", nowMs);
  const clientCertificate = checkedCertificate(tlsClientCertPem, "S8_WORKER_TLS_CLIENT_CERT_PEM", nowMs);
  try {
    const tlsPrivateKey = createPrivateKey(tlsClientKeyPem);
    const algorithm = tlsPrivateKey.asymmetricKeyType;
    if (algorithm !== "rsa" && algorithm !== "ec" && algorithm !== "ed25519") return nativeConfigInvalid("S8_WORKER_TLS_CLIENT_KEY_PEM");
    if (!clientCertificate.publicKey.export({ format: "der", type: "spki" }).equals(createPublicKey(tlsPrivateKey).export({ format: "der", type: "spki" }))) {
      return nativeConfigInvalid("S8_WORKER_TLS_CLIENT_KEY_PEM");
    }
  } catch {
    return nativeConfigInvalid("S8_WORKER_TLS_CLIENT_KEY_PEM");
  }

  return Object.freeze({
    gatewayUrl: parsedUrl.origin,
    appSigningKeyId,
    appSigningPrivateKeyPem,
    releaseManifest: releaseManifest as S8NativeWorkerConfig["releaseManifest"],
    releaseAuthorityKeys,
    capacityAuthorityKeys,
    launcherKeys,
    tlsCaPem,
    tlsClientCertPem,
    tlsClientKeyPem,
  });
}
