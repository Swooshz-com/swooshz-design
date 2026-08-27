"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createIdempotencyKeyRetainer,
  type IdempotencyKeyRetainer,
  UnknownNetworkOutcome,
  withRetainedIdempotencyKey,
} from "../../src/lib/client-idempotency";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
type Navigator = (url: string) => void;
type Asset = { id: string; kind: "reference" | "logo"; status: string; width: number; height: number; normalizedBytes: number; normalizedSha256: string };
type Draft = { id: string; revision: number; status: "editable" | "frozen"; referenceAssetIds: string[]; logoAssetIds: string[]; frozenByQaRunId: string | null; assets: Asset[] };
type Observation = { requirementId?: string; ruleId?: string; observed: string; observedCount?: number | null; confidence: number; evidence: string };
type Candidate = { candidateId: string; candidateIndex: number; status: string; verdict: string; materialFindingIds: string[]; warningFindingIds: string[]; uncertainFindingIds: string[]; requirementObservations: Observation[]; designObservations: Observation[]; repairEligible?: boolean; eligibleRepairFindingIds?: string[] };
type QaSummary = { kind: "processing" | "results_available" | "results_include_unavailable" | "all_results_unavailable"; resultCount: number; unavailableCount: number };
export type S2QaProjection = { qaRun: { id: string; status: string; candidateResults: Candidate[]; repairs: Array<{ candidateId: string; status: string; derivedCandidateId: string | null }>; reQa: Array<{ candidateId: string; status: string; verdict: string }>; summary?: QaSummary }; input: { id: string } };
export type S2QaPresentation = { statusText: string; summaryText: string };

function apiPath(projectId: string, suffix: string): string { return "/api/projects/" + projectId + suffix; }
async function readJson(response: Response): Promise<any> {
  let body: any;
  try { body = await response.json(); } catch { if (response.ok) throw new UnknownNetworkOutcome(); throw new Error("The request could not be completed. Reference: unavailable"); }
  if (!response.ok) throw new Error((body.error?.message ?? "The request could not be completed.") + " Reference: " + (body.error?.referenceId ?? "unavailable"));
  return body;
}
async function withKey(retainer: IdempotencyKeyRetainer, operation: string, input: unknown, request: (key: string) => Promise<Response>): Promise<any> {
  return withRetainedIdempotencyKey(retainer, operation, input, async (key) => {
    let response: Response;
    try { response = await request(key); } catch { throw new UnknownNetworkOutcome(); }
    return readJson(response);
  });
}
function defaultFetch(input: string, init?: RequestInit): Promise<Response> { return fetch(input, init); }
function defaultNavigate(url: string): void { window.location.assign(url); }
function useRetainer(): IdempotencyKeyRetainer {
  const ref = useRef<IdempotencyKeyRetainer | null>(null);
  if (!ref.current) ref.current = createIdempotencyKeyRetainer();
  return ref.current;
}

export function createS2ReferencesClient(options: { projectId: string; sourceGenerationSetId: string | null; operationKeys?: IdempotencyKeyRetainer; fetcher?: Fetcher; navigate?: Navigator }) {
  const keys = options.operationKeys ?? createIdempotencyKeyRetainer(); const fetcher = options.fetcher ?? defaultFetch; const navigate = options.navigate ?? defaultNavigate;
  let uploadIntent: { file: File; kind: "reference" | "logo" } | null = null;
  const refresh = async (): Promise<Draft> => {
    const body = await readJson(await fetcher(apiPath(options.projectId, "/s2/reference-draft"), { cache: "no-store" }));
    const draft = body.draft as Draft;
    if (draft.status === "frozen" && draft.frozenByQaRunId) navigate("/projects/" + options.projectId + "/s2/qa/" + draft.frozenByQaRunId);
    return draft;
  };
  const upload = async (file: File, kind: "reference" | "logo"): Promise<any> => {
    if (!uploadIntent || uploadIntent.file !== file || uploadIntent.kind !== kind) uploadIntent = { file, kind };
    return withKey(keys, "s2_reference_upload", uploadIntent, (key) => {
      const form = new FormData(); form.append("file", file, file.name); form.append("kind", kind);
      return fetcher(apiPath(options.projectId, "/s2/reference-assets"), { method: "POST", headers: { "Idempotency-Key": key }, body: form });
    });
  };
  const update = (referenceAssetIds: string[], logoAssetIds: string[], expectedRevision: number) => withKey(keys, "s2_reference_draft_update",
    JSON.stringify({ expectedRevision, referenceAssetIds, logoAssetIds }),
    (key) => fetcher(apiPath(options.projectId, "/s2/reference-draft"), {
      method: "PATCH", headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ expectedRevision, referenceAssetIds, logoAssetIds }),
    }));
  const bind = async (expectedDraftRevision: number) => {
    if (!options.sourceGenerationSetId) throw new Error("The completed S1 generation set is unavailable. Refresh and try again.");
    const body = await withKey(keys, "s2_bind", JSON.stringify({ sourceGenerationSetId: options.sourceGenerationSetId, expectedDraftRevision }), (key) =>
      fetcher(apiPath(options.projectId, "/s2/qa-runs"), { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ sourceGenerationSetId: options.sourceGenerationSetId, expectedDraftRevision }) }));
    if (body.qaRun?.id) navigate("/projects/" + options.projectId + "/s2/qa/" + body.qaRun.id);
    return body;
  };
  return { refresh, upload, update, bind };
}

export function createS2QaClient(options: { projectId: string; qaRunId: string; operationKeys?: IdempotencyKeyRetainer; fetcher?: Fetcher }) {
  const keys = options.operationKeys ?? createIdempotencyKeyRetainer(); const fetcher = options.fetcher ?? defaultFetch;
  const refresh = async (): Promise<S2QaProjection> => readJson(await fetcher(apiPath(options.projectId, "/s2/qa-runs/" + options.qaRunId), { cache: "no-store" }));
  const retry = async (candidateId: string) => {
    await withKey(keys, "s2_qa_retry", JSON.stringify({ candidateId }), (key) => fetcher(apiPath(options.projectId, "/s2/qa-runs/" + options.qaRunId + "/candidates/" + candidateId + "/retry"), { method: "POST", headers: { "Idempotency-Key": key } }));
    return refresh();
  };
  const repair = async (candidateId: string, inputVersionId: string) => {
    await withKey(keys, "s2_repair", JSON.stringify({ candidateId, inputVersionId }), (key) => fetcher(apiPath(options.projectId, "/s2/qa-runs/" + options.qaRunId + "/candidates/" + candidateId + "/repair"), {
      method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ expectedInputVersionId: inputVersionId }),
    }));
    return refresh();
  };
  return { refresh, retry, repair };
}

export function s2QaUserFacingState(run: S2QaProjection["qaRun"] | null | undefined): S2QaPresentation {
  switch (run?.summary?.kind) {
    case "processing":
      return { statusText: "QA processing", summaryText: "QA is still processing." };
    case "results_available":
      return { statusText: "QA results available", summaryText: "Results are available for all candidates." };
    case "results_include_unavailable":
      return { statusText: "QA results available with unavailable candidates", summaryText: "Results are available, but at least one candidate remains unavailable." };
    case "all_results_unavailable":
      return { statusText: "QA unavailable - no usable provider result", summaryText: "QA finished without a usable provider result. No pass/fail conclusion is available." };
    default:
      return { statusText: "Loading persisted QA state", summaryText: "Loading persisted QA state." };
  }
}

export function s2QaCandidateControls(candidate: Pick<Candidate, "status" | "repairEligible">, hasRepair = false): { canRetry: boolean; canRepair: boolean } {
  return { canRetry: candidate.status === "qa_unavailable_retryable", canRepair: candidate.repairEligible === true && !hasRepair };
}

export function S2ReferencesScreen({ projectId, sourceGenerationSetId }: { projectId: string; sourceGenerationSetId: string | null }) {
  const [draft, setDraft] = useState<Draft | null>(null); const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<"reference" | "logo">("reference"); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const keys = useRetainer(); const client = useMemo(() => createS2ReferencesClient({ projectId, sourceGenerationSetId, operationKeys: keys }), [projectId, sourceGenerationSetId, keys]);
  const refresh = async () => { try { setDraft(await client.refresh()); } catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); } };
  useEffect(() => { void refresh(); }, [client]);
  async function upload() { if (!draft || !file) return; setBusy(true); setError(""); try { const body = await client.upload(file, kind); setDraft(body.draft); setFile(null); } catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); } finally { setBusy(false); } }
  async function update(refs: string[], logos: string[]) { if (!draft) return; setBusy(true); setError(""); try { const body = await client.update(refs, logos, draft.revision); setDraft(body.draft); } catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); await refresh(); } finally { setBusy(false); } }
  function toggle(asset: Asset) {
    if (!draft || draft.status === "frozen") return;
    const refs = draft.referenceAssetIds.slice(); const logos = draft.logoAssetIds.slice(); const selected = asset.kind === "reference" ? refs : logos; const index = selected.indexOf(asset.id);
    if (index >= 0) selected.splice(index, 1); else selected.push(asset.id); void update(refs, logos);
  }
  function reorder(asset: Asset, delta: -1 | 1) {
    if (!draft || draft.status === "frozen") return;
    const refs = draft.referenceAssetIds.slice(); const logos = draft.logoAssetIds.slice(); const selected = asset.kind === "reference" ? refs : logos; const index = selected.indexOf(asset.id); const next = index + delta;
    if (index < 0 || next < 0 || next >= selected.length) return; [selected[index], selected[next]] = [selected[next], selected[index]]; void update(refs, logos);
  }
  const selected = new Set([...(draft?.referenceAssetIds ?? []), ...(draft?.logoAssetIds ?? [])]);
  return <main><p className="muted">Swooshz Design / S2 visual inputs</p><h1>Reference inputs</h1><p>Upload optional visual references and logos, then preserve their exact order.</p><p className="disclaimer">S2 is visual/design QA only; it is not engineering, structural, venue, fabrication, legal, cost, or approval confirmation.</p>{error ? <p className="error">{error}</p> : null}{draft ? <section className="panel"><p className="muted">Revision {draft.revision} / {draft.status}</p><label>Upload kind<select value={kind} disabled={draft.status === "frozen"} onChange={(event) => setKind(event.target.value as "reference" | "logo")}><option value="reference">Reference</option><option value="logo">Logo</option></select></label><label>Image<input type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" disabled={draft.status === "frozen"} onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label><button type="button" disabled={busy || !file || draft.status === "frozen"} onClick={() => void upload()}>Upload</button><div className="candidate-grid">{draft.assets.filter((asset) => asset.status === "ready").map((asset) => <label className="candidate" key={asset.id}><input type="checkbox" checked={selected.has(asset.id)} disabled={busy || draft.status === "frozen"} onChange={() => toggle(asset)} />{asset.kind} / {asset.width}x{asset.height} / {Math.round(asset.normalizedBytes / 1024)} KiB</label>)}</div><h2>Ordered references</h2><ol>{draft.referenceAssetIds.map((id, index) => <li key={id}>{id} <button type="button" disabled={busy || draft.status === "frozen" || index === 0} onClick={() => { const asset = draft.assets.find((item) => item.id === id); if (asset) reorder(asset, -1); }}>Up</button><button type="button" disabled={busy || draft.status === "frozen" || index === draft.referenceAssetIds.length - 1} onClick={() => { const asset = draft.assets.find((item) => item.id === id); if (asset) reorder(asset, 1); }}>Down</button></li>)}</ol><h2>Ordered logos</h2><ol>{draft.logoAssetIds.map((id) => <li key={id}>{id}</li>)}</ol><button type="button" disabled={busy || draft.status === "frozen" || !sourceGenerationSetId} onClick={() => void client.bind(draft.revision)}>Run S2 QA</button></section> : null}</main>;
}

export function S2QaScreen({ projectId, qaRunId }: { projectId: string; qaRunId: string }) {
  const [projection, setProjection] = useState<S2QaProjection | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const keys = useRetainer(); const client = useMemo(() => createS2QaClient({ projectId, qaRunId, operationKeys: keys }), [projectId, qaRunId, keys]);
  async function refresh() { try { setProjection(await client.refresh()); } catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); } }
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 1200); return () => window.clearInterval(timer); }, [client]);
  async function retry(id: string) { setBusy(true); try { setProjection(await client.retry(id)); } catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); } finally { setBusy(false); } }
  async function repair(id: string) { if (!projection) return; setBusy(true); try { setProjection(await client.repair(id, projection.input.id)); } catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); } finally { setBusy(false); } }
  const run = projection?.qaRun;
  const presentation = s2QaUserFacingState(run);
  return <main><p className="muted">Swooshz Design / S2 buildability QA</p><h1>Buildability QA</h1><p className="disclaimer">Visual/design screening only. No engineering, venue, code, fabrication, rigging, cost, construction, or approval conclusion is produced.</p>{error ? <p className="error">{error}</p> : null}<p className="muted">{presentation.statusText}</p><p aria-live="polite">{presentation.summaryText}</p><button type="button" disabled={busy} onClick={() => void refresh()}>Refresh persisted result</button><div className="candidate-grid">{run?.candidateResults.map((candidate) => { const repairState = run.repairs.find((item) => item.candidateId === candidate.candidateId); const reQa = run.reQa.find((item) => item.candidateId === candidate.candidateId); const controls = s2QaCandidateControls(candidate, Boolean(repairState)); return <article className="candidate" key={candidate.candidateId}><h2>Candidate {candidate.candidateIndex}</h2><p><strong>{candidate.status}</strong> / {candidate.verdict}</p>{candidate.materialFindingIds.length ? <p>Material findings: {candidate.materialFindingIds.join(", ")}</p> : null}{candidate.warningFindingIds.length ? <p>Warnings: {candidate.warningFindingIds.join(", ")}</p> : null}{candidate.uncertainFindingIds.length ? <p>Uncertainty remains WARNING: {candidate.uncertainFindingIds.join(", ")}</p> : null}<details><summary>Evidence observations</summary>{candidate.requirementObservations.map((item) => <p key={item.requirementId}>{item.requirementId}: {item.observed} ({item.confidence}) - {item.evidence}</p>)}{candidate.designObservations.map((item) => <p key={item.ruleId}>{item.ruleId}: {item.observed} ({item.confidence}) - {item.evidence}</p>)}</details>{controls.canRetry ? <button type="button" disabled={busy} onClick={() => void retry(candidate.candidateId)}>Retry QA</button> : null}{controls.canRepair ? <button type="button" disabled={busy} onClick={() => void repair(candidate.candidateId)}>Request bounded repair</button> : null}{repairState ? <p>Repair: {repairState.status}</p> : null}{reQa ? <p>Re-QA: {reQa.status} / {reQa.verdict}</p> : null}</article>; })}</div></main>;
}
