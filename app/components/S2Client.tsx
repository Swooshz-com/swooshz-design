"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createIdempotencyKeyRetainer,
  type IdempotencyKeyRetainer,
  UnknownNetworkOutcome,
  withRetainedIdempotencyKey,
} from "../../src/lib/client-idempotency";

type ClientFetcher = (input: string, init: RequestInit) => Promise<Response>;
type ClientNavigator = (url: string) => void;

type Asset = {
  id: string;
  kind: "reference" | "logo";
  status: string;
  width: number;
  height: number;
  normalizedBytes: number;
  normalizedSha256: string;
};
type Draft = {
  id: string;
  revision: number;
  status: "editable" | "frozen";
  referenceAssetIds: string[];
  logoAssetIds: string[];
  frozenByQaRunId: string | null;
  assets: Asset[];
};
type Observation = {
  requirementId?: string;
  ruleId?: string;
  expected?: string;
  expectedCount?: number | null;
  expectedValue?: string | number | boolean | null;
  observed: string;
  observedCount?: number | null;
  confidence: number;
  evidence: string;
};
type Candidate = {
  candidateId: string;
  candidateIndex: number;
  sourceAssetId?: string;
  sourceSha256?: string;
  status: string;
  verdict: string;
  materialFindingIds: string[];
  warningFindingIds?: string[];
  uncertainFindingIds: string[];
  requirementObservations?: Observation[];
  designObservations?: Observation[];
  repairEligible?: boolean;
};
type QaRun = {
  id: string;
  status: string;
  candidateResults: Candidate[];
  repairs?: Array<{ candidateId: string; status: string; eligibleFindingIds: string[]; derivedCandidateId: string | null; reQaCandidateResultId: string | null }>;
  reQa?: Array<{ candidateId: string; status: string; verdict: string }>;
};
export type S2QaProjection = {
  qaRun: QaRun;
  input: { id: string };
};

function useOperationKeys(): IdempotencyKeyRetainer {
  const retainer = useRef<IdempotencyKeyRetainer | null>(null);
  if (!retainer.current) retainer.current = createIdempotencyKeyRetainer();
  return retainer.current;
}

async function json(response: Response): Promise<any> {
  let body: any;
  try {
    body = await response.json();
  } catch {
    if (response.ok) throw new UnknownNetworkOutcome();
    throw new Error("The request could not be completed. Reference: unavailable");
  }
  if (!response.ok) throw new Error((body.error?.message ?? "The request could not be completed.") + " Reference: " + (body.error?.referenceId ?? "unavailable"));
  return body;
}

async function requestJsonWithKey(
  retainer: IdempotencyKeyRetainer,
  operation: string,
  input: unknown,
  request: (key: string) => Promise<Response>,
): Promise<any> {
  return withRetainedIdempotencyKey(retainer, operation, input, async (key) => {
    let response: Response;
    try {
      response = await request(key);
    } catch {
      throw new UnknownNetworkOutcome();
    }
    return json(response);
  });
}

function path(projectId: string, suffix: string): string { return "/api/projects/" + projectId + suffix; }
function browserFetch(input: string, init: RequestInit): Promise<Response> { return fetch(input, init); }
function browserNavigate(url: string): void { window.location.assign(url); }

export type S2ReferencesClient = ReturnType<typeof createS2ReferencesClient>;

export function createS2ReferencesClient(options: {
  projectId: string;
  sourceGenerationSetId: string | null;
  operationKeys?: IdempotencyKeyRetainer;
  fetcher?: ClientFetcher;
  navigate?: ClientNavigator;
}) {
  const operationKeys = options.operationKeys ?? createIdempotencyKeyRetainer();
  const fetcher = options.fetcher ?? browserFetch;
  const navigate = options.navigate ?? browserNavigate;
  let uploadIntent: { file: File; kind: "reference" | "logo"; input: object } | null = null;

  async function refresh(): Promise<Draft> {
    const body = await json(await fetcher(path(options.projectId, "/s2/reference-draft"), { cache: "no-store" }));
    const draft = body.draft as Draft;
    if (draft.status === "frozen" && draft.frozenByQaRunId) {
      navigate("/projects/" + options.projectId + "/s2/qa/" + draft.frozenByQaRunId);
    }
    return draft;
  }

  async function upload(file: File, kind: "reference" | "logo"): Promise<any> {
    if (!uploadIntent || uploadIntent.file !== file || uploadIntent.kind !== kind) {
      uploadIntent = { file, kind, input: {} };
    }
    return requestJsonWithKey(operationKeys, "s2_reference_upload", uploadIntent.input, (key) => {
      const form = new FormData();
      form.append("file", file, file.name);
      form.append("kind", kind);
      return fetcher(path(options.projectId, "/s2/reference-assets"), {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: form,
      });
    });
  }

  async function update(referenceAssetIds: string[], logoAssetIds: string[], expectedRevision: number): Promise<any> {
    const input = JSON.stringify({ projectId: options.projectId, expectedRevision, referenceAssetIds, logoAssetIds });
    return requestJsonWithKey(operationKeys, "s2_reference_draft_update", input, (key) => fetcher(path(options.projectId, "/s2/reference-draft"), {
      method: "PATCH",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ expectedRevision, referenceAssetIds, logoAssetIds }),
    }));
  }

  async function bind(expectedDraftRevision: number): Promise<any> {
    if (!options.sourceGenerationSetId) throw new Error("The completed S1 generation set is unavailable. Refresh the page and try again.");
    const input = JSON.stringify({ projectId: options.projectId, sourceGenerationSetId: options.sourceGenerationSetId, expectedDraftRevision });
    const body = await requestJsonWithKey(operationKeys, "s2_bind", input, (key) => fetcher(path(options.projectId, "/s2/qa-runs"), {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ sourceGenerationSetId: options.sourceGenerationSetId, expectedDraftRevision }),
    }));
    if (body.qaRun?.id) navigate("/projects/" + options.projectId + "/s2/qa/" + body.qaRun.id);
    return body;
  }

  return { refresh, upload, update, bind };
}

export function createS2QaClient(options: {
  projectId: string;
  qaRunId: string;
  operationKeys?: IdempotencyKeyRetainer;
  fetcher?: ClientFetcher;
}) {
  const operationKeys = options.operationKeys ?? createIdempotencyKeyRetainer();
  const fetcher = options.fetcher ?? browserFetch;
  let projection: S2QaProjection | null = null;

  async function refresh(): Promise<S2QaProjection> {
    projection = await json(await fetcher(path(options.projectId, "/s2/qa-runs/" + options.qaRunId), { cache: "no-store" })) as S2QaProjection;
    return projection;
  }

  function eligibleCandidate(candidateId: string): Candidate {
    const candidate = projection?.qaRun.candidateResults.find((item) => item.candidateId === candidateId);
    if (!projection || !projection.input?.id || !candidate || candidate.repairEligible !== true) {
      throw new Error("The immutable S2 input is unavailable. Refresh the page and try again.");
    }
    return candidate;
  }

  async function retry(candidateId: string): Promise<S2QaProjection> {
    const input = JSON.stringify({ projectId: options.projectId, qaRunId: options.qaRunId, candidateId });
    await requestJsonWithKey(operationKeys, "s2_qa_retry", input, (key) => fetcher(path(options.projectId, "/s2/qa-runs/" + options.qaRunId + "/candidates/" + candidateId + "/retry"), {
      method: "POST",
      headers: { "Idempotency-Key": key },
    }));
    return refresh();
  }

  async function repair(candidateId: string): Promise<S2QaProjection> {
    eligibleCandidate(candidateId);
    const inputVersionId = projection!.input.id;
    const input = JSON.stringify({ projectId: options.projectId, qaRunId: options.qaRunId, candidateId, expectedInputVersionId: inputVersionId });
    await requestJsonWithKey(operationKeys, "s2_repair", input, (key) => fetcher(path(options.projectId, "/s2/qa-runs/" + options.qaRunId + "/candidates/" + candidateId + "/repair"), {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ expectedInputVersionId: inputVersionId }),
    }));
    return refresh();
  }

  return { refresh, retry, repair };
}

export function S2ReferencesScreen({ projectId, sourceGenerationSetId }: { projectId: string; sourceGenerationSetId: string | null }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [kind, setKind] = useState<"reference" | "logo">("reference");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const operationKeys = useOperationKeys();
  const client = useMemo(() => createS2ReferencesClient({ projectId, sourceGenerationSetId, operationKeys }), [projectId, sourceGenerationSetId, operationKeys]);
  async function refresh() {
    try { setDraft(await client.refresh()); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); }
  }
  useEffect(() => { void refresh(); }, [client]);
  const selected = useMemo(() => new Set([...(draft?.referenceAssetIds ?? []), ...(draft?.logoAssetIds ?? [])]), [draft]);
  const assetsById = useMemo(() => new Map((draft?.assets ?? []).map((asset) => [asset.id, asset])), [draft]);
  async function upload() {
    if (!file || !draft) return;
    setBusy(true); setError("");
    try {
      const body = await client.upload(file, kind);
      setDraft(body.draft); setFile(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); }
    finally { setBusy(false); }
  }
  async function update(referenceAssetIds: string[], logoAssetIds: string[]) {
    if (!draft) return;
    setBusy(true); setError("");
    try {
      const body = await client.update(referenceAssetIds, logoAssetIds, draft.revision);
      setDraft(body.draft);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); await refresh(); }
    finally { setBusy(false); }
  }
  function toggle(asset: Asset) {
    if (!draft || draft.status === "frozen") return;
    const refs = draft.referenceAssetIds.slice(); const logos = draft.logoAssetIds.slice();
    const target = asset.kind === "reference" ? refs : logos;
    const index = target.indexOf(asset.id);
    if (index >= 0) target.splice(index, 1); else target.push(asset.id);
    void update(refs, logos);
  }
  function move(asset: Asset, delta: -1 | 1) {
    if (!draft || draft.status === "frozen") return;
    const refs = draft.referenceAssetIds.slice(); const logos = draft.logoAssetIds.slice();
    const target = asset.kind === "reference" ? refs : logos;
    const index = target.indexOf(asset.id); const next = index + delta;
    if (index < 0 || next < 0 || next >= target.length) return;
    [target[index], target[next]] = [target[next], target[index]];
    void update(refs, logos);
  }
  function ordered(kindValue: "reference" | "logo") {
    if (!draft) return null;
    const ids = kindValue === "reference" ? draft.referenceAssetIds : draft.logoAssetIds;
    return ids.length ? ids.map((id, index) => {
      const asset = assetsById.get(id);
      if (!asset) return null;
      return <li className="asset-row" key={id}><span>{index + 1}. {asset.width}x{asset.height} ({Math.round(asset.normalizedBytes / 1024)} KiB)</span><span className="asset-actions"><button type="button" disabled={busy || draft.status === "frozen" || index === 0} onClick={() => move(asset, -1)} aria-label={`Move ${kindValue} up`}>↑</button><button type="button" disabled={busy || draft.status === "frozen" || index === ids.length - 1} onClick={() => move(asset, 1)} aria-label={`Move ${kindValue} down`}>↓</button><button type="button" disabled={busy || draft.status === "frozen"} onClick={() => toggle(asset)}>Remove</button></span></li>;
    }) : <li className="muted">No {kindValue}s selected. The empty selection is valid.</li>;
  }
  async function runQa() {
    if (!draft) return;
    setBusy(true); setError("");
    try { await client.bind(draft.revision); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); }
    finally { setBusy(false); }
  }
  return <main><p className="muted">Swooshz Design / S2 visual inputs</p><h1>Reference inputs</h1><p>Upload optional reference images and logos, then choose their exact order.</p><p>Accepted: PNG, JPEG, or WebP. Each original file is limited to 8 MiB; the draft allows up to 6 references, 2 logos, and 8 total assets.</p><p className="disclaimer">S2 is visual/design-only QA. It is not engineering, structural, venue, fabrication, legal, cost, or approval confirmation.</p>{error ? <p className="error">{error}</p> : null}{draft ? <section className="panel"><p className="muted">Revision {draft.revision} / {draft.status} / S1 generation set {sourceGenerationSetId ?? "unavailable"}</p><div className="upload-controls"><label>Reference<input type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" disabled={draft.status === "frozen"} onChange={(event) => { setKind("reference"); setFile(event.target.files?.[0] ?? null); }} /></label><label>Logo<input type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" disabled={draft.status === "frozen"} onChange={(event) => { setKind("logo"); setFile(event.target.files?.[0] ?? null); }} /></label></div><button disabled={busy || !file || draft.status === "frozen"} onClick={() => void upload()}>Upload {kind}</button><div className="ordered-inputs"><section><h2>References</h2><ol>{ordered("reference")}</ol></section><section><h2>Logos</h2><ol>{ordered("logo")}</ol></section></div><h2>Available assets</h2><div className="candidate-grid">{draft.assets.filter((asset) => asset.status === "ready").map((asset) => <label className="candidate" key={asset.id}><input type="checkbox" checked={selected.has(asset.id)} disabled={draft.status === "frozen"} onChange={() => toggle(asset)} />{asset.kind} / {asset.width}x{asset.height}</label>)}</div><button disabled={busy || draft.status === "frozen" || !sourceGenerationSetId} onClick={() => void runQa()}>Run S2 QA</button></section> : null}</main>;
}

export function S2QaScreen({ projectId, qaRunId }: { projectId: string; qaRunId: string }) {
  const [projection, setProjection] = useState<S2QaProjection | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const operationKeys = useOperationKeys();
  const client = useMemo(() => createS2QaClient({ projectId, qaRunId, operationKeys }), [projectId, qaRunId, operationKeys]);
  async function refresh() {
    try { setProjection(await client.refresh()); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); }
  }
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 1200); return () => window.clearInterval(timer); }, [client]);
  async function retry(candidateId: string) {
    setBusy(true); setError("");
    try { setProjection(await client.retry(candidateId)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); }
    finally { setBusy(false); }
  }
  async function repair(candidateId: string) {
    setBusy(true); setError("");
    try { setProjection(await client.repair(candidateId)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); }
    finally { setBusy(false); }
  }
  const run = projection?.qaRun;
  return <main><p className="muted">Swooshz Design / S2 visual QA</p><h1>Buildability QA</h1><p className="disclaimer">S2 is visual/design screening only. It is not engineering, venue, code, fabrication, rigging, cost, or construction approval.</p>{error ? <p className="error">{error}</p> : null}<p className="muted">Run status: {run?.status ?? "loading"}</p><button type="button" disabled={busy} onClick={() => void refresh()}>Refresh persisted result</button><div className="candidate-grid">{run?.candidateResults.map((candidate) => { const repairState = run.repairs?.find((item) => item.candidateId === candidate.candidateId); const reQa = run.reQa?.find((item) => item.candidateId === candidate.candidateId); return <article className="candidate" key={candidate.candidateId}><h2>Candidate {candidate.candidateIndex}</h2><p><strong>{candidate.status}</strong> / {candidate.verdict}</p><p className="muted">Immutable source candidate {candidate.candidateId}. Source pixels remain private and are used only for this bound QA lineage.</p>{candidate.materialFindingIds.length ? <p>Material findings: {candidate.materialFindingIds.join(", ")}</p> : null}{candidate.warningFindingIds?.length ? <p>Warning findings: {candidate.warningFindingIds.join(", ")}</p> : null}{candidate.uncertainFindingIds.length ? <p>Uncertainty is retained as WARNING: {candidate.uncertainFindingIds.join(", ")}</p> : null}{candidate.requirementObservations?.length || candidate.designObservations?.length ? <details><summary>Observations</summary>{candidate.requirementObservations?.map((observation) => <p className="observation" key={observation.requirementId}>{observation.requirementId}: {observation.observed} ({observation.confidence}){observation.observedCount === null || observation.observedCount === undefined ? "" : `, count ${observation.observedCount}`} - {observation.evidence}</p>)}{candidate.designObservations?.map((observation) => <p className="observation" key={observation.ruleId}>{observation.ruleId}: {observation.observed} ({observation.confidence}) - {observation.evidence}</p>)}</details> : null}{candidate.status === "qa_unavailable_retryable" ? <button disabled={busy} onClick={() => void retry(candidate.candidateId)}>Retry QA</button> : null}{candidate.repairEligible === true ? <button disabled={busy || Boolean(repairState)} onClick={() => void repair(candidate.candidateId)}>Request bounded repair</button> : null}{repairState ? <p>Repair: {repairState.status}{repairState.derivedCandidateId ? `; derived ${repairState.derivedCandidateId}` : ""}</p> : null}{reQa ? <p>Re-QA: {reQa.status} / {reQa.verdict}</p> : null}</article>; })}</div></main>;
}
