"use client";

import { useEffect, useMemo, useState } from "react";

type Asset = { id: string; kind: "reference" | "logo"; status: string; width: number; height: number; normalizedBytes: number; normalizedSha256: string };
type Draft = { id: string; revision: number; status: "editable" | "frozen"; referenceAssetIds: string[]; logoAssetIds: string[]; assets: Asset[] };
type Candidate = { candidateId: string; candidateIndex: number; status: string; verdict: string; materialFindingIds: string[]; uncertainFindingIds: string[] };
type QaRun = { id: string; status: string; candidateResults: Candidate[] };

function key(): string { return crypto.randomUUID(); }
async function json(response: Response): Promise<any> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.code ?? "REQUEST_FAILED");
  return body;
}
function path(projectId: string, suffix: string): string { return "/api/projects/" + projectId + suffix; }

export function S2ReferencesScreen({ projectId }: { projectId: string }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [kind, setKind] = useState<"reference" | "logo">("reference");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function refresh() {
    try { setDraft((await json(await fetch(path(projectId, "/s2/reference-draft"), { cache: "no-store" }))).draft); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "REQUEST_FAILED"); }
  }
  useEffect(() => { void refresh(); }, [projectId]);
  const selected = useMemo(() => new Set([...(draft?.referenceAssetIds ?? []), ...(draft?.logoAssetIds ?? [])]), [draft]);
  async function upload() {
    if (!file || !draft) return;
    setBusy(true); setError("");
    try {
      const form = new FormData();
      form.append("file", file, file.name); form.append("kind", kind);
      const body = await json(await fetch(path(projectId, "/s2/reference-assets"), { method: "POST", headers: { "Idempotency-Key": key() }, body: form }));
      setDraft(body.draft); setFile(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "REQUEST_FAILED"); }
    finally { setBusy(false); }
  }
  async function update(referenceAssetIds: string[], logoAssetIds: string[]) {
    if (!draft) return;
    setBusy(true); setError("");
    try {
      const body = await json(await fetch(path(projectId, "/s2/reference-draft"), {
        method: "PATCH", headers: { "content-type": "application/json", "Idempotency-Key": key() },
        body: JSON.stringify({ expectedRevision: draft.revision, referenceAssetIds, logoAssetIds }),
      }));
      setDraft(body.draft);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "REQUEST_FAILED"); await refresh(); }
    finally { setBusy(false); }
  }
  function toggle(asset: Asset) {
    if (!draft || draft.status === "frozen") return;
    const refs = new Set(draft.referenceAssetIds); const logos = new Set(draft.logoAssetIds);
    const target = asset.kind === "reference" ? refs : logos;
    if (target.has(asset.id)) target.delete(asset.id); else target.add(asset.id);
    void update(Array.from(refs), Array.from(logos));
  }
  async function runQa() {
    if (!draft) return;
    const sourceGenerationSetId = window.prompt("Completed S1 generation set ID");
    if (!sourceGenerationSetId) return;
    setBusy(true); setError("");
    try {
      const body = await json(await fetch(path(projectId, "/s2/qa-runs"), {
        method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key() },
        body: JSON.stringify({ sourceGenerationSetId, expectedDraftRevision: draft.revision }),
      }));
      window.location.assign("/projects/" + projectId + "/s2/qa/" + body.qaRun.id);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "REQUEST_FAILED"); }
    finally { setBusy(false); }
  }
  return <main><p className="muted">Swooshz Design / S2 visual inputs</p><h1>Reference inputs</h1><p>Upload optional reference images and logos, then choose their exact order.</p><p className="disclaimer">S2 is visual/design-only QA. It is not engineering, structural, venue, fabrication, legal, cost, or approval confirmation.</p>{error ? <p className="error">{error}</p> : null}{draft ? <section className="panel"><p className="muted">Revision {draft.revision} / {draft.status}</p><label>Asset kind<select value={kind} disabled={draft.status === "frozen"} onChange={(event) => setKind(event.target.value as "reference" | "logo")}><option value="reference">Reference</option><option value="logo">Logo</option></select></label><label>PNG, JPEG, or WebP<input type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" disabled={draft.status === "frozen"} onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label><button disabled={busy || !file || draft.status === "frozen"} onClick={() => void upload()}>Upload asset</button><div className="candidate-grid">{draft.assets.filter((asset) => asset.status === "ready").map((asset) => <label className="candidate" key={asset.id}><input type="checkbox" checked={selected.has(asset.id)} disabled={draft.status === "frozen"} onChange={() => toggle(asset)} />{asset.kind} / {asset.width}x{asset.height}</label>)}</div><button disabled={busy || draft.status === "frozen"} onClick={() => void runQa()}>Run S2 QA</button></section> : null}</main>;
}

export function S2QaScreen({ projectId, qaRunId }: { projectId: string; qaRunId: string }) {
  const [run, setRun] = useState<QaRun | null>(null); const [error, setError] = useState("");
  async function refresh() {
    try { setRun((await json(await fetch(path(projectId, "/s2/qa-runs/" + qaRunId), { cache: "no-store" }))).qaRun); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "REQUEST_FAILED"); }
  }
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 1200); return () => window.clearInterval(timer); }, [projectId, qaRunId]);
  async function retry(candidateId: string) {
    try { await json(await fetch(path(projectId, "/s2/qa-runs/" + qaRunId + "/candidates/" + candidateId + "/retry"), { method: "POST", headers: { "Idempotency-Key": key() } })); await refresh(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "REQUEST_FAILED"); }
  }
  async function repair(candidateId: string) {
    const expectedInputVersionId = window.prompt("Immutable input version ID");
    if (!expectedInputVersionId) return;
    try { await json(await fetch(path(projectId, "/s2/qa-runs/" + qaRunId + "/candidates/" + candidateId + "/repair"), { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key() }, body: JSON.stringify({ expectedInputVersionId }) })); await refresh(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "REQUEST_FAILED"); }
  }
  return <main><p className="muted">Swooshz Design / S2 visual QA</p><h1>Buildability QA</h1><p className="disclaimer">Visual/design-only result. It is not an engineering, structural, venue, fabrication, legal, cost, or approval confirmation.</p>{error ? <p className="error">{error}</p> : null}<p className="muted">Run status: {run?.status ?? "loading"}</p><div className="candidate-grid">{run?.candidateResults.map((candidate) => <article className="candidate" key={candidate.candidateId}><h2>Candidate {candidate.candidateIndex}</h2><p>{candidate.status} / {candidate.verdict}</p>{candidate.materialFindingIds.length ? <p>Findings: {candidate.materialFindingIds.join(", ")}</p> : null}{candidate.uncertainFindingIds.length ? <p>Uncertainty is retained as WARNING.</p> : null}{candidate.status === "qa_unavailable_retryable" ? <button onClick={() => void retry(candidate.candidateId)}>Retry QA</button> : null}{candidate.status === "material_fail" && candidate.materialFindingIds.length ? <button onClick={() => void repair(candidate.candidateId)}>Request bounded repair</button> : null}</article>)}</div></main>;
}
