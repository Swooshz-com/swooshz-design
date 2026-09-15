"use client";

import { useEffect, useState } from "react";
import type { S8MaxHandoff, S8MaxPublicState, S8MaxTelemetry } from "../../src/lib/types";

type ErrorBody = { error?: { message?: string; referenceId?: string } };

function apiPath(projectId: string, suffix = ""): string {
  return "/api/projects/" + projectId + "/s8" + suffix;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & ErrorBody;
  if (!response.ok) {
    const error = (body as ErrorBody).error;
    throw new Error(`${error?.message ?? "The request could not be completed."} Reference: ${error?.referenceId ?? "unavailable"}`);
  }
  return body as T;
}

export function S8Screen({ projectId }: { projectId: string }) {
  const [state, setState] = useState<S8MaxPublicState | null>(null);
  const [telemetry, setTelemetry] = useState<S8MaxTelemetry | null>(null);
  const [handoff, setHandoff] = useState<S8MaxHandoff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = async () => {
    const [nextState, nextTelemetry] = await Promise.all([
      fetch(apiPath(projectId), { cache: "no-store" }).then((response) => readJson<S8MaxPublicState>(response)),
      fetch(apiPath(projectId, "/telemetry"), { cache: "no-store" }).then((response) => readJson<S8MaxTelemetry>(response)),
    ]);
    setState(nextState);
    setTelemetry(nextTelemetry);
  };

  useEffect(() => {
    let active = true;
    void refresh().catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : "The request could not be completed."); });
    return () => { active = false; };
  }, [projectId]);

  const createExport = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(apiPath(projectId, "/exports"), { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": globalThis.crypto.randomUUID() }, body: "{}" });
      const result = await readJson<{ export: { status: string } }>(response);
      setNotice(`Native handoff export ${result.export.status}.`);
      await refresh();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "The request could not be completed.");
    } finally { setBusy(false); }
  };

  const retry = async (artifactId: string) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(apiPath(projectId, `/exports/${artifactId}/retry`), { method: "POST", headers: { "Idempotency-Key": globalThis.crypto.randomUUID() } });
      const result = await readJson<{ export: { status: string } }>(response);
      setNotice(`Retry ${result.export.status}.`);
      await refresh();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "The request could not be completed.");
    } finally { setBusy(false); }
  };

  const loadHandoff = async () => {
    setError("");
    try { setHandoff(await fetch(apiPath(projectId, "/handoff"), { cache: "no-store" }).then((response) => readJson<S8MaxHandoff>(response))); }
    catch (caught: unknown) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); }
  };

  return (
    <main>
      <h1>Editable 3D native Max handoff</h1>
      <p className="muted">S8 reads the accepted S6 spatial model, emits a deterministic payload, and binds separate native generation and validation steps. Autodesk execution is unavailable in this local slice until a controller binds live evidence.</p>
      {error && <p className="error">{error}</p>}
      {notice && <p className="success">{notice}</p>}
      <section className="panel">
        <h2>Source</h2>
        <p>Readiness: <strong>{state?.source.readiness ?? "loading"}</strong></p>
        {state?.source.s6RevisionId && <p className="muted">Accepted S6 revision: {state.source.s6RevisionId}</p>}
        <button type="button" onClick={createExport} disabled={busy || state?.source.readiness !== "ready"}>{busy ? "Creating handoff..." : "Create native .max handoff"}</button>
      </section>
      <section className="panel">
        <h2>Exports</h2>
        {!state && <p className="muted">Loading...</p>}
        {state?.exports.length === 0 && <p className="muted">No exports yet.</p>}
        {state?.exports.map((item) => <article className="candidate" key={item.artifactId}>
          <strong>{item.status}</strong>
          <p className="muted">Attempt {item.candidateAttempt} · {item.artifactByteSize ?? "-"} bytes · {item.artifactSha256 ?? "hash pending"}</p>
          {item.status === "committed" && <a href={apiPath(projectId, `/exports/${item.artifactId}/download`)}>Download swooshz-s8-model.max</a>}
          {item.status === "failed_retryable" || item.status === "provider_hold" ? <button type="button" onClick={() => void retry(item.artifactId)} disabled={busy}>Retry</button> : null}
        </article>)}
      </section>
      <section className="panel">
        <h2>Semantic handoff telemetry</h2>
        <p className="muted">Exports: {telemetry?.exportCount.value ?? "-"} · committed: {telemetry?.committedExportCount.value ?? "-"} · validation pass: {telemetry?.validationPassCount.value ?? "-"}</p>
        <button type="button" onClick={() => void loadHandoff()}>Show S8 handoff payload metadata</button>
        {handoff && <pre>{JSON.stringify(handoff, null, 2)}</pre>}
      </section>
    </main>
  );
}
