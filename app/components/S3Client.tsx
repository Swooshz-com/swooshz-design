"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createIdempotencyKeyRetainer,
  type IdempotencyKeyRetainer,
  UnknownNetworkOutcome,
  withRetainedIdempotencyKey,
} from "../../src/lib/client-idempotency";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
type S3Source = {
  sourceId: string;
  sourceKind: "s1_original" | "s2_repaired";
  candidateIndex: 1 | 2 | 3 | 4;
  sourceRevisionId: string;
  qaStatus: "PASS" | "WARNING";
  selected: boolean;
  eligible: boolean;
  previewAvailable: boolean;
};
type S3Revision = {
  revisionId: string;
  kind: "source_selection" | "refinement";
  parentRevisionId: string | null;
  cycleNumber: 0 | 1 | 2;
  sourceKind: "s1_original" | "s2_repaired";
  candidateIndex: 1 | 2 | 3 | 4;
  userIntentText: string | null;
  assessmentStatus: string;
  assessmentRetryAvailable: boolean;
  imageRetryAvailable: boolean;
  successfulSequence: 1 | 2 | null;
  activationState: "active_tip" | "usable_history" | "historical_non_activatable";
  active: boolean;
  usable: boolean;
  previewAvailable: boolean;
  createdAt: string;
};
type S3Cycle = {
  cycleId: string;
  cycleNumber: 1 | 2;
  status: string;
  baseRevisionId: string;
  outputRevisionId: string | null;
  assessmentStatus: string;
  imageRetryAvailable: boolean;
  assessmentRetryAvailable: boolean;
  slotConsumed: true;
};
export type S3State = {
  projectId: string;
  generationSetId: string;
  selectionVersion: number;
  activeRevisionId: string | null;
  cycleSlotsConsumed: 0 | 1 | 2;
  cycleSlotsRemaining: 0 | 1 | 2;
  successfulRefinementCount: 0 | 1 | 2;
  screenedCandidates: Array<{ candidateIndex: 1 | 2 | 3 | 4; sourceQaStatus: string; originalSourceId: string | null; repairedSourceIds: string[] }>;
  sources: S3Source[];
  revisions: S3Revision[];
  cycles: S3Cycle[];
};

function apiPath(projectId: string, suffix = ""): string {
  return "/api/projects/" + projectId + "/s3" + suffix;
}

async function readJson(response: Response): Promise<any> {
  let body: any;
  try {
    body = await response.json();
  } catch {
    if (response.ok) throw new UnknownNetworkOutcome();
    throw new Error("The request could not be completed. Reference: unavailable");
  }
  if (!response.ok) {
    throw new Error((body.error?.message ?? "The request could not be completed.") + " Reference: " + (body.error?.referenceId ?? "unavailable"));
  }
  return body;
}

async function withKey(
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
    return readJson(response);
  });
}

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

function useRetainer(): IdempotencyKeyRetainer {
  const ref = useRef<IdempotencyKeyRetainer | null>(null);
  if (!ref.current) ref.current = createIdempotencyKeyRetainer();
  return ref.current;
}

export function createS3Client(options: { projectId: string; operationKeys?: IdempotencyKeyRetainer; fetcher?: Fetcher }) {
  const keys = options.operationKeys ?? createIdempotencyKeyRetainer();
  const fetcher = options.fetcher ?? defaultFetch;
  const refresh = async (): Promise<S3State> => readJson(await fetcher(apiPath(options.projectId), { cache: "no-store" }));
  const select = (targetKind: "source_root" | "revision", targetId: string, expectedSelectionVersion: number) => withKey(
    keys,
    "s3_selection",
    JSON.stringify({ targetKind, targetId, expectedSelectionVersion }),
    (key) => fetcher(apiPath(options.projectId, "/selection"), {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ targetKind, targetId, expectedSelectionVersion }),
    }),
  );
  const refine = (baseRevisionId: string, expectedSelectionVersion: number, intentText: string) => withKey(
    keys,
    "s3_refinement",
    JSON.stringify({ baseRevisionId, expectedSelectionVersion, intentText }),
    (key) => fetcher(apiPath(options.projectId, "/refinements"), {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ baseRevisionId, expectedSelectionVersion, intentText }),
    }),
  );
  const retry = (cycleId: string, kind: "image" | "assessment") => withKey(
    keys,
    "s3_" + kind + "_retry",
    JSON.stringify({ cycleId }),
    (key) => fetcher(apiPath(options.projectId, "/refinements/" + cycleId + "/" + kind + "-retry"), {
      method: "POST",
      headers: { "Idempotency-Key": key },
    }),
  );
  return { refresh, select, refine, retry };
}

export function S3Screen({ projectId }: { projectId: string }) {
  const [state, setState] = useState<S3State | null>(null);
  const [intent, setIntent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const keys = useRetainer();
  const client = useMemo(() => createS3Client({ projectId, operationKeys: keys }), [projectId, keys]);

  const refresh = async () => {
    try {
      setState(await client.refresh());
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The request could not be completed.");
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1200);
    return () => window.clearInterval(timer);
  }, [client]);

  async function select(targetKind: "source_root" | "revision", targetId: string) {
    if (!state) return;
    setBusy(true);
    try { setState(await client.refresh().then(async (current) => { await client.select(targetKind, targetId, current.selectionVersion); return client.refresh(); })); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); await refresh(); }
    finally { setBusy(false); }
  }

  async function refine() {
    if (!state?.activeRevisionId || !intent.trim()) return;
    setBusy(true);
    try { await client.refine(state.activeRevisionId, state.selectionVersion, intent); setIntent(""); await refresh(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); await refresh(); }
    finally { setBusy(false); }
  }

  async function retry(cycleId: string, kind: "image" | "assessment") {
    setBusy(true);
    try { await client.retry(cycleId, kind); await refresh(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); await refresh(); }
    finally { setBusy(false); }
  }

  return <main>
    <p className="muted">Swooshz Design / S3 concept refinement</p>
    <h1>Concept selection and refinement</h1>
    <p className="disclaimer">The server-owned persisted state is authoritative. S3 performs whole-concept refinement only; masks and local-region editing are not available here.</p>
    {error ? <p className="error" role="alert">{error}</p> : null}
    <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh persisted state</button>
    {state ? <>
      <p className="muted">Selection version {state.selectionVersion} / {state.cycleSlotsRemaining} whole-concept cycle slot(s) remaining / {state.successfulRefinementCount} successful refinement(s)</p>
      <section className="panel">
        <h2>Screened sources</h2>
        <div className="candidate-grid">{state.screenedCandidates.flatMap((candidate) => [
          candidate.originalSourceId ? <article className="candidate" key={candidate.originalSourceId}><h3>Candidate {candidate.candidateIndex} / Original</h3><p>{candidate.sourceQaStatus}</p><button type="button" disabled={busy} onClick={() => void select("source_root", candidate.originalSourceId!)}>Select source</button></article> : null,
          ...candidate.repairedSourceIds.map((sourceId) => <article className="candidate" key={sourceId}><h3>Candidate {candidate.candidateIndex} / Repaired</h3><p>{candidate.sourceQaStatus}</p><button type="button" disabled={busy} onClick={() => void select("source_root", sourceId)}>Select source</button></article>),
        ])}</div>
        <div className="candidate-grid">{state.sources.filter((source) => source.eligible).map((source) => <article className="candidate" key={source.sourceId}>
          <h3>Candidate {source.candidateIndex} / {source.sourceKind === "s1_original" ? "Original" : "Repaired"}</h3>
          <p>{source.qaStatus} / {source.selected ? "Selected" : "Eligible"}</p>
          {source.previewAvailable ? <img src={apiPath(projectId, "/revisions/" + source.sourceRevisionId + "/preview")} alt={"Candidate " + source.candidateIndex + " source preview"} loading="lazy" style={{ maxWidth: "100%", height: "auto" }} /> : null}
          <button type="button" disabled={busy || source.selected} onClick={() => void select("source_root", source.sourceRevisionId)}>Select source</button>
        </article>)}</div>
      </section>
      <section className="panel">
        <h2>Refine selected concept</h2>
        <p>Describe a bounded preference. Confirmed geometry and requirements remain server-owned.</p>
        <textarea value={intent} maxLength={600} disabled={busy || !state.activeRevisionId || state.cycleSlotsRemaining === 0} onChange={(event) => setIntent(event.target.value)} placeholder="Example: make the reception feel warmer while preserving the confirmed layout." />
        <button type="button" disabled={busy || !intent.trim() || !state.activeRevisionId || state.cycleSlotsRemaining === 0} onClick={() => void refine()}>Start whole-concept refinement</button>
      </section>
      <section className="panel">
        <h2>Cycles</h2>
        {state.cycles.length === 0 ? <p>No refinement cycle admitted.</p> : state.cycles.map((cycle) => <article className="candidate" key={cycle.cycleId}><p>Cycle {cycle.cycleNumber}: <strong>{cycle.status}</strong> / assessment {cycle.assessmentStatus}</p>{cycle.imageRetryAvailable ? <button type="button" disabled={busy} onClick={() => void retry(cycle.cycleId, "image")}>Retry image</button> : null}{cycle.assessmentRetryAvailable ? <button type="button" disabled={busy} onClick={() => void retry(cycle.cycleId, "assessment")}>Retry assessment</button> : null}</article>)}
      </section>
      <section className="panel">
        <h2>Immutable revision history</h2>
        <ol>{state.revisions.map((revision) => <li key={revision.revisionId}>{revision.kind} / {revision.activationState} / assessment {revision.assessmentStatus}{revision.userIntentText ? " / " + revision.userIntentText : ""}{revision.usable && !revision.active ? <button type="button" disabled={busy} onClick={() => void select("revision", revision.revisionId)}>Rollback pointer</button> : null}</li>)}</ol>
      </section>
    </> : <p aria-live="polite">Loading persisted S3 state.</p>}
  </main>;
}
