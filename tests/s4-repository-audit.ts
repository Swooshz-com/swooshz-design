import { jcs, sha256 } from "../src/lib/utils";

export type S4DeltaDisposition =
  | "unchanged"
  | "changed_authorized_conformant"
  | "changed_unauthorized_nonconformant";

export type S4RepositoryDelta = {
  surface: "production-runtime-dependency" | "test-only-dependency" | "package-manifest" | "lockfile";
  path: string;
  name: string | null;
  baseValue: string | null;
  candidateValue: string | null;
  disposition: Exclude<S4DeltaDisposition, "unchanged">;
  purpose: string | null;
  authorityRefs: string[];
  evidenceFacts: string[];
};

export type S4DependencySectionSnapshot = {
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
  devDependencies: Record<string, string>;
  bundledDependencies: string[];
  bundleDependencies: string[];
};

export type S4DependencyAudit = {
  auditState: "complete" | "incomplete";
  packageManifestPath: "package.json";
  lockfilePath: "pnpm-lock.yaml";
  baseManifestSha256: string;
  candidateManifestSha256: string;
  baseLockfileSha256: string;
  candidateLockfileSha256: string;
  baseDependencySections: S4DependencySectionSnapshot;
  candidateDependencySections: S4DependencySectionSnapshot;
  productionGraphUnchanged: boolean;
  testOnlyRuntimeReachabilityAbsent: boolean;
  deltas: S4RepositoryDelta[];
  disposition: S4DeltaDisposition | null;
};

export type S4ScriptDelta = {
  scriptName: string;
  baseValue: string | null;
  candidateValue: string | null;
  disposition: Exclude<S4DeltaDisposition, "unchanged">;
  purpose: string | null;
  authorityRefs: string[];
  preservedRequiredValidation: string[];
  removedRequiredValidation: string[];
  executedRequiredValidation: string[];
  evidenceFacts: string[];
};

export type S4ScriptAudit = {
  auditState: "complete" | "incomplete";
  baseScripts: Record<string, string>;
  candidateScripts: Record<string, string>;
  completeMapEqual: boolean;
  changedScripts: S4ScriptDelta[];
  disposition: S4DeltaDisposition | null;
};

export type S4DependencyAuthority = {
  packageName: string;
  packageVersion: string;
  baseManifestValue: string | null;
  manifestPath: "devDependencies";
  purpose: string;
  allowedImportSurface: string[];
  authorityRefs: string[];
  requiredAuthorityRef: string;
  baselineSha: string;
  baselineTree: string;
};

export type S4ScriptAuthority = {
  scriptName: string;
  baseValue: string;
  candidateValue: string;
  purpose: string;
  authorityRefs: string[];
  requiredAuthorityRef: string;
  preservedRequiredValidation: string[];
  removedRequiredValidation: string[];
  executedRequiredValidation: string[];
  requiredValidationLabels: string[];
};

export type S4RepositoryAuditInput = {
  basePackageText: string;
  candidatePackageText: string;
  baseLockfileText: string;
  candidateLockfileText: string;
  sourceFiles: Record<string, string>;
  dependencyAuthority: S4DependencyAuthority;
  scriptAuthority: S4ScriptAuthority;
};

export type S4RepositoryAudit = {
  dependencyAudit: S4DependencyAudit;
  scriptAudit: S4ScriptAudit;
};

type JsonRecord = Record<string, unknown>;
type JsonValue = unknown;

const DEPENDENCY_SECTION_NAMES = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "devDependencies",
  "bundledDependencies",
  "bundleDependencies",
] as const;
const LOCKFILE_ROOT_KEYS = new Set(["lockfileVersion", "settings", "importers", "packages", "snapshots"]);
const LOCKFILE_IMPORTER_SECTIONS = new Set(["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]);
const EMPTY_DEPENDENCY_SECTIONS: S4DependencySectionSnapshot = {
  dependencies: {}, optionalDependencies: {}, peerDependencies: {}, peerDependenciesMeta: {}, devDependencies: {},
  bundledDependencies: [], bundleDependencies: [],
};

function isRecord(value: JsonValue): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: JsonValue): string { return jcs(value); }

function equalValue(left: JsonValue, right: JsonValue): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonical(left) === canonical(right);
}

function valueText(value: JsonValue): string | null {
  if (value === undefined) return null;
  return typeof value === "string" ? value : canonical(value);
}

function checkedString(value: JsonValue, label: string): string {
  if (typeof value !== "string") throw new Error("invalid " + label);
  return value;
}

function checkedStringMap(value: JsonValue, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("invalid " + label);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) result[key] = checkedString(item, label + "." + key);
  return result;
}

function checkedStringArray(value: JsonValue, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("invalid " + label);
  return value.slice() as string[];
}

function checkedPeerMeta(value: JsonValue): Record<string, { optional?: boolean }> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("invalid peerDependenciesMeta");
  const result: Record<string, { optional?: boolean }> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isRecord(item) || Object.keys(item).some((itemKey) => itemKey !== "optional") || (item.optional !== undefined && typeof item.optional !== "boolean")) throw new Error("invalid peerDependenciesMeta." + key);
    result[key] = item as { optional?: boolean };
  }
  return result;
}

function packageSections(value: JsonRecord): S4DependencySectionSnapshot {
  return {
    dependencies: checkedStringMap(value.dependencies, "dependencies"),
    optionalDependencies: checkedStringMap(value.optionalDependencies, "optionalDependencies"),
    peerDependencies: checkedStringMap(value.peerDependencies, "peerDependencies"),
    peerDependenciesMeta: checkedPeerMeta(value.peerDependenciesMeta),
    devDependencies: checkedStringMap(value.devDependencies, "devDependencies"),
    bundledDependencies: checkedStringArray(value.bundledDependencies, "bundledDependencies"),
    bundleDependencies: checkedStringArray(value.bundleDependencies, "bundleDependencies"),
  };
}

type ParsedPackage = { root: JsonRecord; sections: S4DependencySectionSnapshot; scripts: Record<string, string> };

function parsePackage(text: string): ParsedPackage {
  const parsed = JSON.parse(text) as JsonValue;
  if (!isRecord(parsed)) throw new Error("package manifest is not an object");
  return { root: parsed, sections: packageSections(parsed), scripts: checkedStringMap(parsed.scripts, "scripts") };
}

type YamlLine = { indent: number; text: string; line: number };

type PnpmLocator = {
  name: string;
  version: string;
  peers: PnpmLocator[];
};

function parsePnpmLocator(value: string, label: string, depth = 0): PnpmLocator {
  if (!value || value.trim() !== value || depth > 32) throw new Error("invalid " + label);
  const firstOpen = value.indexOf("(");
  const baseEnd = firstOpen < 0 ? value.length : firstOpen;
  if (baseEnd <= 0 || (value.includes(")") && firstOpen < 0)) throw new Error("invalid " + label);
  const at = value.lastIndexOf("@", baseEnd - 1);
  if (at <= 0 || at >= baseEnd - 1) throw new Error("invalid " + label);
  const name = value.slice(0, at);
  const version = value.slice(at + 1, baseEnd);
  if (!name || !version || /[\s()]/.test(name) || /[\s()]/.test(version)) throw new Error("invalid " + label);
  const peers: PnpmLocator[] = [];
  let cursor = baseEnd;
  while (cursor < value.length) {
    if (value[cursor] !== "(") throw new Error("invalid " + label);
    let nested = 1;
    let close = -1;
    for (let index = cursor + 1; index < value.length; index += 1) {
      if (value[index] === "(") nested += 1;
      else if (value[index] === ")") {
        nested -= 1;
        if (nested === 0) {
          close = index;
          break;
        }
      }
    }
    if (close <= cursor + 1) throw new Error("invalid " + label);
    peers.push(parsePnpmLocator(value.slice(cursor + 1, close), label + " peer", depth + 1));
    cursor = close + 1;
  }
  return { name, version, peers };
}

function locatorShape(locator: PnpmLocator): JsonValue {
  return { name: locator.name, version: locator.version, peers: locator.peers.map(locatorShape) };
}

function locatorsEqual(left: PnpmLocator, right: PnpmLocator): boolean {
  return canonical(locatorShape(left)) === canonical(locatorShape(right));
}

function directLocator(name: string, version: string, label: string): PnpmLocator {
  return parsePnpmLocator(name + "@" + version, label);
}

function validSha512Integrity(value: JsonValue): value is string {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const encoded = value.slice("sha512-".length);
  const decoded = Buffer.from(encoded, "base64");
  return decoded.length === 64 && decoded.toString("base64") === encoded;
}

function stripYamlComment(text: string): string {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let squareDepth = 0;
  let curlyDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (character === "'" && text[index + 1] === "'") index += 1;
      else if (character === "'") quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "[") squareDepth += 1;
    else if (character === "]") squareDepth -= 1;
    else if (character === "{") curlyDepth += 1;
    else if (character === "}") curlyDepth -= 1;
    else if (character === "#" && squareDepth === 0 && curlyDepth === 0 && (index === 0 || /\s/.test(text[index - 1]))) return text.slice(0, index).trimEnd();
  }
  return text;
}

function yamlLines(text: string): YamlLine[] {
  const result: YamlLine[] = [];
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    if (/\t/.test(rawLine)) throw new Error("tab indentation in pnpm lockfile line " + (index + 1));
    const withoutComment = stripYamlComment(rawLine);
    if (!withoutComment.trim() || withoutComment.trim() === "---" || withoutComment.trim() === "...") continue;
    const indent = withoutComment.length - withoutComment.trimStart().length;
    result.push({ indent, text: withoutComment.trim(), line: index + 1 });
  }
  return result;
}

function topLevelParts(text: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let squareDepth = 0;
  let curlyDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (character === "'" && text[index + 1] === "'") index += 1;
      else if (character === "'") quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "[") squareDepth += 1;
    else if (character === "]") squareDepth -= 1;
    else if (character === "{") curlyDepth += 1;
    else if (character === "}") curlyDepth -= 1;
    else if (character === separator && squareDepth === 0 && curlyDepth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

function topLevelColon(text: string): number {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let squareDepth = 0;
  let curlyDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (character === "'" && text[index + 1] === "'") index += 1;
      else if (character === "'") quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "[") squareDepth += 1;
    else if (character === "]") squareDepth -= 1;
    else if (character === "{") curlyDepth += 1;
    else if (character === "}") curlyDepth -= 1;
    else if (character === ":" && squareDepth === 0 && curlyDepth === 0) return index;
  }
  return -1;
}

function yamlScalar(text: string): JsonValue {
  const value = text.trim();
  if (!value) return null;
  if (value.startsWith("{") && value.endsWith("}")) {
    const body = value.slice(1, -1).trim();
    const result: JsonRecord = {};
    if (!body) return result;
    for (const part of topLevelParts(body, ",")) {
      const colon = topLevelColon(part);
      if (colon < 1) throw new Error("invalid inline YAML map");
      const key = yamlScalar(part.slice(0, colon));
      if (typeof key !== "string" || Object.prototype.hasOwnProperty.call(result, key)) throw new Error("invalid inline YAML key");
      result[key] = yamlScalar(part.slice(colon + 1));
    }
    return result;
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const body = value.slice(1, -1).trim();
    return body ? topLevelParts(body, ",").map((part) => yamlScalar(part)) : [];
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value.startsWith('"') && value.endsWith('"')) {
    const parsed = JSON.parse(value) as JsonValue;
    if (typeof parsed !== "string") throw new Error("invalid YAML string");
    return parsed;
  }
  if (value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function parseYamlBlock(lines: YamlLine[], index: number, indent: number): { value: JsonValue; next: number } {
  if (index >= lines.length || lines[index].indent !== indent) throw new Error("invalid YAML indentation");
  const sequence = lines[index].text === "-" || lines[index].text.startsWith("- ");
  if (sequence) {
    const result: JsonValue[] = [];
    while (index < lines.length && lines[index].indent === indent && (lines[index].text === "-" || lines[index].text.startsWith("- "))) {
      const item = lines[index].text.slice(1).trim();
      index += 1;
      if (!item) {
        if (index < lines.length && lines[index].indent > indent) {
          const nested = parseYamlBlock(lines, index, lines[index].indent);
          result.push(nested.value);
          index = nested.next;
        } else result.push(null);
      } else {
        result.push(yamlScalar(item));
        if (index < lines.length && lines[index].indent > indent) throw new Error("unsupported nested YAML sequence item at line " + lines[index].line);
      }
    }
    return { value: result, next: index };
  }
  const result: JsonRecord = {};
  while (index < lines.length && lines[index].indent === indent && !lines[index].text.startsWith("-")) {
    const line = lines[index];
    const colon = topLevelColon(line.text);
    if (colon < 1) throw new Error("invalid YAML mapping at line " + line.line);
    const keyValue = yamlScalar(line.text.slice(0, colon));
    if (typeof keyValue !== "string" || Object.prototype.hasOwnProperty.call(result, keyValue)) throw new Error("invalid YAML key at line " + line.line);
    const valueTextAtLine = line.text.slice(colon + 1).trim();
    index += 1;
    if (valueTextAtLine) {
      result[keyValue] = yamlScalar(valueTextAtLine);
      if (index < lines.length && lines[index].indent > indent) throw new Error("unexpected YAML child at line " + lines[index].line);
    } else if (index < lines.length && lines[index].indent > indent) {
      const nested = parseYamlBlock(lines, index, lines[index].indent);
      result[keyValue] = nested.value;
      index = nested.next;
    } else result[keyValue] = null;
  }
  return { value: result, next: index };
}

function parseLockfile(text: string): JsonRecord {
  const lines = yamlLines(text);
  if (lines.length === 0) throw new Error("empty pnpm lockfile");
  const parsed = parseYamlBlock(lines, 0, lines[0].indent);
  if (parsed.next !== lines.length || !isRecord(parsed.value)) throw new Error("incomplete pnpm lockfile parse");
  const root = parsed.value;
  if (root.lockfileVersion !== "9.0" || !isRecord(root.importers) || !isRecord(root.packages) || !isRecord(root.snapshots)) throw new Error("incomplete pnpm lockfile structure");
  for (const key of Object.keys(root)) if (!LOCKFILE_ROOT_KEYS.has(key)) throw new Error("unknown pnpm lockfile root key " + key);
  for (const [importer, importerValue] of Object.entries(root.importers)) {
    if (!isRecord(importerValue)) throw new Error("invalid lockfile importer " + importer);
    for (const [section, sectionValue] of Object.entries(importerValue)) {
      if (!LOCKFILE_IMPORTER_SECTIONS.has(section) || !isRecord(sectionValue)) throw new Error("invalid lockfile importer section " + section);
      for (const [name, entry] of Object.entries(sectionValue)) {
        if (!isRecord(entry) || typeof entry.specifier !== "string" || typeof entry.version !== "string") throw new Error("invalid lockfile importer entry " + name);
      }
    }
  }
  for (const [key, value] of Object.entries(root.packages)) {
    if (!isRecord(value)) throw new Error("invalid lockfile package " + key);
    if (value.resolution !== undefined && (!isRecord(value.resolution) || (value.resolution.integrity !== undefined && typeof value.resolution.integrity !== "string"))) throw new Error("invalid lockfile package resolution " + key);
  }
  for (const [key, value] of Object.entries(root.snapshots)) {
    if (!isRecord(value)) throw new Error("invalid lockfile snapshot " + key);
    for (const section of ["dependencies", "optionalDependencies"]) {
      if (value[section] !== undefined && (!isRecord(value[section]) || Object.values(value[section]).some((item) => typeof item !== "string"))) throw new Error("invalid lockfile snapshot dependency map " + key);
    }
  }
  for (const key of Object.keys(root.packages)) parsePnpmLocator(key, "lockfile package locator");
  for (const key of Object.keys(root.snapshots)) parsePnpmLocator(key, "lockfile snapshot locator");
  return root;
}

function mapAt(value: JsonValue, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error("invalid map " + label);
  return value;
}

function sectionSnapshotEqual(left: S4DependencySectionSnapshot, right: S4DependencySectionSnapshot): boolean {
  return canonical(left) === canonical(right);
}

type RawChange = {
  surface: S4RepositoryDelta["surface"];
  path: string;
  name: string | null;
  baseValue: string | null;
  candidateValue: string | null;
  lockKind?: "importer" | "package" | "snapshot" | "other";
  lockKey?: string;
};

function collectValueChanges(base: JsonValue, candidate: JsonValue, path: string, output: RawChange[], surface: RawChange["surface"], name: string | null): void {
  if (isRecord(base) && isRecord(candidate)) {
    for (const key of new Set([...Object.keys(base), ...Object.keys(candidate)])) collectValueChanges(base[key], candidate[key], path + "." + key, output, surface, name);
    return;
  }
  if (!equalValue(base, candidate)) output.push({ surface, path, name, baseValue: valueText(base), candidateValue: valueText(candidate) });
}

function manifestChanges(base: ParsedPackage, candidate: ParsedPackage): RawChange[] {
  const result: RawChange[] = [];
  for (const section of DEPENDENCY_SECTION_NAMES) {
    const baseValue = base.sections[section];
    const candidateValue = candidate.sections[section];
    if (Array.isArray(baseValue) || Array.isArray(candidateValue)) {
      if (!equalValue(baseValue, candidateValue)) result.push({ surface: section === "devDependencies" ? "test-only-dependency" : "production-runtime-dependency", path: "package.json." + section, name: null, baseValue: valueText(baseValue), candidateValue: valueText(candidateValue) });
      continue;
    }
    for (const name of new Set([...Object.keys(baseValue), ...Object.keys(candidateValue)])) {
      if (!equalValue(baseValue[name], candidateValue[name])) result.push({
        surface: section === "devDependencies" ? "test-only-dependency" : "production-runtime-dependency",
        path: "package.json." + section + "." + name,
        name,
        baseValue: valueText(baseValue[name]),
        candidateValue: valueText(candidateValue[name]),
      });
    }
  }
  const baseOther: JsonRecord = {};
  const candidateOther: JsonRecord = {};
  for (const [key, value] of Object.entries(base.root)) if (!(DEPENDENCY_SECTION_NAMES as readonly string[]).includes(key) && key !== "scripts") baseOther[key] = value;
  for (const [key, value] of Object.entries(candidate.root)) if (!(DEPENDENCY_SECTION_NAMES as readonly string[]).includes(key) && key !== "scripts") candidateOther[key] = value;
  collectValueChanges(baseOther, candidateOther, "package.json", result, "package-manifest", null);
  return result;
}

function lockChanges(base: JsonRecord, candidate: JsonRecord): RawChange[] {
  const result: RawChange[] = [];
  if (!equalValue(base.lockfileVersion, candidate.lockfileVersion)) result.push({ surface: "lockfile", path: "pnpm-lock.yaml.lockfileVersion", name: null, baseValue: valueText(base.lockfileVersion), candidateValue: valueText(candidate.lockfileVersion), lockKind: "other" });
  if (!equalValue(base.settings, candidate.settings)) collectValueChanges(base.settings, candidate.settings, "pnpm-lock.yaml.settings", result, "lockfile", null);
  const baseImporters = mapAt(base.importers, "base importers");
  const candidateImporters = mapAt(candidate.importers, "candidate importers");
  for (const importer of new Set([...Object.keys(baseImporters), ...Object.keys(candidateImporters)])) {
    const baseImporter = baseImporters[importer];
    const candidateImporter = candidateImporters[importer];
    if (!isRecord(baseImporter) || !isRecord(candidateImporter)) {
      if (!equalValue(baseImporter, candidateImporter)) result.push({ surface: "lockfile", path: "pnpm-lock.yaml.importers[" + JSON.stringify(importer) + "]", name: null, baseValue: valueText(baseImporter), candidateValue: valueText(candidateImporter), lockKind: "importer" });
      continue;
    }
    for (const section of new Set([...Object.keys(baseImporter), ...Object.keys(candidateImporter)])) {
      const baseSection = baseImporter[section];
      const candidateSection = candidateImporter[section];
      if (LOCKFILE_IMPORTER_SECTIONS.has(section) && isRecord(baseSection) && isRecord(candidateSection)) {
        for (const name of new Set([...Object.keys(baseSection), ...Object.keys(candidateSection)])) {
          if (!equalValue(baseSection[name], candidateSection[name])) result.push({ surface: "lockfile", path: "pnpm-lock.yaml.importers[" + JSON.stringify(importer) + "]." + section + "." + name, name, baseValue: valueText(baseSection[name]), candidateValue: valueText(candidateSection[name]), lockKind: "importer", lockKey: name });
        }
      } else if (!equalValue(baseSection, candidateSection)) collectValueChanges(baseSection, candidateSection, "pnpm-lock.yaml.importers[" + JSON.stringify(importer) + "]." + section, result, "lockfile", null);
    }
  }
  for (const section of ["packages", "snapshots"] as const) {
    const baseSection = mapAt(base[section], "base " + section);
    const candidateSection = mapAt(candidate[section], "candidate " + section);
    for (const key of new Set([...Object.keys(baseSection), ...Object.keys(candidateSection)])) {
      if (!equalValue(baseSection[key], candidateSection[key])) result.push({ surface: "lockfile", path: "pnpm-lock.yaml." + section + "." + key, name: key, baseValue: valueText(baseSection[key]), candidateValue: valueText(candidateSection[key]), lockKind: section === "packages" ? "package" : "snapshot", lockKey: key });
    }
  }
  for (const key of new Set([...Object.keys(base), ...Object.keys(candidate)])) if (!LOCKFILE_ROOT_KEYS.has(key) && !equalValue(base[key], candidate[key])) result.push({ surface: "lockfile", path: "pnpm-lock.yaml." + key, name: null, baseValue: valueText(base[key]), candidateValue: valueText(candidate[key]), lockKind: "other" });
  return result;
}

type Graph = {
  roots: Set<string>;
  snapshotKeys: Set<string>;
  packageKeys: Set<string>;
  entries: Map<string, { packageKey: string; packageValue: JsonValue; snapshotValue: JsonValue }>;
};

function resolvePackageKey(name: string, version: string, packages: JsonRecord): string {
  const requested = directLocator(name, version, "requested package locator");
  const candidates = Object.keys(packages).filter((key) => {
    const identity = parsePnpmLocator(key, "package locator");
    return identity.name === requested.name && identity.version === requested.version;
  });
  if (candidates.length !== 1) throw new Error("ambiguous or missing package locator " + name + "@" + version);
  return candidates[0];
}

function resolveSnapshotKey(name: string, version: string, snapshots: JsonRecord): string {
  const requested = parsePnpmLocator(name + "@" + version, "requested snapshot locator");
  const candidates = Object.keys(snapshots).filter((key) => locatorsEqual(parsePnpmLocator(key, "snapshot locator"), requested));
  if (candidates.length !== 1) throw new Error("ambiguous or missing snapshot locator " + name + "@" + version);
  return candidates[0];
}

function buildGraph(lock: JsonRecord, sectionName: "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies"): Graph {
  const importer = mapAt(mapAt(lock.importers, "importers")["."], "root importer");
  const packages = mapAt(lock.packages, "packages");
  const snapshots = mapAt(lock.snapshots, "snapshots");
  const rootsSection = importer[sectionName] === undefined ? {} : mapAt(importer[sectionName], "importer " + sectionName);
  const pending: Array<{ name: string; version: string }> = [];
  for (const [name, entry] of Object.entries(rootsSection)) pending.push({ name, version: checkedString(mapAt(entry, "importer entry").version, "importer version") });
  const roots = new Set<string>();
  for (const root of pending) roots.add(resolveSnapshotKey(root.name, root.version, snapshots));
  const snapshotKeys = new Set<string>();
  const packageKeys = new Set<string>();
  const entries = new Map<string, { packageKey: string; packageValue: JsonValue; snapshotValue: JsonValue }>();
  while (pending.length) {
    const next = pending.shift()!;
    const snapshotKey = resolveSnapshotKey(next.name, next.version, snapshots);
    const packageKey = resolvePackageKey(next.name, next.version, packages);
    if (snapshotKeys.has(snapshotKey)) continue;
    const packageValue = packages[packageKey];
    const snapshotValue = snapshots[snapshotKey];
    if (!isRecord(packageValue) || !isRecord(snapshotValue)) throw new Error("invalid graph entry " + snapshotKey);
    snapshotKeys.add(snapshotKey);
    packageKeys.add(packageKey);
    entries.set(snapshotKey, { packageKey, packageValue, snapshotValue });
    for (const dependencySection of ["dependencies", "optionalDependencies"] as const) {
      const children = snapshotValue[dependencySection];
      if (children === undefined) continue;
      for (const [name, version] of Object.entries(mapAt(children, "snapshot " + dependencySection))) pending.push({ name, version: checkedString(version, "snapshot dependency version") });
    }
  }
  return { roots, snapshotKeys, packageKeys, entries };
}

function rootLocator(lock: JsonRecord, name: string): PnpmLocator | null {
  const importer = mapAt(mapAt(lock.importers, "importers")["."], "root importer");
  const matches: PnpmLocator[] = [];
  for (const section of LOCKFILE_IMPORTER_SECTIONS) {
    const sectionValue = importer[section];
    if (sectionValue === undefined) continue;
    const entry = mapAt(sectionValue, "root importer " + section)[name];
    if (entry === undefined) continue;
    const version = checkedString(mapAt(entry, "root importer entry " + name).version, "root importer version " + name);
    matches.push(directLocator(name, version, "root peer locator"));
  }
  const unique = matches.filter((match, index) => matches.findIndex((other) => locatorsEqual(match, other)) === index);
  if (unique.length > 1) throw new Error("ambiguous root locator " + name);
  return unique[0] ?? null;
}

function snapshotDependencyLocator(snapshot: JsonRecord, name: string): PnpmLocator | null {
  const matches: PnpmLocator[] = [];
  for (const section of ["dependencies", "optionalDependencies"] as const) {
    const sectionValue = snapshot[section];
    if (sectionValue === undefined) continue;
    const version = mapAt(sectionValue, "snapshot " + section)[name];
    if (version === undefined) continue;
    matches.push(directLocator(name, checkedString(version, "snapshot dependency version " + name), "snapshot peer dependency locator"));
  }
  const unique = matches.filter((match, index) => matches.findIndex((other) => locatorsEqual(match, other)) === index);
  if (unique.length > 1) throw new Error("ambiguous snapshot dependency locator " + name);
  return unique[0] ?? null;
}

function peerContextConformant(
  directPackageKey: string,
  directPackage: JsonRecord,
  directSnapshotKey: string,
  directSnapshot: JsonRecord,
  candidateLock: JsonRecord,
  candidatePackages: JsonRecord,
  candidateSnapshots: JsonRecord,
  candidateDevGraph: Graph,
): boolean {
  const packageIdentity = parsePnpmLocator(directPackageKey, "authorized package identity");
  const snapshotIdentity = parsePnpmLocator(directSnapshotKey, "authorized snapshot identity");
  if (packageIdentity.peers.length !== 0 || packageIdentity.name !== snapshotIdentity.name || packageIdentity.version !== snapshotIdentity.version) return false;
  const peerDependencies = checkedStringMap(directPackage.peerDependencies, "authorized package peerDependencies");
  const peerMeta = checkedPeerMeta(directPackage.peerDependenciesMeta);
  if (Object.keys(peerMeta).some((name) => !Object.prototype.hasOwnProperty.call(peerDependencies, name))) return false;
  const contextByName = new Map<string, PnpmLocator>();
  for (const peer of snapshotIdentity.peers) {
    if (contextByName.has(peer.name) || !Object.prototype.hasOwnProperty.call(peerDependencies, peer.name)) return false;
    contextByName.set(peer.name, peer);
    const dependency = snapshotDependencyLocator(directSnapshot, peer.name);
    if (!dependency || !locatorsEqual(dependency, peer)) return false;
    const root = rootLocator(candidateLock, peer.name);
    if (!root || !locatorsEqual(root, peer)) return false;
    const peerSnapshotKey = resolveSnapshotKey(peer.name, peer.version, candidateSnapshots);
    const peerPackageKey = resolvePackageKey(peer.name, peer.version, candidatePackages);
    if (!candidateDevGraph.snapshotKeys.has(peerSnapshotKey) || !candidateDevGraph.packageKeys.has(peerPackageKey)) return false;
  }
  for (const peerName of Object.keys(peerDependencies)) {
    const dependency = snapshotDependencyLocator(directSnapshot, peerName);
    const optional = peerMeta[peerName]?.optional === true;
    if (!optional && !contextByName.has(peerName)) return false;
    if (dependency && !contextByName.has(peerName)) return false;
  }
  return true;
}

function graphEqual(base: Graph, candidate: Graph): boolean {
  if (canonical(Array.from(base.roots).sort()) !== canonical(Array.from(candidate.roots).sort())) return false;
  if (canonical(Array.from(base.snapshotKeys).sort()) !== canonical(Array.from(candidate.snapshotKeys).sort())) return false;
  if (canonical(Array.from(base.packageKeys).sort()) !== canonical(Array.from(candidate.packageKeys).sort())) return false;
  for (const key of base.snapshotKeys) {
    const left = base.entries.get(key);
    const right = candidate.entries.get(key);
    if (!left || !right || left.packageKey !== right.packageKey || !equalValue(left.packageValue, right.packageValue) || !equalValue(left.snapshotValue, right.snapshotValue)) return false;
  }
  return true;
}

function allImportFacts(sourceFiles: Record<string, string>, packageName: string): Array<{ file: string; line: number }> {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp("(?:\\bimport\\s+(?:[^\"'\\n]+?\\s+from\\s+)?|\\bimport\\s*\\(\\s*|\\brequire\\s*\\(\\s*)[\"']" + escaped + "[\"']", "g");
  const result: Array<{ file: string; line: number }> = [];
  for (const [rawPath, text] of Object.entries(sourceFiles)) {
    const file = rawPath.replace(/\\/g, "/");
    for (const match of text.matchAll(pattern)) result.push({ file, line: text.slice(0, match.index ?? 0).split(/\r?\n/).length });
  }
  return result;
}

function allowedPath(file: string, surfaces: string[]): boolean {
  return surfaces.some((surface) => surface.endsWith("/**") ? file.startsWith(surface.slice(0, -2)) : file === surface);
}

function productionImport(importFact: { file: string; line: number }): boolean {
  return importFact.file.startsWith("app/") || importFact.file.startsWith("src/") || !importFact.file.startsWith("tests/");
}

function authorityFacts(authority: S4DependencyAuthority): string[] {
  return [
    "authorityRefs=" + authority.authorityRefs.join(","),
    "requiredAuthorityRef=" + authority.requiredAuthorityRef,
    "authorizedPackage=" + authority.packageName + "@" + authority.packageVersion,
    "manifestPath=" + authority.manifestPath,
    "authorizedPurpose=" + authority.purpose,
    "allowedImportSurface=" + authority.allowedImportSurface.join(","),
    "comparisonBaselineSha=" + authority.baselineSha,
    "comparisonBaselineTree=" + authority.baselineTree,
  ];
}

function validAuthority(authority: S4DependencyAuthority): boolean {
  return Boolean(authority.packageName && authority.packageVersion && authority.purpose && authority.manifestPath === "devDependencies" && authority.authorityRefs.includes(authority.requiredAuthorityRef) && authority.allowedImportSurface.length > 0 && /^[0-9a-f]{40}$/.test(authority.baselineSha) && /^[0-9a-f]{40}$/.test(authority.baselineTree));
}

function lockPathFacts(changes: RawChange[]): string[] {
  return changes.filter((change) => change.lockKind === "package" || change.lockKind === "snapshot").map((change) => change.path + "=" + (change.candidateValue ?? "null"));
}

function buildDependencyAudit(input: S4RepositoryAuditInput, base: ParsedPackage, candidate: ParsedPackage, baseLock: JsonRecord, candidateLock: JsonRecord): S4DependencyAudit {
  const baseManifestSha256 = sha256(Buffer.from(input.basePackageText, "utf8"));
  const candidateManifestSha256 = sha256(Buffer.from(input.candidatePackageText, "utf8"));
  const baseLockfileSha256 = sha256(Buffer.from(input.baseLockfileText, "utf8"));
  const candidateLockfileSha256 = sha256(Buffer.from(input.candidateLockfileText, "utf8"));
  const manifestDelta = manifestChanges(base, candidate);
  const lockDelta = lockChanges(baseLock, candidateLock);
  if (baseLockfileSha256 !== candidateLockfileSha256 && lockDelta.length === 0) lockDelta.push({ surface: "lockfile", path: "pnpm-lock.yaml", name: null, baseValue: baseLockfileSha256, candidateValue: candidateLockfileSha256, lockKind: "other" });

  const baseImporter = mapAt(mapAt(baseLock.importers, "base importers")["."], "base root importer");
  const candidateImporter = mapAt(mapAt(candidateLock.importers, "candidate importers")["."], "candidate root importer");
  const baseProductionImporter = Object.fromEntries(["dependencies", "optionalDependencies", "peerDependencies"].map((key) => [key, baseImporter[key] ?? {}]));
  const candidateProductionImporter = Object.fromEntries(["dependencies", "optionalDependencies", "peerDependencies"].map((key) => [key, candidateImporter[key] ?? {}]));
  const baseProductionGraph = buildGraph(baseLock, "dependencies");
  const candidateProductionGraph = buildGraph(candidateLock, "dependencies");
  const baseOptionalGraph = buildGraph(baseLock, "optionalDependencies");
  const candidateOptionalGraph = buildGraph(candidateLock, "optionalDependencies");
  const basePeerGraph = buildGraph(baseLock, "peerDependencies");
  const candidatePeerGraph = buildGraph(candidateLock, "peerDependencies");
  const productionGraphUnchanged = sectionSnapshotEqual(
    { ...base.sections, devDependencies: {} },
    { ...candidate.sections, devDependencies: {} },
  ) && canonical(baseProductionImporter) === canonical(candidateProductionImporter)
    && graphEqual(baseProductionGraph, candidateProductionGraph)
    && graphEqual(baseOptionalGraph, candidateOptionalGraph)
    && graphEqual(basePeerGraph, candidatePeerGraph);

  const authority = input.dependencyAuthority;
  const authorityIsValid = validAuthority(authority);
  const devManifestDelta = manifestDelta.filter((change) => change.surface === "test-only-dependency");
  const exactDevDelta = devManifestDelta.length === 1
    && manifestDelta.every((change) => change.surface === "test-only-dependency")
    && devManifestDelta[0].path === "package.json.devDependencies." + authority.packageName
    && devManifestDelta[0].baseValue === authority.baseManifestValue
    && devManifestDelta[0].candidateValue === authority.packageVersion
    && candidate.sections.devDependencies[authority.packageName] === authority.packageVersion;

  const candidateDevGraph = buildGraph(candidateLock, "devDependencies");
  const basePackages = mapAt(baseLock.packages, "base packages");
  const candidatePackages = mapAt(candidateLock.packages, "candidate packages");
  const baseSnapshots = mapAt(baseLock.snapshots, "base snapshots");
  const candidateSnapshots = mapAt(candidateLock.snapshots, "candidate snapshots");
  const newDevPackageKeys = new Set(Array.from(candidateDevGraph.packageKeys).filter((key) => !Object.prototype.hasOwnProperty.call(basePackages, key)));
  const newDevSnapshotKeys = new Set(Array.from(candidateDevGraph.snapshotKeys).filter((key) => !Object.prototype.hasOwnProperty.call(baseSnapshots, key)));
  const actualPackageChanges = new Set(lockDelta.filter((change) => change.lockKind === "package").map((change) => change.lockKey));
  const actualSnapshotChanges = new Set(lockDelta.filter((change) => change.lockKind === "snapshot").map((change) => change.lockKey));
  const exactPackageChanges = canonical(Array.from(actualPackageChanges).sort()) === canonical(Array.from(newDevPackageKeys).sort());
  const exactSnapshotChanges = canonical(Array.from(actualSnapshotChanges).sort()) === canonical(Array.from(newDevSnapshotKeys).sort());
  const importerPath = "pnpm-lock.yaml.importers[\".\"].devDependencies." + authority.packageName;
  const importerChange = lockDelta.filter((change) => change.lockKind === "importer" && change.path === importerPath);
  const unrelatedLockChanges = lockDelta.filter((change) => !((change.lockKind === "importer" && change.path === importerPath) || (change.lockKind === "package" && newDevPackageKeys.has(change.lockKey ?? "")) || (change.lockKind === "snapshot" && newDevSnapshotKeys.has(change.lockKey ?? ""))));
  const candidateDevMap = mapAt(candidateImporter.devDependencies, "candidate devDependencies");
  const candidateDevEntryValue = candidateDevMap[authority.packageName];
  if (candidateDevEntryValue === undefined) throw new Error("missing authorized importer entry");
  const candidateDevEntry = mapAt(candidateDevEntryValue, "candidate dependency entry");
  const candidateDevVersion = checkedString(candidateDevEntry.version, "candidate dev version");
  const candidateDevSpecifier = checkedString(candidateDevEntry.specifier, "candidate dev specifier");
  const candidateDevLocator = directLocator(authority.packageName, candidateDevVersion, "candidate importer locator");
  const exactImporterEntryShape = canonical(Object.keys(candidateDevEntry).sort()) === canonical(["specifier", "version"]);
  const exactImporter = importerChange.length === 1
    && exactImporterEntryShape
    && candidateDevSpecifier === authority.packageVersion
    && candidateDevLocator.name === authority.packageName
    && candidateDevLocator.version === authority.packageVersion;
  const directPackageKey = resolvePackageKey(authority.packageName, authority.packageVersion, candidatePackages);
  const directPackage = mapAt(candidatePackages[directPackageKey], "authorized package entry");
  const directResolution = mapAt(directPackage.resolution, "authorized package resolution");
  const directPackageIdentity = parsePnpmLocator(directPackageKey, "authorized package identity");
  const directSnapshotKey = resolveSnapshotKey(authority.packageName, candidateDevVersion, candidateSnapshots);
  const directSnapshot = mapAt(candidateSnapshots[directSnapshotKey], "authorized snapshot entry");
  const directSnapshotIdentity = parsePnpmLocator(directSnapshotKey, "authorized snapshot identity");
  const exactPackageIdentity = directPackageIdentity.name === authority.packageName
    && directPackageIdentity.version === authority.packageVersion
    && directPackageIdentity.peers.length === 0;
  const importerSnapshotIdentityMatch = locatorsEqual(candidateDevLocator, directSnapshotIdentity);
  const peerContextIsConformant = peerContextConformant(
    directPackageKey,
    directPackage,
    directSnapshotKey,
    directSnapshot,
    candidateLock,
    candidatePackages,
    candidateSnapshots,
    candidateDevGraph,
  );
  const exactResolvedIdentity = exactPackageIdentity && importerSnapshotIdentityMatch && peerContextIsConformant;
  const integrityKeys = Array.from(newDevPackageKeys).every((key) => {
    const resolution = mapAt(candidatePackages[key], "new package resolution " + key).resolution;
    return isRecord(resolution) && validSha512Integrity(resolution.integrity);
  });
  const snapshotKeysPresent = Array.from(newDevSnapshotKeys).every((key) => isRecord(candidateSnapshots[key]));
  const exactIntegrity = validSha512Integrity(directResolution.integrity) && isRecord(directSnapshot) && integrityKeys && snapshotKeysPresent;
  const imports = allImportFacts(input.sourceFiles, authority.packageName);
  const runtimeImports = imports.filter(productionImport);
  const unauthorizedImports = imports.filter((item) => !allowedPath(item.file, authority.allowedImportSurface));
  const importReachabilityConformant = imports.length > 0 && runtimeImports.length === 0 && unauthorizedImports.length === 0;
  const candidateProductionKeys = new Set([
    ...candidateProductionGraph.snapshotKeys,
    ...candidateOptionalGraph.snapshotKeys,
    ...candidatePeerGraph.snapshotKeys,
    ...candidateProductionGraph.packageKeys,
    ...candidateOptionalGraph.packageKeys,
    ...candidatePeerGraph.packageKeys,
  ]);
  const newDevOnlyKeysAbsentFromProduction = Array.from(new Set([...newDevPackageKeys, ...newDevSnapshotKeys])).every((key) => !candidateProductionKeys.has(key));
  const testOnlyRuntimeReachabilityAbsent = importReachabilityConformant && newDevOnlyKeysAbsentFromProduction && !candidateProductionKeys.has(directPackageKey) && !candidateProductionKeys.has(directSnapshotKey);
  const lockConformant = exactImporter && exactResolvedIdentity && exactPackageChanges && exactSnapshotChanges && unrelatedLockChanges.length === 0 && exactIntegrity && lockDelta.length === 1 + newDevPackageKeys.size + newDevSnapshotKeys.size;
  const authorized = authorityIsValid && exactDevDelta && lockConformant && productionGraphUnchanged && testOnlyRuntimeReachabilityAbsent;
  const hasKnownDelta = manifestDelta.length > 0 || lockDelta.length > 0;
  const disposition: S4DeltaDisposition = !hasKnownDelta ? "unchanged" : authorized ? "changed_authorized_conformant" : "changed_unauthorized_nonconformant";
  const facts = [
    ...authorityFacts(authority),
    "baseManifestSha256=" + baseManifestSha256,
    "candidateManifestSha256=" + candidateManifestSha256,
    "baseLockfileSha256=" + baseLockfileSha256,
    "candidateLockfileSha256=" + candidateLockfileSha256,
    "productionGraphUnchanged=" + productionGraphUnchanged,
    "testOnlyRuntimeReachabilityAbsent=" + testOnlyRuntimeReachabilityAbsent,
    "runtimeImports=" + runtimeImports.map((item) => item.file + ":" + item.line).join(","),
    "allAuthorizedPackageImports=" + imports.map((item) => item.file + ":" + item.line).join(","),
    "newDevPackageKeys=" + Array.from(newDevPackageKeys).sort().join(","),
    "newDevSnapshotKeys=" + Array.from(newDevSnapshotKeys).sort().join(","),
    "lockfileDeltaPaths=" + lockPathFacts(lockDelta).join("|"),
    "candidateImporterLocator=" + canonical(locatorShape(candidateDevLocator)),
    "resolvedPackageLocator=" + canonical(locatorShape(directPackageIdentity)),
    "resolvedSnapshotLocator=" + canonical(locatorShape(directSnapshotIdentity)),
    "importerSnapshotIdentityMatch=" + importerSnapshotIdentityMatch,
    "peerContextIsConformant=" + peerContextIsConformant,
    "exactResolvedIdentity=" + exactResolvedIdentity,
    "integrityIsConformant=" + exactIntegrity,
    "lockConformant=" + lockConformant,
  ];
  const deltas = [...manifestDelta, ...lockDelta].map((change) => {
    const conformant = authorized && (change.surface === "test-only-dependency" || change.surface === "lockfile");
    return {
      surface: change.surface,
      path: change.path,
      name: change.name,
      baseValue: change.baseValue,
      candidateValue: change.candidateValue,
      disposition: conformant ? "changed_authorized_conformant" : "changed_unauthorized_nonconformant",
      purpose: conformant ? authority.purpose : null,
      authorityRefs: conformant ? Array.from(authority.authorityRefs) : [],
      evidenceFacts: [...facts, "deltaPath=" + change.path, "deltaBaseValue=" + (change.baseValue ?? "null"), "deltaCandidateValue=" + (change.candidateValue ?? "null")],
    } satisfies S4RepositoryDelta;
  });
  return {
    auditState: "complete",
    packageManifestPath: "package.json",
    lockfilePath: "pnpm-lock.yaml",
    baseManifestSha256,
    candidateManifestSha256,
    baseLockfileSha256,
    candidateLockfileSha256,
    baseDependencySections: base.sections,
    candidateDependencySections: candidate.sections,
    productionGraphUnchanged,
    testOnlyRuntimeReachabilityAbsent,
    deltas,
    disposition,
  };
}

function scriptChanges(base: Record<string, string>, candidate: Record<string, string>): string[] {
  return Array.from(new Set([...Object.keys(base), ...Object.keys(candidate)])).filter((key) => base[key] !== candidate[key]).sort();
}

function buildScriptAudit(input: S4RepositoryAuditInput, base: ParsedPackage, candidate: ParsedPackage): S4ScriptAudit {
  const changed = scriptChanges(base.scripts, candidate.scripts);
  const authority = input.scriptAuthority;
  const requiredValidationComplete = authority.requiredValidationLabels.every((label) => authority.executedRequiredValidation.some((item) => item === label || item.startsWith(label + "=")));
  const exactAuthorizedChange = changed.length === 1
    && changed[0] === authority.scriptName
    && base.scripts[authority.scriptName] === authority.baseValue
    && candidate.scripts[authority.scriptName] === authority.candidateValue
    && authority.authorityRefs.includes(authority.requiredAuthorityRef)
    && authority.purpose.length > 0
    && authority.removedRequiredValidation.length === 0
    && requiredValidationComplete;
  const disposition: S4DeltaDisposition = changed.length === 0 ? "unchanged" : exactAuthorizedChange ? "changed_authorized_conformant" : "changed_unauthorized_nonconformant";
  const facts = [
    "completeMapEqual=" + (changed.length === 0),
    "authorityRefs=" + authority.authorityRefs.join(","),
    "requiredAuthorityRef=" + authority.requiredAuthorityRef,
    "authorizedPurpose=" + authority.purpose,
    "removedRequiredValidation=" + authority.removedRequiredValidation.join(","),
    "executedRequiredValidation=" + authority.executedRequiredValidation.join(","),
    "requiredValidationComplete=" + requiredValidationComplete,
    "changedScriptNames=" + changed.join(","),
  ];
  const changedScripts = changed.map((scriptName) => {
    const conformant = exactAuthorizedChange && scriptName === authority.scriptName;
    return {
      scriptName,
      baseValue: valueText(base.scripts[scriptName]),
      candidateValue: valueText(candidate.scripts[scriptName]),
      disposition: conformant ? "changed_authorized_conformant" : "changed_unauthorized_nonconformant",
      purpose: conformant ? authority.purpose : null,
      authorityRefs: conformant ? Array.from(authority.authorityRefs) : [],
      preservedRequiredValidation: conformant ? Array.from(authority.preservedRequiredValidation) : [],
      removedRequiredValidation: conformant ? Array.from(authority.removedRequiredValidation) : [],
      executedRequiredValidation: conformant ? Array.from(authority.executedRequiredValidation) : [],
      evidenceFacts: [...facts, "scriptName=" + scriptName, "baseValue=" + (base.scripts[scriptName] ?? "null"), "candidateValue=" + (candidate.scripts[scriptName] ?? "null")],
    } satisfies S4ScriptDelta;
  });
  return {
    auditState: "complete",
    baseScripts: base.scripts,
    candidateScripts: candidate.scripts,
    completeMapEqual: changed.length === 0,
    changedScripts,
    disposition,
  };
}

function incompleteDependencyAudit(input: S4RepositoryAuditInput, baseSections: S4DependencySectionSnapshot = EMPTY_DEPENDENCY_SECTIONS, candidateSections: S4DependencySectionSnapshot = EMPTY_DEPENDENCY_SECTIONS): S4DependencyAudit {
  return {
    auditState: "incomplete",
    packageManifestPath: "package.json",
    lockfilePath: "pnpm-lock.yaml",
    baseManifestSha256: sha256(Buffer.from(input.basePackageText, "utf8")),
    candidateManifestSha256: sha256(Buffer.from(input.candidatePackageText, "utf8")),
    baseLockfileSha256: sha256(Buffer.from(input.baseLockfileText, "utf8")),
    candidateLockfileSha256: sha256(Buffer.from(input.candidateLockfileText, "utf8")),
    baseDependencySections: baseSections,
    candidateDependencySections: candidateSections,
    productionGraphUnchanged: false,
    testOnlyRuntimeReachabilityAbsent: false,
    deltas: [],
    disposition: null,
  };
}

function incompleteScriptAudit(baseScripts: Record<string, string> = {}, candidateScripts: Record<string, string> = {}): S4ScriptAudit {
  return { auditState: "incomplete", baseScripts, candidateScripts, completeMapEqual: false, changedScripts: [], disposition: null };
}

export function auditRepositorySurfaces(input: S4RepositoryAuditInput): S4RepositoryAudit {
  let basePackage: ParsedPackage | null = null;
  let candidatePackage: ParsedPackage | null = null;
  let baseLock: JsonRecord | null = null;
  let candidateLock: JsonRecord | null = null;
  try { basePackage = parsePackage(input.basePackageText); } catch { basePackage = null; }
  try { candidatePackage = parsePackage(input.candidatePackageText); } catch { candidatePackage = null; }
  try { baseLock = parseLockfile(input.baseLockfileText); } catch { baseLock = null; }
  try { candidateLock = parseLockfile(input.candidateLockfileText); } catch { candidateLock = null; }
  const dependencyAudit = basePackage && candidatePackage && baseLock && candidateLock
    ? (() => { try { return buildDependencyAudit(input, basePackage!, candidatePackage!, baseLock!, candidateLock!); } catch { return incompleteDependencyAudit(input, basePackage!.sections, candidatePackage!.sections); } })()
    : incompleteDependencyAudit(input, basePackage?.sections, candidatePackage?.sections);
  const scriptAudit = basePackage && candidatePackage
    ? (() => { try { return buildScriptAudit(input, basePackage!, candidatePackage!); } catch { return incompleteScriptAudit(); } })()
    : incompleteScriptAudit(basePackage?.scripts, candidatePackage?.scripts);
  return { dependencyAudit, scriptAudit };
}
