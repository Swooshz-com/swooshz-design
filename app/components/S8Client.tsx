"use client";

import { useCallback, useEffect, useState } from "react";
import type { S6ToS7Handoff, S7ToS8Handoff } from "../../src/lib/types";

type S8Preparation = {
  profile: "swooshz-fbx-static-mesh-v1";
  semanticVersion: "swooshz-fbx-semantic-v1";
  sourceRevisionId: string;
  sourceRevisionHash: string;
  objectNames: string[];
  payloadSha256: string;
};

type S8Export = {
  artifactId: string;
  status: "queued" | "running" | "staged" | "validated" | "promoted" | "committed" | "stale" | "failed_retryable" | "failed_terminal" | "aborted";
  publicationPhase: string;
  downloadFileName: string;
};

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: { code?: string } };
  if (!response.ok) throw new Error(body.error?.code ?? "S8_SOURCE_NOT_READY");
  return body;
}
export function S8Screen({ projectId }: { projectId: string }) {
  const [s6, setS6] = useState<S6ToS7Handoff | null>(null);
  const [s7, setS7] = useState<S7ToS8Handoff | null>(null);
  const [s8, setS8] = useState<S8Preparation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportRecord, setExportRecord] = useState<S8Export | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [nextS6, nextS7, nextS8] = await Promise.all([
        fetch(`/api/projects/${projectId}/s6/handoff`, { cache: "no-store" }).then((response) => readJson<S6ToS7Handoff>(response)),
        fetch(`/api/projects/${projectId}/s7/handoff`, { cache: "no-store" }).then((response) => readJson<S7ToS8Handoff>(response)),
        fetch(`/api/projects/${projectId}/s8/handoff`, { cache: "no-store" }).then((response) => readJson<S8Preparation>(response)),
      ]);
      if (nextS7.sourceRevisionId !== nextS6.acceptedRevisionId || nextS7.sourceRevisionHash !== nextS6.acceptedRevisionHash) throw new Error("S8_SOURCE_BINDING_MISMATCH");
      if (nextS8.sourceRevisionId !== nextS6.acceptedRevisionId || nextS8.sourceRevisionHash !== nextS6.acceptedRevisionHash) throw new Error("S8_SOURCE_BINDING_MISMATCH");
      setS6(nextS6);
      setS7(nextS7);
      setS8(nextS8);
    } catch (caught) {
      setS6(null);
      setS7(null);
      setS8(null);
      setError(caught instanceof Error ? caught.message : "S8_SOURCE_NOT_READY");
    }
  }, [projectId]);

  const createExport = useCallback(async () => {
    setExporting(true);
    setError(null);
    try {
      const idempotencyKey = crypto.randomUUID();
      const response = await fetch(`/api/projects/${projectId}/s8/exports`, {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": idempotencyKey, "x-request-id": crypto.randomUUID() },
        body: "{}",
      });
      setExportRecord(await readJson<{ export: S8Export }>(response).then((body) => body.export));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "S8_PUBLICATION_FAILED");
    } finally {
      setExporting(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <main className="page-shell">
      <section className="panel">
        <p className="eyebrow">S8 production handoff</p>
        <h1>Editable 3D FBX</h1>
        <p className="muted">The FBX is derived from the accepted S6 spatial model. Blender serializes explicit Swooshz geometry; it does not remodel or repair the booth.</p>
        <p className="muted">Materials are preview materials only. The export contains no UVs, textures, animation, cameras, lights, or native 3ds Max claims.</p>
        <button type="button" onClick={() => void load()}>Refresh source admission</button>
        <button type="button" onClick={() => void createExport()} disabled={exporting || !s8}>{exporting ? "Publishing FBX..." : "Create FBX export"}</button>
        {error ? <p role="alert">Source not ready: {error}</p> : null}
        {s6 && s7 ? (
          <dl>
            <dt>Status</dt><dd>Ready for isolated FBX worker</dd>
            <dt>S6 revision</dt><dd><code>{s6.acceptedRevisionId}</code></dd>
            <dt>S6 hash</dt><dd><code>{s6.acceptedRevisionHash}</code></dd>
            <dt>S7 cross-output artifact</dt><dd><code>{s7.s7ArtifactId}</code></dd>
            <dt>Profile</dt><dd><code>swooshz-fbx-static-mesh-v1</code></dd>
            <dt>Payload fingerprint</dt><dd><code>{s8?.payloadSha256}</code></dd>
            <dt>Source-rigid objects</dt><dd>{s8?.objectNames.length ?? 0}</dd>
            <dt>Publication</dt><dd>Private staging and independent validation required before commit</dd>
            {exportRecord ? <><dt>Export status</dt><dd>{exportRecord.status} ({exportRecord.publicationPhase})</dd><dt>Artifact</dt><dd>{exportRecord.status === "committed" ? <a href={`/api/projects/${projectId}/s8/exports/${exportRecord.artifactId}/download`}>{exportRecord.downloadFileName}</a> : exportRecord.artifactId}</dd></> : null}
          </dl>
        ) : null}
      </section>
    </main>
  );
}
