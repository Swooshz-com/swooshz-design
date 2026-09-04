"use client";

import { useEffect, useState } from "react";
import type { S7PublicState, S7Telemetry, S7ToS8Handoff } from "../../src/lib/types";

type ErrorBody = { error?: { message?: string; referenceId?: string } };

function apiPath(projectId: string, suffix = ""): string {
  return "/api/projects/" + projectId + "/s7" + suffix;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & ErrorBody;
  if (!response.ok) {
    const error = (body as ErrorBody).error;
    throw new Error(`${error?.message ?? "The request could not be completed."} Reference: ${error?.referenceId ?? "unavailable"}`);
  }
  return body as T;
}

export function S7Screen({ projectId }: { projectId: string }) {
  const [state, setState] = useState<S7PublicState | null>(null);
  const [telemetry, setTelemetry] = useState<S7Telemetry | null>(null);
  const [handoff, setHandoff] = useState<S7ToS8Handoff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = async () => {
    const [nextState, nextTelemetry] = await Promise.all([
      fetch(apiPath(projectId), { cache: "no-store" }).then((response) => readJson<S7PublicState>(response)),
      fetch(apiPath(projectId, "/telemetry"), { cache: "no-store" }).then((response) => readJson<S7Telemetry>(response)),
    ]);
    setState(nextState);
    setTelemetry(nextTelemetry);
  };

  useEffect(() => {
    let active = true;
    void refresh().catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : "The request could not be completed."); });
    return () => { active = false; };
  }, [projectId]);

  const generate = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const key = globalThis.crypto.randomUUID();
      const response = await fetch(apiPath(projectId, "/exports"), { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key }, body: "{}" });
      const result = await readJson<{ export: { status: string; artifactId: string } }>(response);
      setNotice(`Export ${result.export.status}.`);
      await refresh();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "The request could not be completed.");
    } finally { setBusy(false); }
  };

  const loadHandoff = async () => {
    setError("");
    try { setHandoff(await fetch(apiPath(projectId, "/handoff"), { cache: "no-store" }).then((response) => readJson<S7ToS8Handoff>(response))); }
    catch (caught: unknown) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); }
  };

  return (
    <main>
      <h1>Accurate editable 2D CAD</h1>
      <p className="muted">S7 exports a deterministic AutoCAD 2000 DXF from the accepted S6 spatial model. The DXF is a 2D handoff, not 3D authority.</p>
      {error && <p className="error">{error}</p>}
      {notice && <p className="success">{notice}</p>}
      <section className="panel">
        <h2>Source</h2>
        <p>Readiness: <strong>{state?.source.readiness ?? "loading"}</strong></p>
        {state?.source.sourceRevisionId && <p className="muted">Accepted S6 revision: {state.source.sourceRevisionId}</p>}
        <button type="button" onClick={generate} disabled={busy || state?.source.readiness !== "ready"}>{busy ? "Creating export..." : "Create DXF export"}</button>
      </section>
      <section className="panel">
        <h2>Exports</h2>
        {!state && <p className="muted">Loading...</p>}
        {state?.exports.length === 0 && <p className="muted">No exports yet.</p>}
        {state?.exports.map((item) => <article className="candidate" key={item.artifactId}>
          <strong>{item.status}</strong>
          <p className="muted">{item.format.toUpperCase()} · {item.byteSize ?? "-"} bytes · {item.sha256 ?? "hash pending"}</p>
          {item.status === "committed" && <a href={apiPath(projectId, `/exports/${item.artifactId}/download`)}>Download {item.downloadFileName}</a>}
        </article>)}
      </section>
      <section className="panel">
        <h2>Derived telemetry</h2>
        <p className="muted">Exports: {telemetry?.exportCount.value ?? "-"} · committed: {telemetry?.committedExportCount.value ?? "-"} · readback pass: {telemetry?.readbackPassCount.value ?? "-"}</p>
        <button type="button" onClick={loadHandoff}>Show S7 to S8 handoff</button>
        {handoff && <pre>{JSON.stringify(handoff, null, 2)}</pre>}
      </section>
    </main>
  );
}
