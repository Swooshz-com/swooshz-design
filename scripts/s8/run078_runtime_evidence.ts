import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

type Mount = { source: string; target: string; kind: "file" | "directory"; observed: string[]; consumer: string };
type SpawnRecord = { command: string; args: string[]; cwd: string; environment: Record<string, string>; status: number | null; stdoutBytes: number; stderrBytes: number; stdoutSha256: string; stderrSha256: string };
type Options = { runner: string; validator: string; blenderRoot: string; writer: string; privateWorkRoot: string; evidenceRoot: string; blenderArchive: string; bwrapSha256: string };

const controlledKeys = ["S8_TEST_PARENT_SECRET_A", "S8_TEST_PARENT_SECRET_B", "PATH", "HOME", "LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH", "PYTHONHOME"] as const;
const secretSentinels = { S8_TEST_PARENT_SECRET_A: "RUN078_SYNTHETIC_SENTINEL_A", S8_TEST_PARENT_SECRET_B: "RUN078_SYNTHETIC_SENTINEL_B" };
const hostileValues: Record<string, string> = {
  PATH: "/run078/hostile/bin",
  HOME: "/run078/hostile/home",
  LD_PRELOAD: "/run078/hostile/lib/ld-preload.so",
  LD_LIBRARY_PATH: "/run078/hostile/lib",
  PYTHONPATH: "/run078/hostile/python",
  PYTHONHOME: "/run078/hostile/python-home",
};
const expectedBlenderArchiveSha256 = "84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168";
const broadUpperBound = ["/usr", "/lib", "/lib64", "/etc"];
const evidence: string[] = [];
const shimManifests: string[] = [];
const limitationSet = new Set<string>();

function emit(line: string): void {
  evidence.push(line);
  process.stdout.write(`${line}\n`);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeText(value: string, limit = 900): string {
  const clean = value
    .replace(/(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/gu, "[REDACTED]")
    .replace(/(Authorization\s*:\s*)[^\r\n]*/giu, "$1[REDACTED]")
    .replace(/[\r\n]+/gu, " ")
    .replace(/[^\x20-\x7e]/gu, " ");
  return clean.length > limit ? `${clean.slice(0, limit)}[TRUNCATED]` : clean || "<empty>";
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("RUN078_ARGUMENT_INVALID");
    values.set(key.slice(2), value);
  }
  const required = ["runner", "validator", "blender-root", "writer", "private-work-root", "evidence-root", "blender-archive", "bwrap-sha256"];
  for (const key of required) if (!values.has(key)) throw new Error(`RUN078_ARGUMENT_MISSING_${key.toUpperCase().replaceAll("-", "_")}`);
  return {
    runner: resolve(values.get("runner")!), validator: resolve(values.get("validator")!),
    blenderRoot: resolve(values.get("blender-root")!), writer: resolve(values.get("writer")!), privateWorkRoot: resolve(values.get("private-work-root")!),
    evidenceRoot: resolve(values.get("evidence-root")!), blenderArchive: resolve(values.get("blender-archive")!),
    bwrapSha256: values.get("bwrap-sha256")!,
  };
}

function envClassifications(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of controlledKeys) {
    const value = env?.[key];
    if (value === undefined) result[key] = "ABSENT";
    else if (key in secretSentinels && value === secretSentinels[key as keyof typeof secretSentinels]) result[key] = "SYNTHETIC_SENTINEL_PRESENT";
    else if (hostileValues[key] !== undefined && value === hostileValues[key]) result[key] = "CONTROLLED_HOSTILE_PRESENT";
    else if (key === "PATH" || key === "HOME" || key === "LD_PRELOAD" || key === "LD_LIBRARY_PATH" || key === "PYTHONPATH" || key === "PYTHONHOME") result[key] = "FIXED_TEST_VALUE_PRESENT";
    else result[key] = "PRESENT_UNCLASSIFIED";
  }
  return result;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function readJson(path: string): Record<string, unknown> | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { return undefined; }
}

function runCommand(command: string, args: string[], cwd?: string): { status: number; stdout: string; stderr: string } {
  const result = rawSpawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 30_000, windowsHide: true });
  return { status: result.status ?? (result.error ? 127 : 1), stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

const require = createRequire(join(process.cwd(), "package.json"));
const childProcess = require("node:child_process") as typeof import("node:child_process");
const moduleApi = require("node:module") as typeof import("node:module");
const rawSpawnSync = childProcess.spawnSync.bind(childProcess);

let activeShimPath = "";

function writeShim(options: Options, name: string, settings: Record<string, unknown>): string {
  const path = join(options.evidenceRoot, `${name}.js`);
  const settingsText = JSON.stringify(settings);
  const source = `#!${process.execPath}\n` + `const fs=require("node:fs");const os=require("node:os");const path=require("node:path");const cp=require("node:child_process");const crypto=require("node:crypto");\n` +
    `const s=${settingsText};const argv=process.argv.slice(2);const sha=(v)=>crypto.createHash("sha256").update(v).digest("hex");const canon=(v)=>Array.isArray(v)?"["+v.map(canon).join(",")+"]":v&&typeof v==="object"?"{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+canon(v[k])).join(",")+"}":JSON.stringify(v);\n` +
    `const controlled=["S8_TEST_PARENT_SECRET_A","S8_TEST_PARENT_SECRET_B","PATH","HOME","LD_PRELOAD","LD_LIBRARY_PATH","PYTHONPATH","PYTHONHOME"];const secretValues={S8_TEST_PARENT_SECRET_A:"RUN078_SYNTHETIC_SENTINEL_A",S8_TEST_PARENT_SECRET_B:"RUN078_SYNTHETIC_SENTINEL_B"};const hostileValues={PATH:"/run078/hostile/bin",HOME:"/run078/hostile/home",LD_PRELOAD:"/run078/hostile/lib/ld-preload.so",LD_LIBRARY_PATH:"/run078/hostile/lib",PYTHONPATH:"/run078/hostile/python",PYTHONHOME:"/run078/hostile/python-home"};const environment=(pid)=>{try{const values={};for(const entry of fs.readFileSync("/proc/"+pid+"/environ").toString().split("\\0").filter(Boolean)){const i=entry.indexOf("=");if(i>0)values[entry.slice(0,i)]=entry.slice(i+1);}const keys=Object.keys(values).sort();const classifications={};for(const k of controlled){const v=values[k];classifications[k]=v===undefined?"ABSENT":Object.prototype.hasOwnProperty.call(secretValues,k)?(v===secretValues[k]?"SYNTHETIC_SENTINEL_PRESENT":"CONTROLLED_SECRET_KEY_PRESENT"):v===hostileValues[k]?"CONTROLLED_HOSTILE_PRESENT":(k==="PATH"||k==="HOME"||k==="LD_PRELOAD"||k==="LD_LIBRARY_PATH"||k==="PYTHONPATH"||k==="PYTHONHOME"?"FIXED_TEST_VALUE_PRESENT":"PRESENT_UNCLASSIFIED");}return {keys,classifications};}catch{return null;}};\n` +
    `const stat=(pid)=>{try{const t=fs.readFileSync("/proc/"+pid+"/stat","utf8");const i=t.lastIndexOf(")");const a=t.slice(i+2).trim().split(/\\s+/);return Number(a[1]);}catch{return null;}};const executable=(pid)=>{try{return fs.readlinkSync("/proc/"+pid+"/exe").replace(/ \\(deleted\\)$/," ").trim();}catch{return "";}};const maps=(pid)=>{try{return fs.readFileSync("/proc/"+pid+"/maps","utf8").split("\\n").map(x=>x.trim().split(/\\s+/).slice(5).join(" ")).filter(x=>x.startsWith("/")).map(x=>x.replace(/ \\(deleted\\)$/,""));}catch{return [];}};\n` +
    `const roots=[];const observations=[];let childPid=null;const poll=()=>{if(!childPid)return;let ids=[];try{ids=fs.readdirSync("/proc").filter(x=>/^\\d+$/.test(x));}catch{return;}const family=new Set([childPid]);let changed=true;while(changed){changed=false;for(const x of ids){const p=Number(x);if(family.has(p))continue;const parent=stat(p);if(parent!==null&&family.has(parent)){family.add(p);changed=true;}}}for(const x of family){const p=Number(x);const binary=executable(p);if(!binary)continue;for(const needle of (s.targetNeedles||[])){if(binary===needle&&!roots.some(z=>z.pid===p)){const env=environment(p);const ls=maps(p);const row={pid:p,needle,executablePath:binary,environmentKeys:env?env.keys:null,environmentClassifications:env?env.classifications:null,mappedFiles:Array.from(new Set(ls)).filter(x=>/\\.so(?:\\.|$)/.test(x)).sort()};roots.push(row);}}}};\n` +
    `let effective=argv.slice();let bwrapCommand="/usr/bin/bwrap";let prefix=[];if(s.kind==="validator-replay"){prefix=s.baseArgs||[];effective=[...prefix,...argv];}else{const commandIndex=effective.findIndex((x,i)=>x==="/runtime/process-runner"&&effective[i+1]==="--address-space-bytes");if(commandIndex<0){console.error("RUN078_SHIM_BWRAP_COMMAND_MISSING");process.exit(125);}const additions=[...(s.mountArgs||[]),...(s.environmentArgs||[])];effective.splice(commandIndex,0,...additions);}\n` +
    `if(Buffer.byteLength(canon(argv))+Buffer.byteLength(canon(effective))>65536){console.error("RUN078_SHIM_ARGV_LIMIT");process.exit(125);}const envKeys={};for(const k of controlled){const v=process.env[k];envKeys[k]=v===undefined?"ABSENT":(k.startsWith("S8_TEST_PARENT_SECRET_")?"SYNTHETIC_SENTINEL_PRESENT":"CONTROLLED_VALUE_PRESENT");}\n` +
    `let launchArgs=["-n",bwrapCommand,...effective];if(s.tracePath){launchArgs=["-n","/usr/bin/strace","-f","-qq","-s","4096","-e","trace=%file","-o",s.tracePath,"--",bwrapCommand,...effective];}\n` +
    `const manifest={schema:"s8-run078-shim-v1",mode:s.mode||"unspecified",originalArgv:argv,effectiveBwrapArgv:effective,originalArgvSha256:sha(canon(argv)),effectiveBwrapArgvSha256:sha(canon(effective)),injectedRuntimeMounts:s.mountArgs||[],environmentArgs:s.environmentArgs||[],environmentClassifications:envKeys,tracePath:s.tracePath||null,privilegedCommand:"sudo -n "+(s.tracePath?"strace ... /usr/bin/bwrap":"/usr/bin/bwrap"),targetObservations:roots};const child=cp.spawn("/usr/bin/sudo",launchArgs,{stdio:["ignore","pipe","pipe"]});childPid=child.pid||null;let out=[],err=[],outN=0,errN=0;const limit=4*1024*1024;child.stdout.on("data",b=>{outN+=b.length;if(outN<=limit)out.push(b);});child.stderr.on("data",b=>{errN+=b.length;if(errN<=limit)err.push(b);});const timer=setInterval(poll,5);child.on("error",e=>{clearInterval(timer);manifest.spawnError=String(e.code||"SPAWN_FAILED");finish(null,"SIGTERM");});child.on("close",(code,signal)=>{clearInterval(timer);finish(code,signal);});function finish(code,signal){manifest.targetObservations=roots;manifest.status=code;manifest.signal=signal;manifest.stdoutBytes=outN;manifest.stderrBytes=errN;manifest.stderrText=Buffer.concat(err).toString("utf8").slice(0,4096).replace(/(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,"[REDACTED]").replace(/[\\r\\n]+/g," ");const text=JSON.stringify(manifest,null,2)+"\\n";fs.writeFileSync(s.manifestPath,text,{mode:0o600});process.stdout.write(Buffer.concat(out));process.stderr.write(Buffer.concat(err));process.exitCode=code===null?1:code;}\n`;
  const supervisedSource = source
    .replace('stdio:["ignore","pipe","pipe"]', 'stdio:["ignore","pipe","pipe"],detached:true')
    .replace('const timer=setInterval(poll,5);', 'const timer=setInterval(poll,5);const run078Timeout=setTimeout(()=>{manifest.timedOut=true;try{process.kill(-childPid,"SIGTERM");}catch{try{child.kill("SIGTERM");}catch{}}const killer=setTimeout(()=>{try{process.kill(-childPid,"SIGKILL");}catch{try{child.kill("SIGKILL");}catch{}}},4000);killer.unref();},s.timeoutMs||305000);run078Timeout.unref();child.once("close",()=>clearTimeout(run078Timeout));');
  if (supervisedSource === source) throw new Error("RUN078_SHIM_SUPERVISION_TEMPLATE_MISMATCH");
  new Function(supervisedSource.slice(supervisedSource.indexOf("\n") + 1));
  writeFileSync(path, supervisedSource, { mode: 0o700, flag: "wx" });
  chmodSync(path, 0o700);
  return path;
}

function readShim(path: string): Record<string, unknown> | undefined { return readJson(path); }

function mkdirSecure(path: string): void { mkdirSync(path, { recursive: true, mode: 0o700 }); }

function fixtureSources(): { s6: Record<string, unknown>; s7: Record<string, unknown> } {
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);
  const projectId = "11111111-1111-4111-8111-111111111111";
  const objectId = "22222222-2222-4222-8222-222222222222";
  const s6 = {
    schemaVersion: "s6-to-s7-handoff-v1", projectId, acceptedRevisionId: objectId, acceptedRevisionHash: hashA,
    sourceS5Fingerprint: hashB, spatialSchemaVersion: "s6-spatial-model-v1", units: "millimetres",
    coordinateConvention: { version: "booth-local-right-handed-v1", units: "millimetres", handedness: "right-handed", origin: "north-west-floor-corner", xAxis: "east", yAxis: "up", zAxis: "south" },
    booth: { widthMm: 6000, depthMm: 6000, openSides: ["north"], maxHeightMm: 4000, heightState: "known" },
    objects: [{ objectId: "run078-object", identityKey: "run078-object", parentObjectId: null, objectType: "box", role: "furniture",
      geometry: { kind: "rect_prism", dimensionsMm: { widthMm: 1200, depthMm: 600, heightMm: 901 }, geometryState: "exact", localAnchor: "center" },
      footprint: { kind: "rectangle", widthMm: 1200, depthMm: 600 },
      transform: { positionMm: { xMm: 1.125, yMm: 2.25, zMm: -3.5 }, rotationMd: { xMd: 89999, yMd: -45001, zMd: 179999 } },
      boundsMm: { widthMm: 1200, depthMm: 600, heightMm: 901 }, zoneIds: [], requirementIds: [], materialIds: [],
      provenance: { kind: "user_confirmed_design_decision", sourceRef: "run-078 synthetic fixture", sourceFingerprint: hashB, acceptedByUser: true, note: null }, unknownIds: [] }],
    hierarchy: [{ objectId: "run078-object", parentObjectId: null }], zones: [], requirements: [], materials: [], assumptions: [], unknowns: [],
    validationReceipt: { receiptId: "33333333-3333-4333-8333-333333333333", validationHash: hashA, outcome: "pass" },
    eligibility: { currentAccepted: true, sourceCurrent: true, stale: false },
  };
  const s7 = {
    schemaVersion: "s7-to-s8-handoff-v1", projectId, sourceRevisionId: objectId, sourceRevisionHash: hashA, sourceS5Fingerprint: hashB,
    s7ArtifactId: "44444444-4444-4444-8444-444444444444", s7ArtifactHash: hashA, s7ArtifactByteSize: 1,
    manifestId: "55555555-5555-4555-8555-555555555555", manifestHash: hashA,
    readbackReceiptId: "66666666-6666-4666-8666-666666666666", readbackHash: hashA,
    dxfVersion: "s7-dxf-r2000-ascii-v1", worldToPlanVersion: "s7-world-to-plan-v1", coordinateConvention: "booth-local-right-handed-v1",
    dxfIsNot3DAuthority: true, s8MustReadAcceptedS6Model: true,
  };
  return { s6, s7 };
}

function appConfig(options: Options, sandboxExecutable: string, privateWorkRoot: string): Record<string, unknown> {
  const blenderExecutable = join(options.blenderRoot, "blender");
  return {
    blenderRuntimeRoot: options.blenderRoot,
    blenderExecutable,
    writerScript: options.writer,
    privateWorkRoot,
    processRunnerExecutable: options.runner,
    sandboxExecutable,
    nativeValidatorExecutable: options.validator,
    blenderExecutableSha256: sha256(readFileSync(blenderExecutable)),
  };
}

function setCurrentControlledEnvironment(): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, secretSentinels, hostileValues);
}

function setDefaultDenyParentEnvironment(): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv);
  mkdirSecure(options.evidenceRoot);
  const archiveSha = sha256(readFileSync(options.blenderArchive));
  const blenderPath = join(options.blenderRoot, "blender");
  const runnerSha = sha256(readFileSync(options.runner));
  const validatorSha = sha256(readFileSync(options.validator));
  const blenderSha = sha256(readFileSync(blenderPath));
  const exporterPath = join(dirname(options.writer), "export_fbx_bin.py");
  const manifestPath = join(dirname(options.writer), "patch-manifest.json");
  const candidateFiles = { writer: sha256(readFileSync(options.writer)), privateExporter: sha256(readFileSync(exporterPath)), patchManifest: sha256(readFileSync(manifestPath)) };

  emit("RUN=S8_G0B_PR47_BWRAP_PROVISIONED_RUNTIME_ENVIRONMENT_EVIDENCE_078");
  emit("LOCK=DL-SD-S8-G0B-PR47-BWRAP-PROVISIONED-RUNTIME-ENVIRONMENT-EVIDENCE-001");
  emit("STAGE=G0-B");
  emit(`BWRAP_SHA256=${options.bwrapSha256}`);
  emit(`RUNNER_SHA256=${runnerSha}`);
  emit(`VALIDATOR_SHA256=${validatorSha}`);
  emit(`BLENDER_SHA256=${blenderSha}`);
  emit(`BLENDER_ARCHIVE_SHA256=${archiveSha}`);
  emit(`CANDIDATE_WRITER_SHA256=${candidateFiles.writer}`);
  emit(`CANDIDATE_PRIVATE_EXPORTER_SHA256=${candidateFiles.privateExporter}`);
  emit(`CANDIDATE_PATCH_MANIFEST_SHA256=${candidateFiles.patchManifest}`);
  emit(`BLENDER_ARCHIVE_SHA256_ACCEPTED=${archiveSha === expectedBlenderArchiveSha256 ? "YES" : "NO"}`);
  if (archiveSha !== expectedBlenderArchiveSha256) throw new Error("RUN078_BLENDER_ARCHIVE_DIGEST_MISMATCH");

  const runtimeInfo: Record<string, Record<string, string>> = {};
  for (const [label, path] of [["RUNNER", options.runner], ["VALIDATOR", options.validator], ["BLENDER", blenderPath]] as const) {
    const interp = runCommand("/usr/bin/readelf", ["-lW", path]);
    const dynamic = runCommand("/usr/bin/readelf", ["-dW", path]);
    const dependencies = runCommand("/usr/bin/ldd", [path]);
    const ptInterp = interp.stdout.match(/Requesting program interpreter:\s*([^\]]+)/u)?.[1]?.trim() ?? "UNAVAILABLE";
    const needed = Array.from(dynamic.stdout.matchAll(/Shared library:\s*\[([^\]]+)\]/gu), (match) => match[1]!).sort();
    const resolved = Array.from(dependencies.stdout.matchAll(/=>\s+(\/\S+)/gu), (match) => match[1]!).sort();
    const direct = Array.from(dependencies.stdout.matchAll(/^\s*(\/\S+)\s+\(/gmu), (match) => match[1]!).sort();
    const resolvedSet = Array.from(new Set([...resolved, ...direct]));
    runtimeInfo[label] = { path, ptInterp, needed: needed.join(",") || "NONE", resolved: resolvedSet.join(",") || "NONE", lddStatus: String(dependencies.status) };
    emit(`${label}_PT_INTERP=${ptInterp}`);
    emit(`${label}_DT_NEEDED=${needed.join(",") || "NONE"}`);
    emit(`${label}_RESOLVED_DEPENDENCIES=${resolvedSet.join(",") || "NONE"}`);
    if (interp.status !== 0 || dynamic.status !== 0 || dependencies.status !== 0 || ptInterp === "UNAVAILABLE" || dependencies.stdout.includes("not found")) limitationSet.add(`${label}_ELF_DEPENDENCY_MEASUREMENT_INCOMPLETE`);
  }
  writeJson(join(options.evidenceRoot, "runtime-identities.json"), runtimeInfo);

  const require = createRequire(join(process.cwd(), "package.json"));
  const childProcess = require("node:child_process") as typeof import("node:child_process");
  const moduleApi = require("node:module") as typeof import("node:module");
  const originalSpawn = childProcess.spawnSync;
  const records: SpawnRecord[] = [];
  let observedRunnerWork = "";
  let observedArtifactPath = "";
  let observedRunnerArgs: string[] = [];
  const installedObserver = ((command: string, args?: readonly string[], spawnOptions?: import("node:child_process").SpawnSyncOptions) => {
    const commandText = String(command);
    const capture = commandText === activeShimPath || resolve(commandText) === options.runner;
    if (capture && resolve(commandText) === options.runner) {
      const values = (args ?? []).map(String);
      const separator = values.lastIndexOf("--");
      if (separator >= 0) {
        observedRunnerArgs = values;
        observedRunnerWork = String(spawnOptions?.cwd ?? "");
        observedArtifactPath = values[values.length - 1] ?? "";
      }
    }
    const result = originalSpawn(command, args, spawnOptions);
    if (capture) {
      const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout ?? ""));
      const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(String(result.stderr ?? ""));
      records.push({ command: commandText, args: (args ?? []).map(String), cwd: String(spawnOptions?.cwd ?? process.cwd()), environment: envClassifications(spawnOptions?.env as NodeJS.ProcessEnv | undefined), status: result.status, stdoutBytes: stdout.length, stderrBytes: stderr.length, stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr) });
      writeJson(join(options.evidenceRoot, "application-spawn-records.json"), records);
    }
    return result;
  }) as typeof childProcess.spawnSync;
  childProcess.spawnSync = installedObserver;
  moduleApi.syncBuiltinESMExports();

  const { buildS8WriterPayload } = await import("../../src/lib/s8-fbx-payload");
  const { runS8BlenderWriter, runS8NativeValidator } = await import("../../src/lib/s8-fbx-worker");
  const fixture = fixtureSources();
  const built = buildS8WriterPayload(fixture.s6 as never, fixture.s7 as never);
  emit(`WRITER_PAYLOAD_SOURCE=buildS8WriterPayload`);
  emit(`WRITER_PAYLOAD_SHA256=${built.sha256}`);

  const workRoot = options.privateWorkRoot;
  const workRootInfo = statSync(workRoot);
  if (!workRootInfo.isDirectory() || realpathSync(workRoot) !== workRoot) throw new Error("RUN078_PRIVATE_WORK_ROOT_INVALID");
  emit(`PRIVATE_WORK_ROOT_ADMISSION=EXISTING_DIRECTORY;MODE=${(workRootInfo.mode & 0o777).toString(8).padStart(3, "0")}`);
  setCurrentControlledEnvironment();
  const currentManifestPath = join(options.evidenceRoot, "current-application-shim.json");
  const currentShim = writeShim(options, "current-application-shim", { mode: "CURRENT_APPLICATION_TRANSPARENT", manifestPath: currentManifestPath, targetNeedles: ["/runtime/process-runner", "/runtime/blender-root/blender"] });
  activeShimPath = currentShim;
  let currentWriter = "FAIL";
  let currentWriterFailure = "NOT_RECORDED";
  try { runS8BlenderWriter(built.bytes, appConfig(options, currentShim, workRoot) as never); currentWriter = "PASS"; }
  catch (error) { currentWriterFailure = error instanceof Error ? safeText(error.message, 240) : "UNKNOWN_ERROR"; }
  const currentManifest = readShim(currentManifestPath);
  const currentBoundaryText = currentManifest ? `BWRAP_STATUS=${String(currentManifest.status ?? "UNAVAILABLE")};BWRAP_STDERR=${safeText(String(currentManifest.stderrText ?? "<empty>"), 520)};APP_ERROR=${currentWriterFailure}` : currentWriterFailure;
  const currentBwrapArgv = (currentManifest?.effectiveBwrapArgv as string[] | undefined) ?? [];
  const currentHasRuntimeSurface = currentBwrapArgv.some((argument, index) => argument === "--ro-bind" && broadUpperBound.includes(currentBwrapArgv[index + 1] ?? ""));
  const currentApplicationCounterexampleProven = currentWriter === "FAIL" && typeof currentManifest?.status === "number" && currentManifest.status !== 0 && !currentManifest.spawnError && !currentHasRuntimeSurface;
  emit(`CURRENT_APPLICATION_WRITER_LAUNCH_RESULT=${currentWriter}`);
  emit(`CURRENT_APPLICATION_WRITER_FAILURE_BOUNDARY=${currentBoundaryText}`);
  emit(`CURRENT_APPLICATION_BWRAP_RUNTIME_MOUNTS=${currentHasRuntimeSurface ? "BROAD_SURFACE_PRESENT" : "NO_BROAD_RUNTIME_SURFACES"}`);
  emit(`CURRENT_APPLICATION_COUNTEREXAMPLE_PROVEN=${currentApplicationCounterexampleProven ? "YES" : "NO"}`);
  emit(`CURRENT_APPLICATION_BWRAP_ARGV_DIGEST=${String(currentManifest?.effectiveBwrapArgvSha256 ?? "UNAVAILABLE")}`);
  emit(`CURRENT_PARENT_ENV_SENTINEL_INHERITANCE=${JSON.stringify(currentManifest?.environmentClassifications ?? {})}`);
  if (!currentApplicationCounterexampleProven) limitationSet.add("CURRENT_APPLICATION_COUNTEREXAMPLE_NOT_PROVEN");

  const broadMounts: Mount[] = broadUpperBound.map((path) => ({ source: path, target: path, kind: "directory", observed: [], consumer: "broad scratch upper bound only" }));
  const broadTracePath = join(options.evidenceRoot, "writer-broad-upper-bound.strace");
  const broadManifestPath = join(options.evidenceRoot, "writer-broad-upper-bound.json");
  const straceAvailable = existsSync("/usr/bin/strace");
  const broadShim = writeShim(options, "writer-broad-upper-bound-shim", { mode: "SCRATCH_BROAD_UPPER_BOUND", manifestPath: broadManifestPath, tracePath: straceAvailable ? broadTracePath : undefined, targetNeedles: ["/runtime/process-runner", "/runtime/blender-root/blender"], mountArgs: broadMounts.flatMap((mount) => ["--ro-bind", mount.source, mount.target]) });
  activeShimPath = broadShim;
  setDefaultDenyParentEnvironment();
  let broadWriterResult: ReturnType<typeof runS8BlenderWriter> | undefined;
  let broadWriterFailure = "NOT_RECORDED";
  try { broadWriterResult = runS8BlenderWriter(built.bytes, appConfig(options, broadShim, workRoot) as never); }
  catch (error) { broadWriterFailure = error instanceof Error ? safeText(error.message, 240) : "UNKNOWN_ERROR"; }
  emit(`BROAD_UPPER_BOUND_RUNTIME_SURFACES=${broadUpperBound.join(",")}`);
  emit(`BROAD_UPPER_BOUND_WRITER=${broadWriterResult ? "PASS" : "FAIL"}`);
  if (!broadWriterResult) {
    emit(`BROAD_UPPER_BOUND_WRITER_FAILURE=${broadWriterFailure}`);
    limitationSet.add("BROAD_UPPER_BOUND_WRITER_DID_NOT_SUCCEED");
  }
  const broadManifest = readShim(broadManifestPath);
  if (broadManifest) shimManifests.push(JSON.stringify(broadManifest));
  const broadObservation = (broadManifest?.targetObservations as Array<Record<string, unknown>> | undefined) ?? [];
  const broadMappedPaths = broadObservation.flatMap((target) => (target.mappedFiles as string[] | undefined) ?? []);
  emit(`RUNTIME_OBSERVER=${straceAvailable ? "STRACE_IF_SUCCESSFUL_WITH_PROC_MAPS_FALLBACK" : "PROC_MAPS_FALLBACK_NO_STRACE"}`);
  if (straceAvailable && !existsSync(broadTracePath)) limitationSet.add("STRACE_FILE_OPEN_TRACE_UNAVAILABLE");
  if (!straceAvailable && broadMappedPaths.length === 0) limitationSet.add("PROC_MAPS_FALLBACK_UNAVAILABLE");
  if (broadObservation.length === 0) limitationSet.add("BLENDER_AND_RUNNER_PROC_OBSERVATION_UNAVAILABLE");

  let currentValidator = "NOT_RUN";
  let currentValidatorFailure = "NOT_RUN";
  let validatorArtifact = broadWriterResult?.artifact;
  if (validatorArtifact) {
    setCurrentControlledEnvironment();
    try {
      const result = runS8NativeValidator(validatorArtifact, appConfig(options, currentShim, workRoot) as never);
      currentValidator = "PASS";
      emit(`CURRENT_APPLICATION_VALIDATOR_READBACK_SHA256=${sha256(result.readbackBytes)}`);
    } catch (error) {
      currentValidator = "FAIL";
      currentValidatorFailure = error instanceof Error ? safeText(error.message, 240) : "UNKNOWN_ERROR";
    }
  }
  emit(`CURRENT_APPLICATION_VALIDATOR_RESULT=${currentValidator}`);
  emit(`CURRENT_APPLICATION_VALIDATOR_FAILURE=${currentValidatorFailure}`);
  setDefaultDenyParentEnvironment();
  const validatorRecord = records.slice().reverse().find((item) => resolve(item.command) === options.runner);
  if (!validatorRecord || !observedRunnerWork || !observedArtifactPath || observedRunnerArgs.length === 0) limitationSet.add("APPLICATION_VALIDATOR_RUNNER_ARGV_NOT_CAPTURED");
  if (validatorRecord) {
    emit(`APPLICATION_VALIDATOR_RUNNER_SHA256=${sha256(options.runner)}`);
    emit(`APPLICATION_VALIDATOR_RUNNER_ARGV=${safeText(JSON.stringify(validatorRecord.args), 2200)}`);
    emit(`APPLICATION_VALIDATOR_ENVIRONMENT_AT_RUNNER=${JSON.stringify(validatorRecord.environment)}`);
    const validatorTargetArgv = observedRunnerArgs.slice(Math.max(0, observedRunnerArgs.lastIndexOf("--") + 1));
    emit(`APPLICATION_VALIDATOR_TARGET_ARGV=${safeText(JSON.stringify(validatorTargetArgv), 1500)}`);
  }

  let validatorReplayCount = 0;
  const validatorReplayResults: Array<Record<string, unknown>> = [];
  const replayValidator = (surfaces: Mount[], artifact: Buffer, label: string, clearEnvironment: boolean, environmentEntries: Array<[string, string]> = []): { passed: boolean; status: number | null; manifest?: Record<string, unknown>; failure: string; readbackSha256?: string } | undefined => {
    if (!validatorRecord || !observedRunnerWork || !observedArtifactPath || observedRunnerArgs.length === 0) return undefined;
    mkdirSecure(observedRunnerWork);
    writeFileSync(observedArtifactPath, artifact, { mode: 0o600 });
    const mounts: string[] = ["--ro-bind", options.runner, options.runner, "--ro-bind", options.validator, options.validator, "--bind", observedRunnerWork, observedRunnerWork, "--chdir", observedRunnerWork, "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];
    for (const surface of surfaces) mounts.push("--ro-bind", surface.source, surface.target);
    const environmentArgs = clearEnvironment ? ["--clearenv", ...environmentEntries.flatMap(([key, value]) => ["--setenv", key, value])] : [];
    const manifestPath = join(options.evidenceRoot, `${label}.json`);
    const shimPath = writeShim(options, `${label}-shim-${validatorReplayCount}`, { kind: "validator-replay", mode: clearEnvironment ? "SCRATCH_VALIDATOR_DEFAULT_DENY_ENVIRONMENT" : "SCRATCH_VALIDATOR_MINIMUM_SURFACES", timeoutMs: 130_000, manifestPath, targetNeedles: [options.runner, options.validator], baseArgs: ["--unshare-user", "--unshare-net", "--die-with-parent", "--new-session", ...mounts, ...environmentArgs] });
    validatorReplayCount += 1;
    const result = rawSpawnSync(shimPath, [options.runner, ...observedRunnerArgs], { cwd: observedRunnerWork, encoding: null, maxBuffer: 4 * 1024 * 1024, timeout: 150_000, windowsHide: true });
    const manifest = readShim(manifestPath);
    if (manifest) shimManifests.push(JSON.stringify(manifest));
    const outputText = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : String(result.stdout ?? "");
    const firstNewline = outputText.indexOf("\n");
    let readbackText = "";
    let readbackValid = false;
    try {
      if (outputText.startsWith("S8_RUNNER_RECEIPT:") && firstNewline > 0) {
        JSON.parse(outputText.slice("S8_RUNNER_RECEIPT:".length, firstNewline));
        readbackText = outputText.slice(firstNewline + 1);
        const parsed = JSON.parse(readbackText) as Record<string, unknown>;
        const readback = parsed.readback && typeof parsed.readback === "object" ? parsed.readback as Record<string, unknown> : parsed;
        readbackValid = readback.schemaVersion === "s8-ufbx-readback-v1" && readback.fbxVersion === 7400 && Array.isArray(readback.nodes) && Array.isArray(readback.materials);
      }
    } catch { readbackValid = false; }
    const readbackSha256 = readbackValid ? sha256(Buffer.from(readbackText, "utf8")) : "UNAVAILABLE";
    const passed = result.status === 0 && readbackValid;
    const failure = `EXIT_${result.status ?? "TIMEOUT_OR_SIGNAL"};READBACK_${readbackValid ? "VALID" : "INVALID"};BWRAP_STDERR=${safeText(String(manifest?.stderrText ?? "<empty>"), 260)}`;
    validatorReplayResults.push({ label, status: result.status, passed, readbackValid, readbackSha256, outputBytes: Buffer.byteLength(outputText, "utf8"), runnerSha256: sha256(options.runner), validatorSha256: sha256(options.validator), targetArgvSha256: sha256(canonical(observedRunnerArgs)) });
    return { passed, status: result.status, manifest, failure, readbackSha256 };
  };

  const blenderInterp = runtimeInfo.BLENDER?.ptInterp ?? "UNAVAILABLE";
  const runnerInterp = runtimeInfo.RUNNER?.ptInterp ?? "UNAVAILABLE";
  const interpFile = blenderInterp === "UNAVAILABLE" ? runnerInterp : blenderInterp;
  const onlyInterp: Mount[] = interpFile.startsWith("/") ? [{ source: interpFile, target: interpFile, kind: "file", observed: ["ELF PT_INTERP"], consumer: "runner and Blender ELF loader" }] : [];
  let interpreterOnly = "NOT_RUN";
  if (onlyInterp.length) {
    const shimPath = writeShim(options, "writer-elf-interpreter-only-shim", { mode: "SCRATCH_ELF_INTERPRETER_ONLY", manifestPath: join(options.evidenceRoot, "writer-elf-interpreter-only.json"), targetNeedles: ["/runtime/process-runner", "/runtime/blender-root/blender"], mountArgs: onlyInterp.flatMap((mount) => ["--ro-bind", mount.source, mount.target]) });
    activeShimPath = shimPath;
    try { runS8BlenderWriter(built.bytes, appConfig(options, shimPath, workRoot) as never); interpreterOnly = "PASS"; }
    catch { interpreterOnly = "FAIL_EXPECTED"; }
  } else limitationSet.add("ELF_INTERPRETER_NOT_MEASURED");
  emit(`ELF_INTERPRETER_ONLY_RESULT=${interpreterOnly}`);

  const observedPaths = new Set<string>();
  const observedConsumers = new Map<string, Set<string>>();
  const noteObserved = (path: string, consumer: string): void => {
    observedPaths.add(path);
    const consumers = observedConsumers.get(path) ?? new Set<string>();
    consumers.add(consumer);
    observedConsumers.set(path, consumers);
  };
  const pidConsumers = new Map<number, string>();
  for (const target of broadObservation) {
    const consumer = String(target.needle ?? "").includes("blender") ? "Blender/Writer" : "native process runner";
    if (typeof target.pid === "number") pidConsumers.set(target.pid, consumer);
    for (const path of (target.mappedFiles as string[] | undefined) ?? []) noteObserved(path, consumer);
  }
  if (existsSync(broadTracePath)) {
    const traceText = readFileSync(broadTracePath, "utf8");
    const targetPids = new Set(broadObservation.map((row) => Number(row.pid)).filter(Number.isFinite));
    for (const line of traceText.split("\n")) {
      const pidMatch = line.match(/^(\d+)\s/u);
      if (targetPids.size && pidMatch && !targetPids.has(Number(pidMatch[1]))) continue;
      if (targetPids.size && !pidMatch) continue;
      if (/=\s+-1(?:\s|$)/u.test(line)) continue;
      const pathMatch = line.match(/"((?:[^"\\]|\\.)+)"/u);
      if (!pathMatch) continue;
      try {
        const path = JSON.parse(`"${pathMatch[1]}"`) as string;
        if (path.startsWith("/")) noteObserved(path, pidMatch ? (pidConsumers.get(Number(pidMatch[1])) ?? "traced candidate process") : "traced candidate process");
      } catch { /* malformed trace path is omitted and listed as a limitation below */ }
    }
  }
  for (const [label, info] of Object.entries(runtimeInfo)) {
    for (const path of (info.resolved ?? "").split(",").filter(Boolean)) noteObserved(path, `${label.toLowerCase()} ELF dependency`);
    if (info.ptInterp?.startsWith("/")) noteObserved(info.ptInterp, `${label.toLowerCase()} PT_INTERP`);
  }
  const outsideBroad: string[] = [];
  const surfaceMap = new Map<string, Mount>();
  for (const observed of observedPaths) {
    if (!broadUpperBound.some((root) => observed === root || observed.startsWith(`${root}/`))) continue;
    const resolved = (() => { try { return realpathSync(observed); } catch { return observed; } })();
    if (!broadUpperBound.some((root) => resolved === root || resolved.startsWith(`${root}/`))) { outsideBroad.push(observed); continue; }
    let kind: Mount["kind"];
    try { kind = statSync(resolved).isDirectory() ? "directory" : "file"; } catch { continue; }
    let source = resolved;
    let target = observed;
    if (kind === "file" && /\.so(?:\.[0-9.]+)?$/u.test(observed)) {
      source = dirname(resolved);
      target = dirname(observed);
      kind = "directory";
    }
    if (observed === interpFile) { source = resolved; target = interpFile; kind = "file"; }
    if (kind === "directory" && broadUpperBound.includes(target)) continue;
    const key = `${source}\u0000${target}`;
    const prior = surfaceMap.get(key);
    const consumers = Array.from(observedConsumers.get(observed) ?? []);
    const consumer = consumers.join(",") || "successful Blender/Writer file or ELF dependency observation";
    if (prior) { prior.observed.push(observed); prior.consumer = Array.from(new Set(`${prior.consumer},${consumer}`.split(","))).join(","); }
    else surfaceMap.set(key, { source, target, kind, observed: [observed], consumer });
  }
  for (const path of outsideBroad) {
    emit(`OBSERVED_RUNTIME_PATH_OUTSIDE_UPPER_BOUND=${path}`);
    limitationSet.add("OBSERVED_RUNTIME_SURFACE_OUTSIDE_BROAD_UPPER_BOUND");
  }
  const initialSurfaces = Array.from(surfaceMap.values()).sort((a, b) => a.target.localeCompare(b.target));
  emit(`BLENDER_RUNTIME_LOADED_DEPENDENCIES=${Array.from(observedPaths).filter((path) => /\.so(?:\.[0-9.]+)?$/u.test(path)).sort().join(",") || "UNAVAILABLE"}`);
  emit(`OBSERVED_RUNTIME_SURFACE_CANDIDATE=${initialSurfaces.map((surface) => `${surface.kind}:${surface.target}`).join(",") || "NONE"}`);
  if (initialSurfaces.length === 0) limitationSet.add("NO_RUNTIME_SURFACES_DERIVED_FROM_OBSERVATIONS");

  let candidate = initialSurfaces.slice();
  let candidateWriterPass = false;
  let candidateValidatorPass = false;
  let writerAttempt = 0;
  const runWriterWithSurfaces = (surfaces: Mount[], label: string, environmentArgs: string[] = []): { passed: boolean; artifact?: Buffer; error?: string; manifest?: Record<string, unknown> } => {
    const attempt = writerAttempt++;
    const manifestPath = join(options.evidenceRoot, `${label}-${attempt}.json`);
    const shimPath = writeShim(options, `${label}-shim-${attempt}`, { mode: label, manifestPath, targetNeedles: ["/runtime/process-runner", "/runtime/blender-root/blender"], mountArgs: surfaces.flatMap((mount) => ["--ro-bind", mount.source, mount.target]), environmentArgs });
    activeShimPath = shimPath;
    try {
      const result = runS8BlenderWriter(built.bytes, appConfig(options, shimPath, workRoot) as never);
      const manifest = readShim(manifestPath);
      if (manifest) shimManifests.push(JSON.stringify(manifest));
      return { passed: true, artifact: result.artifact, manifest };
    } catch (error) {
      const manifest = readShim(manifestPath);
      if (manifest) shimManifests.push(JSON.stringify(manifest));
      return { passed: false, error: error instanceof Error ? safeText(error.message, 160) : "UNKNOWN", manifest };
    }
  };
  if (broadWriterResult && candidate.length) {
    const writerResult = runWriterWithSurfaces(candidate, "SCRATCH_SURFACE_CANDIDATE");
    candidateWriterPass = writerResult.passed;
    const validatorResult = replayValidator(candidate, broadWriterResult.artifact, "validator-surface-candidate", false);
    candidateValidatorPass = validatorResult?.passed ?? false;
    if (!candidateWriterPass) limitationSet.add(`OBSERVED_SURFACE_CANDIDATE_WRITER_FAILED:${writerResult.error ?? "UNKNOWN"}`);
    if (!candidateValidatorPass) limitationSet.add("OBSERVED_SURFACE_CANDIDATE_VALIDATOR_FAILED");
  }

  const removalResults = new Map<string, string>();
  if (candidate.length && broadWriterResult) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const surface of candidate.slice()) {
        const reduced = candidate.filter((item) => item !== surface);
        const writerResult = runWriterWithSurfaces(reduced, `SCRATCH_REMOVE_SURFACE_${sha256(surface.target).slice(0, 8)}`);
        const validatorResult = replayValidator(reduced, broadWriterResult.artifact, `validator-remove-${sha256(surface.target).slice(0, 8)}-${validatorReplayCount}`, false);
        const passed = writerResult.passed && validatorResult?.passed === true;
        removalResults.set(surface.target, passed ? "SUCCEEDED_SURFACE_REDUNDANT" : `FAILED_SURFACE_REQUIRED_WRITER_${writerResult.passed ? "PASS" : "FAIL"}_VALIDATOR_${validatorResult?.passed ? "PASS" : "FAIL"}`);
        if (passed) {
          candidate = reduced;
          candidateWriterPass = true;
          candidateValidatorPass = true;
          changed = true;
          break;
        }
      }
    }
  }

  const substitutionResults = new Map<string, string>();
  if (broadWriterResult) {
    for (const surface of candidate) {
      const substitute = surface.kind === "file" ? (surface.target.startsWith("/lib") ? "/usr/bin/env" : "/etc/hostname") : "/usr/share/doc";
      if (!existsSync(substitute)) { substitutionResults.set(surface.target, "NOT_RUN_SUBSTITUTE_SOURCE_ABSENT"); limitationSet.add(`SUBSTITUTE_SOURCE_ABSENT:${substitute}`); continue; }
      const substituted = candidate.map((item) => item === surface ? { ...item, source: substitute } : item);
      const writerResult = runWriterWithSurfaces(substituted, `SCRATCH_SUBSTITUTE_SURFACE_${sha256(surface.target).slice(0, 8)}`);
      const validatorResult = replayValidator(substituted, broadWriterResult.artifact, `validator-substitute-${sha256(surface.target).slice(0, 8)}-${validatorReplayCount}`, false);
      const rejected = !writerResult.passed || validatorResult?.passed !== true;
      const result = rejected ? `FAILED_IDENTITY_SUBSTITUTION_REJECTED_WRITER_${writerResult.passed ? "PASS" : "FAIL"}_VALIDATOR_${validatorResult?.passed ? "PASS" : "FAIL"}` : "SUCCEEDED_IDENTITY_NOT_PROVEN";
      substitutionResults.set(surface.target, result);
      if (!rejected) limitationSet.add(`SURFACE_IDENTITY_SUBSTITUTION_NOT_REJECTED:${surface.target}`);
    }
  } else {
    for (const surface of candidate) substitutionResults.set(surface.target, "NOT_RUN_BROAD_WRITER_UNAVAILABLE");
    if (candidate.length) limitationSet.add("SURFACE_SUBSTITUTION_CONTROLS_NOT_RUN");
  }
  emit(`ELF_INTERPRETER_REMOVAL_RESULT=${removalResults.get(interpFile) ?? "NOT_IN_FINAL_CANDIDATE"}`);
  emit("HOST_ROOT_BIND=REJECTED_OVERBROAD");
  const writableRoot = join(workRoot, `run078-writable-runtime-probe-${process.pid}`);
  let writableConfirmed = false;
  if (!existsSync(writableRoot)) {
    mkdirSecure(writableRoot);
    const writableMarker = join(writableRoot, "marker.txt");
    writeFileSync(writableMarker, "before\n", { mode: 0o600 });
    const writableProbe = runCommand("/usr/bin/sudo", ["-n", "/usr/bin/bwrap", "--unshare-user", "--unshare-net", "--die-with-parent", "--new-session", "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--ro-bind", "/etc", "/etc", "--bind", writableRoot, "/run078-writable-runtime-probe", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--clearenv", "--", "/usr/bin/bash", "-ceu", "printf 'after\\n' >> /run078-writable-runtime-probe/marker.txt"]);
    writableConfirmed = writableProbe.status === 0 && readFileSync(writableMarker, "utf8") === "before\nafter\n";
  } else limitationSet.add("WRITABLE_RUNTIME_SURFACE_NEGATIVE_CONTROL_PATH_PREEXISTED");
  emit(`WRITABLE_RUNTIME_SURFACE_VARIANT=${writableConfirmed ? "INVALID_CONTRACT_PROVEN_WRITABLE_NEGATIVE_CONTROL" : "NOT_ESTABLISHED"}`);
  if (!writableConfirmed) limitationSet.add("WRITABLE_RUNTIME_SURFACE_NEGATIVE_CONTROL_NOT_ESTABLISHED");
  for (const surface of candidate) {
    const removal = removalResults.get(surface.target) ?? "NOT_MEASURED";
    const substitution = substitutionResults.get(surface.target) ?? "NOT_MEASURED";
    emit(`SURFACE=${surface.target}\nSOURCE=${surface.source}\nREAD_ONLY=YES\nOBSERVED_CONSUMER=${surface.consumer}\nJUSTIFICATION=${surface.observed.slice(0, 12).join(",") || "ELF dependency parent"}\nREMOVAL_RESULT=${removal}\nSUBSTITUTION_RESULT=${substitution}`);
    if (!removal.startsWith("FAILED_SURFACE_REQUIRED")) limitationSet.add(`MINIMUM_SURFACE_REMOVAL_NOT_PROVEN:${surface.target}`);
  }
  if (!candidate.some((surface) => surface.target === interpFile)) limitationSet.add("ELF_INTERPRETER_NOT_IN_MINIMUM_SURFACES");

  const validatorSurfacePass = candidateValidatorPass;
  emit(`REAL_VALIDATOR_WITH_MINIMUM_SURFACES=${validatorSurfacePass ? "PASS" : "NOT_PROVEN"}`);
  if (!validatorSurfacePass) limitationSet.add("REAL_VALIDATOR_MINIMUM_SURFACES_FAILED");

  let minimumWriter = "NOT_RUN";
  let minimumValidator = "NOT_RUN";
  let minimumArtifact: Buffer | undefined;
  let writerClearEnvironmentProven = false;
  let validatorClearEnvironmentProven = false;
  const librarySearchValue = Array.from(new Set(candidate.filter((surface) => surface.kind === "directory").map((surface) => surface.target))).join(":") || "/usr/lib:/lib";
  const blenderPythonRoot = existsSync(join(options.blenderRoot, "5.2", "python")) ? "/runtime/blender-root/5.2/python" : "/runtime/blender-root";
  const environmentCandidates = [
    { key: "LANG", value: "C.UTF-8", valueClass: "FIXED_LOCALE" },
    { key: "LC_ALL", value: "C.UTF-8", valueClass: "FIXED_LOCALE" },
    { key: "NODE_ENV", value: "production", valueClass: "FIXED_RUNTIME_MODE" },
    { key: "PATH", value: "/usr/bin:/bin", valueClass: "FIXED_EXECUTABLE_SEARCH_PATH" },
    { key: "HOME", value: "/tmp", valueClass: "SANDBOX_TEMP_DIRECTORY" },
    { key: "TMPDIR", value: "/tmp", valueClass: "SANDBOX_TEMP_DIRECTORY" },
    { key: "TZ", value: "UTC", valueClass: "FIXED_TIMEZONE" },
    { key: "LD_LIBRARY_PATH", value: librarySearchValue, valueClass: "OBSERVED_READ_ONLY_LIBRARY_DIRECTORIES" },
    { key: "PYTHONPATH", value: "/runtime/blender-root", valueClass: "PINNED_BLENDER_RUNTIME_ROOT" },
    { key: "PYTHONHOME", value: blenderPythonRoot, valueClass: "PINNED_BLENDER_PYTHON_ROOT" },
  ];
  type EnvironmentAttempt = { writer: ReturnType<typeof runWriterWithSurfaces>; validator: ReturnType<typeof replayValidator> };
  const runEnvironmentAttempt = (label: string, entries: Array<{ key: string; value: string; valueClass: string }>): EnvironmentAttempt | undefined => {
    if (!candidate.length || !broadWriterResult) return undefined;
    const pairs: Array<[string, string]> = entries.map(({ key, value }) => [key, value]);
    const environmentArgs = ["--clearenv", ...pairs.flatMap(([key, value]) => ["--setenv", key, value])];
    const writer = runWriterWithSurfaces(candidate, `SCRATCH_DEFAULT_DENY_ENVIRONMENT_WRITER_${label}`, environmentArgs);
    const validatorArtifact = writer.artifact ?? broadWriterResult.artifact;
    const validator = replayValidator(candidate, validatorArtifact, `validator-default-deny-environment-${label}-${validatorReplayCount}`, true, pairs);
    return { writer, validator };
  };
  const environmentScore = (attempt: EnvironmentAttempt | undefined): number => attempt ? Number(!attempt.writer.passed) + Number(attempt.validator?.passed !== true) : 2;
  let selectedEnvironment: typeof environmentCandidates = [];
  let finalEnvironmentAttempt = runEnvironmentAttempt("empty", selectedEnvironment);
  if (finalEnvironmentAttempt && environmentScore(finalEnvironmentAttempt) > 0) {
    for (const entry of environmentCandidates) {
      const trial = runEnvironmentAttempt(`trial-${entry.key.toLowerCase()}`, [...selectedEnvironment, entry]);
      const before = environmentScore(finalEnvironmentAttempt);
      const after = environmentScore(trial);
      const accepted = !!trial && after < before;
      emit(`CHILD_ENV_KEY_TRIAL=${entry.key};ACCEPTED=${accepted ? "YES" : "NO"};WRITER=${trial?.writer.passed ? "PASS" : "FAIL"};VALIDATOR=${trial?.validator?.passed ? "PASS" : "FAIL"}`);
      if (accepted) {
        selectedEnvironment = [...selectedEnvironment, entry];
        finalEnvironmentAttempt = trial;
      }
      if (environmentScore(finalEnvironmentAttempt) === 0) break;
    }
  }
  const environmentRemovalResults = new Map<string, EnvironmentAttempt>();
  if (finalEnvironmentAttempt && environmentScore(finalEnvironmentAttempt) === 0 && selectedEnvironment.length) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of selectedEnvironment.slice()) {
        const reducedEntries = selectedEnvironment.filter((item) => item.key !== entry.key);
        const reducedAttempt = runEnvironmentAttempt(`without-${entry.key.toLowerCase()}`, reducedEntries);
        environmentRemovalResults.set(entry.key, reducedAttempt!);
        if (reducedAttempt && environmentScore(reducedAttempt) === 0) {
          selectedEnvironment = reducedEntries;
          finalEnvironmentAttempt = reducedAttempt;
          changed = true;
          break;
        }
      }
    }
  }
  const envMinimumExecutionPass = !!finalEnvironmentAttempt && environmentScore(finalEnvironmentAttempt) === 0;
  minimumArtifact = finalEnvironmentAttempt?.writer.artifact;
  minimumWriter = finalEnvironmentAttempt?.writer.passed ? "PASS" : finalEnvironmentAttempt ? `FAIL:${finalEnvironmentAttempt.writer.error ?? "UNKNOWN"}` : "NOT_RUN";
  minimumValidator = finalEnvironmentAttempt?.validator?.passed ? "PASS" : finalEnvironmentAttempt ? "FAIL" : "NOT_RUN";
  writerClearEnvironmentProven = Array.isArray(finalEnvironmentAttempt?.writer.manifest?.effectiveBwrapArgv) && (finalEnvironmentAttempt!.writer.manifest!.effectiveBwrapArgv as string[]).includes("--clearenv");
  validatorClearEnvironmentProven = Array.isArray(finalEnvironmentAttempt?.validator?.manifest?.effectiveBwrapArgv) && (finalEnvironmentAttempt!.validator!.manifest!.effectiveBwrapArgv as string[]).includes("--clearenv");
  emit(`REAL_WRITER_WITH_MINIMUM_SURFACES=${candidateWriterPass ? "PASS" : "NOT_PROVEN"}`);
  emit(`REAL_WRITER_WITH_MINIMUM_ENV=${minimumWriter}`);
  emit(`REAL_VALIDATOR_WITH_MINIMUM_SURFACES=${validatorSurfacePass ? "PASS" : "NOT_PROVEN"}`);
  emit(`REAL_VALIDATOR_WITH_MINIMUM_ENV=${minimumValidator}`);
  if (!minimumWriter.startsWith("PASS")) limitationSet.add("REAL_WRITER_DEFAULT_DENY_ENVIRONMENT_FAILED");
  if (minimumValidator !== "PASS") limitationSet.add("REAL_VALIDATOR_DEFAULT_DENY_ENVIRONMENT_FAILED");
  if (!finalEnvironmentAttempt) limitationSet.add("REAL_VALIDATOR_SCRATCH_REPLAY_NOT_RUN");

  const appKeys = currentManifest?.environmentClassifications as Record<string, string> | undefined;
  const expectedCurrentKeys = controlledKeys.every((key) => appKeys?.[key] && appKeys[key] !== "ABSENT");
  if (!expectedCurrentKeys) limitationSet.add("CURRENT_PARENT_ENVIRONMENT_INHERITANCE_NOT_FULLY_OBSERVED");
  const currentEnvOutput = JSON.stringify(appKeys ?? {});
  const allowedMinimumEnv = selectedEnvironment.map((entry) => entry.key);
  const requiredEnvironmentEntries = new Map(selectedEnvironment.map((entry) => [entry.key, entry]));
  const defaultDenyManifests = shimManifests.map((value) => JSON.parse(value) as Record<string, unknown>).filter((manifest) => String(manifest.mode ?? "").includes("DEFAULT_DENY_ENVIRONMENT"));
  const processEnvironmentObservations = defaultDenyManifests.flatMap((manifest) => (manifest.targetObservations as Array<Record<string, unknown>> | undefined) ?? []);
  const processEnvironmentKeys = processEnvironmentObservations.flatMap((observation) => (observation.environmentKeys as string[] | null) ?? []);
  const processEnvironmentClasses = processEnvironmentObservations.flatMap((observation) => Object.values((observation.environmentClassifications as Record<string, string> | null) ?? {}));
  const secretKeyNames = Object.keys(secretSentinels);
  const forbiddenValues = [...Object.values(secretSentinels), ...Object.values(hostileValues)];
  const targetArgvControlsPass = defaultDenyManifests.length > 0 && defaultDenyManifests.every((manifest) => {
    const argv = manifest.effectiveBwrapArgv as string[] | undefined;
    return !!argv?.includes("--clearenv") && !argv.some((argument) => secretKeyNames.includes(argument) || forbiddenValues.includes(argument) || /HOSTILE_(?:PATH|HOME|LD_PRELOAD|LD_LIBRARY_PATH|PYTHONPATH|PYTHONHOME)/u.test(argument));
  });
  const processEnvironmentLeak = processEnvironmentKeys.some((key) => secretKeyNames.includes(key)) || processEnvironmentClasses.some((value) => ["SYNTHETIC_SENTINEL_PRESENT", "CONTROLLED_SECRET_KEY_PRESENT", "CONTROLLED_HOSTILE_PRESENT"].includes(value));
  const negativeControlsPass = writerClearEnvironmentProven && validatorClearEnvironmentProven && targetArgvControlsPass && !processEnvironmentLeak;
  const envProven = envMinimumExecutionPass && minimumWriter === "PASS" && minimumValidator === "PASS" && negativeControlsPass;
  if (!envProven) limitationSet.add("DEFAULT_DENY_ENVIRONMENT_KEY_MINIMUM_NOT_ESTABLISHED");
  emit(`CHILD_ENV_REQUIRED_KEYS=${envProven ? (allowedMinimumEnv.length ? allowedMinimumEnv.join(",") : "NONE") : "UNESTABLISHED"}`);
  emit(`CHILD_ENV_UNNECESSARY_KEYS=${envProven ? environmentCandidates.filter((entry) => !requiredEnvironmentEntries.has(entry.key)).map((entry) => entry.key).join(",") : "UNESTABLISHED"}`);
  for (const entry of environmentCandidates) {
    const required = requiredEnvironmentEntries.has(entry.key);
    const without = environmentRemovalResults.get(entry.key);
    const failureWithout = required ? `writer=${without?.writer.passed ? "PASS" : safeText(without?.writer.error ?? "UNESTABLISHED", 120)};validator=${without?.validator?.passed ? "PASS" : safeText(without?.validator?.failure ?? "UNESTABLISHED", 180)}` : "writer=PASS;validator=PASS";
    emit(`CHILD_ENV_KEY_${entry.key}=${envProven ? (required ? "REQUIRED" : "UNNECESSARY") : "UNESTABLISHED"};FIXED_VALUE=${envProven && required ? entry.value : "NOT_SET"};CLASS=${envProven ? (required ? entry.valueClass : "NOT_REQUIRED") : "UNESTABLISHED"};WHY=${envProven ? (required ? "real Writer or Validator failed when omitted from the minimum set" : (allowedMinimumEnv.length ? "real Writer and Validator pass without this key" : "empty child environment passed for both targets")) : "minimum set not established"};FAILURE_WITHOUT=${failureWithout}`);
  }
  emit("CHILD_ENV_FORBIDDEN_KEYS=S8_TEST_PARENT_SECRET_A,S8_TEST_PARENT_SECRET_B,HOSTILE_PATH,HOSTILE_HOME,HOSTILE_LD_PRELOAD,HOSTILE_LD_LIBRARY_PATH,HOSTILE_PYTHONPATH,HOSTILE_PYTHONHOME");
  emit(`CHILD_ENV_NEGATIVE_CONTROLS=${negativeControlsPass ? "PASS" : "NOT_PROVEN"};clearenv_writer=${writerClearEnvironmentProven ? "YES" : "NO"};clearenv_validator=${validatorClearEnvironmentProven ? "YES" : "NO"};controlled_key_observed=${processEnvironmentLeak ? "YES" : "NO"};bwrap_argv=${targetArgvControlsPass ? "CONTROLLED_VALUES_ABSENT" : "NOT_PROVEN"}`);
  emit(`DEFAULT_DENY_TARGET_ENVIRONMENT_OBSERVATIONS=${processEnvironmentKeys.length ? "PROC_ENVIRONMENT_KEYS_AND_VALUE_CLASSES_CAPTURED" : "BWRAP_CLEAR_ENVIRONMENT_ARGV_ONLY"}`);
  const currentTargetArgv = observedRunnerArgs.slice(Math.max(0, observedRunnerArgs.lastIndexOf("--") + 1));
  emit(`APPLICATION_VALIDATOR_TARGET_ARGV=${safeText(JSON.stringify(currentTargetArgv), 1500)}`);
  if (!minimumWriter.startsWith("PASS") || limitationSet.size) {
    for (const limit of limitationSet) emit(`EVIDENCE_LIMITATION=${safeText(limit, 320)}`);
  }
  const candidateFilesAfter = { writer: sha256(readFileSync(options.writer)), privateExporter: sha256(readFileSync(exporterPath)), patchManifest: sha256(readFileSync(manifestPath)) };
  const candidateFilesUnchanged = canonical(candidateFiles) === canonical(candidateFilesAfter);
  if (!candidateFilesUnchanged) limitationSet.add("CANDIDATE_WRITER_PRIVATE_BYTES_CHANGED_DURING_EVIDENCE");
  const runtimeLimitations = Array.from(limitationSet).filter((item) => !item.startsWith("DEFAULT_DENY_ENVIRONMENT") && !item.startsWith("REAL_WRITER_DEFAULT_DENY") && !item.startsWith("REAL_VALIDATOR_DEFAULT_DENY") && !item.startsWith("CURRENT_PARENT_ENVIRONMENT_INHERITANCE"));
  const evidenceComplete = candidateWriterPass && validatorSurfacePass && currentApplicationCounterexampleProven && currentManifest !== undefined && candidate.length > 0 && removalResults.size >= candidate.length && Array.from(substitutionResults.values()).every((result) => result.startsWith("FAILED_IDENTITY_SUBSTITUTION_REJECTED")) && currentValidator !== "NOT_RUN" && runtimeLimitations.length === 0;
  const envComplete = evidenceComplete && envProven && minimumWriter === "PASS" && expectedCurrentKeys && currentEnvOutput.includes("SYNTHETIC_SENTINEL_PRESENT") && !processEnvironmentLeak;
  emit(`G4_075_01_EVIDENCE_COMPLETE=${evidenceComplete ? "YES" : "NO"}`);
  emit(`G4_075_02_ENVIRONMENT_EVIDENCE_COMPLETE=${envComplete ? "YES" : "NO"}`);
  emit(`EVIDENCE_LIMITATIONS=${limitationSet.size ? Array.from(limitationSet).join(";") : "NONE"}`);
  emit(`CURRENT_APPLICATION_BWRAP_ARGV_DIGEST_OR_BOUNDED_MANIFEST=${String(currentManifest?.effectiveBwrapArgvSha256 ?? "UNAVAILABLE")}`);
  emit(`RUNTIME_SURFACE_CANDIDATE=${candidate.map((surface) => surface.target).join(",") || "UNESTABLISHED"}`);
  emit(`RUNTIME_SURFACE_REMOVAL_MATRIX=${Array.from(removalResults.entries()).map(([key, value]) => `${key}:${value}`).join(";") || "UNAVAILABLE"}`);
  emit(`RUNTIME_SURFACE_SUBSTITUTION_MATRIX=${Array.from(substitutionResults.entries()).map(([key, value]) => `${key}:${value}`).join(";") || "UNAVAILABLE"}`);
  emit(`MINIMUM_CHILD_ENV_CANDIDATE=${allowedMinimumEnv.length ? allowedMinimumEnv.join(",") : "EMPTY"}`);
  emit(`VALIDATOR_REPLAY_RESULTS=${join(options.evidenceRoot, "validator-replay-results.json")};count=${validatorReplayResults.length};valid_readbacks=${validatorReplayResults.filter((result) => result.passed === true).length}`);
  emit(`EVIDENCE_MANIFESTS=${join(options.evidenceRoot, "application-spawn-records.json")};${currentManifestPath};${broadManifestPath}`);
  emit(`CANDIDATE_WRITER_PRIVATE_BYTES_UNCHANGED=${candidateFilesUnchanged ? "YES" : "NO"}`);
  writeFileSync(join(options.evidenceRoot, "terminal-evidence.txt"), `${evidence.join("\n")}\n`, { mode: 0o600 });
  writeJson(join(options.evidenceRoot, "shim-manifest-index.json"), shimManifests.map((value) => JSON.parse(value)));
  writeJson(join(options.evidenceRoot, "validator-replay-results.json"), validatorReplayResults);
  childProcess.spawnSync = originalSpawn;
}

if (process.argv[2] === "--validate-shim-template") {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "run078-shim-template-"));
  try {
    writeShim({ evidenceRoot: temporaryRoot } as Options, "template-check", { mode: "TEMPLATE_ONLY", manifestPath: join(temporaryRoot, "manifest.json"), targetNeedles: [] });
    process.stdout.write("RUN078_SHIM_TEMPLATE=PASS\n");
  } catch (error) {
    process.stderr.write(`RUN078_SHIM_TEMPLATE=FAIL:${safeText(error instanceof Error ? error.message : "UNKNOWN", 200)}\n`);
    process.exitCode = 2;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
} else {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? safeText(error.message, 320) : "RUN078_UNKNOWN_FAILURE";
    process.stderr.write(`RUN078_HARNESS_FAILURE=${message}\n`);
    process.exitCode = 2;
  });
}
