"use client";

import { useEffect, useRef, useState } from "react";
import { createIdempotencyKeyRetainer, type IdempotencyKeyRetainer } from "../../src/lib/client-idempotency";

type ApiError = { error?: { message?: string; referenceId?: string; code?: string } };
type GeometryValue = {
  widthMm: number;
  depthMm: number;
  openSides: string[];
  maxHeightMm: number | null;
};
type BriefState = {
  project: {
    status: string;
    activeGenerationSetId: string | null;
  };
  asset: { assetId: string; originalFileName: string; pageCount: number; byteSize: number; status: "stored" } | null;
  extractionStatus: string | null;
  extractionRetryEligible: boolean;
};

function useOperationKeys(): IdempotencyKeyRetainer {
  const retainer = useRef<IdempotencyKeyRetainer | null>(null);
  if (!retainer.current) retainer.current = createIdempotencyKeyRetainer();
  return retainer.current;
}

async function readJson(response: Response): Promise<any> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = body as ApiError;
    throw new Error(`${error.error?.message ?? "The request could not be completed."} Reference: ${error.error?.referenceId ?? "unavailable"}`);
  }
  return body;
}

function Shell({ title, children, error, status }: { title: string; children: React.ReactNode; error?: string; status?: string }) {
  return (
    <main>
      <p className="muted">Swooshz Design / v0.1 first slice</p>
      <h1>{title}</h1>
      {status ? <p className="muted">Status: {status}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      {children}
    </main>
  );
}

export function CreateProjectScreen() {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const body = await readJson(await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name || null }) }));
      window.location.assign(`/projects/${body.project.projectId}/geometry`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); setBusy(false); }
  }
  return <Shell title="Create project" error={error}><form onSubmit={submit}><label>Project name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="Optional project name" /></label><button disabled={busy}>{busy ? "Creating..." : "Create project"}</button></form></Shell>;
}

export function GeometryScreen({ projectId, initialGeometry }: { projectId: string; initialGeometry?: GeometryValue | null }) {
  const [width, setWidth] = useState(initialGeometry ? String(initialGeometry.widthMm / 1000) : "");
  const [depth, setDepth] = useState(initialGeometry ? String(initialGeometry.depthMm / 1000) : "");
  const [height, setHeight] = useState(initialGeometry?.maxHeightMm === null || initialGeometry?.maxHeightMm === undefined ? "" : String(initialGeometry.maxHeightMm / 1000));
  const [sides, setSides] = useState<string[]>(initialGeometry?.openSides ?? ["north"]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  function toggle(side: string) { setSides((current) => current.includes(side) ? current.filter((item) => item !== side) : [...current, side]); }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const toMm = (value: string) => value.trim() === "" ? null : Math.round(Number(value) * 1000);
    try {
      await readJson(await fetch(`/api/projects/${projectId}/geometry`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ widthMm: toMm(width), depthMm: toMm(depth), openSides: sides, maxHeightMm: toMm(height) }) }));
      window.location.assign(`/projects/${projectId}/brief`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); setBusy(false); }
  }
  return <Shell title="Booth geometry" error={error}><p>Width, depth, and at least one open side are mandatory hard inputs. Values are entered in metres and stored as integer millimetres.</p><form onSubmit={submit}><label>Width (m)<input required inputMode="decimal" value={width} onChange={(event) => setWidth(event.target.value)} /></label><label>Depth (m)<input required inputMode="decimal" value={depth} onChange={(event) => setDepth(event.target.value)} /></label><label>Optional maximum height (m)<input inputMode="decimal" value={height} onChange={(event) => setHeight(event.target.value)} /></label><div><strong>Open sides</strong><div className="sides">{["north", "east", "south", "west"].map((side) => <label key={side}><input type="checkbox" checked={sides.includes(side)} onChange={() => toggle(side)} />{side}</label>)}</div></div><button disabled={busy}>{busy ? "Saving..." : "Continue to brief"}</button></form></Shell>;
}

export function BriefUploadScreen({ projectId }: { projectId: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [assetId, setAssetId] = useState("");
  const [projectStatus, setProjectStatus] = useState("loading");
  const [extractionRetryEligible, setExtractionRetryEligible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const operationKeys = useOperationKeys();

  async function loadState(): Promise<BriefState> {
    const body = await readJson(await fetch(`/api/projects/${projectId}/brief`, { cache: "no-store" })) as BriefState;
    setAssetId(body.asset?.assetId ?? "");
    setProjectStatus(body.project.status);
    setExtractionRetryEligible(body.extractionRetryEligible);
    if (body.project.status === "brief_review") window.location.assign(`/projects/${projectId}/brief/review`);
    if (body.project.status === "brief_confirmed") window.location.assign(`/projects/${projectId}/generate`);
    if (["generating", "generation_failed", "concepts_ready"].includes(body.project.status) && body.project.activeGenerationSetId) {
      window.location.assign(`/projects/${projectId}/generations/${body.project.activeGenerationSetId}`);
    }
    return body;
  }

  useEffect(() => {
    void loadState().catch((caught) => setError(caught instanceof Error ? caught.message : "The request could not be completed."));
  }, [projectId]);

  async function waitForDraft() {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await fetch(`/api/projects/${projectId}/brief/draft`, { cache: "no-store" });
      if (response.ok) { window.location.assign(`/projects/${projectId}/brief/review`); return; }
      const body = await response.json().catch(() => ({}));
      if (body?.error?.code === "EXTRACTION_FAILED") {
        await loadState().catch(() => undefined);
        setError(`${body.error.message} Reference: ${body.error.referenceId}`);
        setBusy(false);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await loadState().catch(() => undefined);
    setError("The brief is still processing. Retry from this page if it does not complete.");
    setBusy(false);
  }

  async function upload(event: React.FormEvent) {
    event.preventDefault();
    if (!file) { setError("Select one PDF brief."); return; }
    setBusy(true); setError("");
    const form = new FormData(); form.append("file", file, file.name);
    try {
      const key = operationKeys.keyFor("brief_upload", file);
      const body = await readJson(await fetch(`/api/projects/${projectId}/brief`, { method: "POST", headers: { "Idempotency-Key": key }, body: form }));
      setAssetId(body.asset.assetId);
      setProjectStatus("extracting");
      setExtractionRetryEligible(false);
      await waitForDraft();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); setBusy(false); }
  }

  async function retry() {
    if (!assetId) { setError("The persisted brief asset is unavailable. Refresh the page and try again."); return; }
    setBusy(true); setError("");
    try {
      const key = operationKeys.keyFor("extraction_retry", assetId);
      await readJson(await fetch(`/api/projects/${projectId}/brief/extraction-retry`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assetId, idempotencyKey: key }) }));
      setProjectStatus("extracting");
      setExtractionRetryEligible(false);
      await waitForDraft();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); setBusy(false); }
  }

  const canUpload = projectStatus === "geometry_ready" && !assetId;
  const canRetry = projectStatus === "brief_extraction_failed" && extractionRetryEligible && Boolean(assetId);
  const terminalFailure = projectStatus === "brief_extraction_failed" && !extractionRetryEligible;
  return <Shell title="Upload brief" error={error} status={projectStatus === "loading" ? undefined : projectStatus}><p>Upload exactly one private PDF brief. Maximum 20 MiB and 20 pages. No images or office files are accepted.</p>{canUpload ? <form onSubmit={upload}><label>PDF brief<input required type="file" accept="application/pdf,.pdf" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label><button disabled={busy}>{busy ? "Extracting..." : "Upload and extract"}</button></form> : null}{canRetry ? <div className="panel"><p>The persisted brief asset can be retried without uploading a second file.</p><button type="button" onClick={retry} disabled={busy}>{busy ? "Retrying..." : "Retry extraction"}</button></div> : null}{terminalFailure ? <div className="panel"><p className="error">Brief extraction failed and the S1 retry budget is exhausted. No further extraction retry is available.</p></div> : null}{projectStatus === "extracting" ? <p>Extraction is running from the persisted brief asset.</p> : null}</Shell>;
}

export function BriefReviewScreen({ projectId }: { projectId: string }) {
  const [data, setData] = useState(""); const [draftId, setDraftId] = useState(""); const [revision, setRevision] = useState(0); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const operationKeys = useOperationKeys();
  const pendingConfirmation = useRef<{ key: string; draftId: string; revision: number; input: string } | null>(null);
  useEffect(() => { fetch(`/api/projects/${projectId}/brief/draft`, { cache: "no-store" }).then(readJson).then((body) => { setDraftId(body.draft.briefDraftId); setRevision(body.draft.revision); setData(JSON.stringify(body.draft.data, null, 2)); }).catch((caught) => setError(caught instanceof Error ? caught.message : "The request could not be completed.")); }, [projectId]);
  async function saveAndConfirm(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const pending = pendingConfirmation.current;
      let key: string;
      let expectedRevision: number;
      if (pending && pending.draftId === draftId && pending.input === data) {
        key = pending.key;
        expectedRevision = pending.revision;
      } else {
        const parsed = JSON.parse(data);
        const saved = await readJson(await fetch(`/api/projects/${projectId}/brief/draft`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: parsed, expectedRevision: revision }) }));
        expectedRevision = saved.draft.revision;
        setRevision(expectedRevision);
        key = operationKeys.keyFor("brief_confirm", `${draftId}:${expectedRevision}`);
        pendingConfirmation.current = { key, draftId, revision: expectedRevision, input: data };
      }
      await readJson(await fetch(`/api/projects/${projectId}/brief/confirm`, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ draftId, expectedRevision }) }));
      pendingConfirmation.current = null;
      window.location.assign(`/projects/${projectId}/generate`);
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); setBusy(false); }
  }
  return <Shell title="Review structured brief" error={error}><p>Edit the structured extraction before explicit confirmation. Server geometry and extracted geometry mentions remain separate; geometry is not editable here.</p><form onSubmit={saveAndConfirm}><label>Structured brief-v1 JSON<textarea value={data} onChange={(event) => { pendingConfirmation.current = null; setData(event.target.value); }} /></label><button disabled={busy || !draftId}>{busy ? "Confirming..." : "Save and confirm brief"}</button></form></Shell>;
}

export function GenerateScreen({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const operationKeys = useOperationKeys();
  async function submit(event: React.FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { const key = operationKeys.keyFor("generation_create", projectId); const body = await readJson(await fetch(`/api/projects/${projectId}/generation-sets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: key }) })); window.location.assign(`/projects/${projectId}/generations/${body.generationSet.generationSetId}`); } catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); setBusy(false); } }
  return <Shell title="Generate four concepts" error={error}><p>One bounded batch will generate exactly four independent concept images. They share the confirmed geometry and brief constraints and vary only by fixed creative direction.</p><form onSubmit={submit}><button disabled={busy}>{busy ? "Starting..." : "Generate four concepts"}</button></form></Shell>;
}

export function GenerationProgressScreen({ projectId, generationSetId }: { projectId: string; generationSetId: string }) {
  const [body, setBody] = useState<any>(null); const [error, setError] = useState(""); const [retryBusy, setRetryBusy] = useState(false);
  const operationKeys = useOperationKeys();
  useEffect(() => { let active = true; async function poll() { for (let attempt = 0; attempt < 120 && active; attempt += 1) { const response = await fetch(`/api/projects/${projectId}/generation-sets/${generationSetId}`, { cache: "no-store" }); const result = await response.json().catch(() => ({})); if (!active) return; if (response.ok) { setBody(result); if (result.generationSet.status === "queued" || result.generationSet.status === "running") { await new Promise((resolve) => setTimeout(resolve, 500)); continue; } return; } setError(`${result?.error?.message ?? "The request could not be completed."} Reference: ${result?.error?.referenceId ?? "unavailable"}`); return; } } void poll(); return () => { active = false; }; }, [projectId, generationSetId]);
  async function retry() { setRetryBusy(true); setError(""); try { const key = operationKeys.keyFor("generation_retry", generationSetId); const result = await readJson(await fetch(`/api/projects/${projectId}/generation-sets/${generationSetId}/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: key }) })); window.location.assign(`/projects/${projectId}/generations/${result.generationSet.generationSetId}`); } catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); setRetryBusy(false); } }
  const status = body?.generationSet?.status ?? "queued";
  return <Shell title="Generation progress and results" status={status} error={error}>{status === "succeeded" ? <div className="panel"><p className="success">Exactly {body.candidates.length} immutable candidates are persisted. Image objects remain private.</p><div className="candidate-grid">{body.candidates.map((candidate: any) => <div className="candidate" key={candidate.candidateId}><strong>Candidate {candidate.candidateIndex}</strong><p>{candidate.directionKey}</p><p className="muted">PNG asset persisted privately.</p></div>)}</div></div> : status === "failed" ? <div className="panel"><p className="error">The four-candidate set failed. No partial candidates were published.</p>{body?.retryEligible === true ? <button onClick={retry} disabled={retryBusy}>{retryBusy ? "Retrying..." : "Retry all four directions"}</button> : <p>No further full-set retry is available for this confirmed brief.</p>}</div> : <div className="panel"><p>Generating four provider-backed PNGs. This screen polls the persisted set and shows candidates only after all four succeed.</p></div>}</Shell>;
}
