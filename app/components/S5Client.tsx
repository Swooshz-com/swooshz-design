"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createIdempotencyKeyRetainer,
  type IdempotencyKeyRetainer,
  UnknownNetworkOutcome,
  withRetainedIdempotencyKey,
} from "../../src/lib/client-idempotency";
import type { S5MutationFence, S5ReopenReason } from "../../src/lib/types";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
type S5Approval = {
  status: "not_approved" | "approved" | "reopened";
  locked: boolean;
  approvalEventId: string | null;
  approvalId: string | null;
  approvalGeneration: number;
  eventSequence: number;
  observedSelectionVersion: number | null;
  observedActiveRevisionId: string | null;
  observedLineageRootRevisionId: string | null;
};
type S5Artifact = {
  artifactId: string;
  artifactGroupId: string;
  kind: "plan_json" | "plan_svg" | "presentation_pdf";
  status: "queued" | "running" | "staged" | "committed" | "failed_retryable" | "failed_terminal" | "aborted";
  attempt: 1 | 2;
  completedAt: string | null;
  terminalAt: string | null;
  failureCode: string | null;
  sourceLayoutGroupId: string | null;
  pageCount: number | null;
};
type S5State = { projectId: string; approval: S5Approval; artifacts: S5Artifact[]; fence: S5MutationFence };
type HeroStatus = { available: boolean; contentType: "image/png"; fileName: string };
type S5OperationResult = { artifactGroupId?: string; artifactId?: string; artifacts?: S5Artifact[]; replayed?: boolean };

function apiPath(projectId: string, suffix = ""): string {
  return "/api/projects/" + projectId + "/s5" + suffix;
}

async function readJson(response: Response): Promise<any> {
  let body: any;
  try { body = await response.json(); }
  catch {
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
    try { response = await request(key); }
    catch { throw new UnknownNetworkOutcome(); }
    return readJson(response);
  });
}

function defaultFetch(input: string, init?: RequestInit): Promise<Response> { return fetch(input, init); }

export function createS5Client(options: { projectId: string; operationKeys?: IdempotencyKeyRetainer; fetcher?: Fetcher }) {
  const keys = options.operationKeys ?? createIdempotencyKeyRetainer();
  const fetcher = options.fetcher ?? defaultFetch;
  const refresh = async (): Promise<S5State> => readJson(await fetcher(apiPath(options.projectId), { cache: "no-store" }));
  const hero = async (): Promise<HeroStatus> => readJson(await fetcher(apiPath(options.projectId, "/hero"), { cache: "no-store" }));
  const mutate = (operation: string, suffix: string, body: Record<string, unknown>) => withKey(
    keys,
    operation,
    JSON.stringify(body),
    (key) => fetcher(apiPath(options.projectId, suffix), {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    }),
  );
  return {
    refresh,
    hero,
    approve: (fence: S5MutationFence) => mutate("s5_approve", "/approval", fence),
    reopen: (fence: S5MutationFence, reopenReason: S5ReopenReason) => mutate("s5_reopen", "/reopen", { ...fence, reopenReason }),
    generateLayout: (fence: S5MutationFence) => mutate("s5_layout", "/layout", fence) as Promise<S5OperationResult>,
    retryLayout: (layoutGroupId: string, fence: S5MutationFence) => mutate("s5_layout_retry", "/layout/" + layoutGroupId + "/retry", fence) as Promise<S5OperationResult>,
    generatePresentation: (fence: S5MutationFence) => mutate("s5_presentation", "/presentation", fence) as Promise<S5OperationResult>,
    retryPresentation: (artifactId: string, fence: S5MutationFence) => mutate("s5_presentation_retry", "/presentation/" + artifactId + "/retry", fence) as Promise<S5OperationResult>,
  };
}

function statusCopy(status: S5Artifact["status"]): string {
  return {
    queued: "Queued",
    running: "Rendering",
    staged: "Publishing privately",
    committed: "Committed",
    failed_retryable: "Retry available",
    failed_terminal: "Terminal failure",
    aborted: "Aborted",
  }[status];
}

function artifactLabel(kind: S5Artifact["kind"]): string {
  return kind === "plan_json" ? "Canonical plan JSON" : kind === "plan_svg" ? "Deterministic plan SVG" : "Presentation PDF";
}

function fenceReady(fence: S5MutationFence): boolean {
  return Boolean(fence.expectedGenerationSetId && fence.expectedSelectionStateId && fence.expectedActiveRevisionId && fence.expectedSelectionVersion >= 1);
}

export function S5Screen({ projectId }: { projectId: string }) {
  const [state, setState] = useState<S5State | null>(null);
  const [hero, setHero] = useState<HeroStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const keys = useRef<IdempotencyKeyRetainer | null>(null);
  if (!keys.current) keys.current = createIdempotencyKeyRetainer();
  const client = useMemo(() => createS5Client({ projectId, operationKeys: keys.current! }), [projectId]);

  const refresh = async () => {
    try {
      const [next, nextHero] = await Promise.all([client.refresh(), client.hero()]);
      setState(next); setHero(nextHero); setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The request could not be completed.");
    }
  };

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const [next, nextHero] = await Promise.all([client.refresh(), client.hero()]);
        if (active) { setState(next); setHero(nextHero); setError(""); }
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "The request could not be completed.");
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, [client]);

  async function mutate(action: () => Promise<unknown>, message: string) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); await refresh(); setNotice(message); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); await refresh(); }
    finally { setBusy(false); }
  }

  const layoutGroups = state ? [...new Set(state.artifacts.filter((item) => item.kind === "plan_json" || item.kind === "plan_svg").map((item) => item.artifactGroupId))] : [];
  const presentation = state?.artifacts.filter((item) => item.kind === "presentation_pdf").sort((left, right) => right.attempt - left.attempt || right.artifactId.localeCompare(left.artifactId))[0] ?? null;
  const approved = state?.approval.status === "approved";
  const canAct = Boolean(state && approved && !busy && fenceReady(state.fence));

  return <main>
    <p className="muted">Swooshz Design / S5 concept layout and presentation</p>
    <h1>Concept Layout Plan</h1>
    <p className="disclaimer">This is a deterministic concept-stage plan. It does not infer image pixels or invent surveyed doors, coordinates, aisle widths, furniture dimensions, or engineering geometry.</p>
    {error ? <p className="error" role="alert">{error}</p> : null}
    {notice ? <p className="success" role="status">{notice}</p> : null}
    <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh persisted state</button>
    {state ? <>
      <section className="panel">
        <h2>Approval fence</h2>
        <p>Approval: <strong>{state.approval.status}</strong> / generation {state.approval.approvalGeneration} / event sequence {state.approval.eventSequence}</p>
        <p>Selection version {state.fence.expectedSelectionVersion} / active revision {state.fence.expectedActiveRevisionId}</p>
        <p className="muted">Every mutation uses the displayed project-global fence. A stale selection or revision is rejected and refreshed.</p>
        {state.approval.status !== "approved" ? <button type="button" disabled={busy || !fenceReady(state.fence)} onClick={() => void mutate(() => client.approve(state.fence), "Approval recorded by the server.")}>Approve current final visual</button> : <>
          <p className="success">The approved visual is locked against S1-S4 mutation until this approval is explicitly reopened.</p>
          <button type="button" disabled={busy} onClick={() => void mutate(() => client.reopen(state.fence, "user_requested"), "Approval reopened by the server.")}>Reopen approval</button>
        </>}
      </section>
      <section className="panel">
        <h2>Approved hero</h2>
        {hero?.available ? <>
          <p>The hero is integrity-verified against the approved active revision.</p>
          <img src={apiPath(projectId, "/hero/download")} alt="Approved visual hero" loading="lazy" style={{ maxWidth: "100%", height: "auto" }} />
          <a href={apiPath(projectId, "/hero/download")}>Download approved hero (PNG)</a>
        </> : <p className="muted">No verified approved hero is available yet.</p>}
      </section>
      <section className="panel">
        <h2>Deterministic layout artifacts</h2>
        <p>Canonical JSON is committed before its companion SVG can be used as the layout source for the presentation.</p>
        <button type="button" disabled={!canAct} onClick={() => void mutate(() => client.generateLayout(state.fence), "Layout generation completed or was safely replayed.")}>Generate concept layout</button>
        {layoutGroups.length === 0 ? <p className="muted">No layout artifact group has been committed.</p> : layoutGroups.map((groupId) => <article className="candidate" key={groupId}>
          <h3>Artifact group {groupId}</h3>
          {state.artifacts.filter((item) => item.artifactGroupId === groupId).map((artifact) => <p key={artifact.artifactId}>{artifactLabel(artifact.kind)}: <strong>{statusCopy(artifact.status)}</strong> / attempt {artifact.attempt}{artifact.failureCode ? " / " + artifact.failureCode : ""}</p>)}
          {state.artifacts.filter((item) => item.artifactGroupId === groupId).some((item) => item.status === "failed_retryable") ? <button type="button" disabled={!canAct} onClick={() => void mutate(() => client.retryLayout(groupId, state.fence), "Layout retry completed or was safely replayed.")}>Retry layout group</button> : null}
        </article>)}
      </section>
      <section className="panel">
        <h2>Presentation export</h2>
        <p>Five deterministic sections are rendered server-side with searchable Unicode text and private no-store delivery.</p>
        <button type="button" disabled={!canAct || layoutGroups.length === 0} onClick={() => void mutate(() => client.generatePresentation(state.fence), "Presentation export completed or was safely replayed.")}>Generate presentation PDF</button>
        {presentation ? <article className="candidate">
          <h3>{artifactLabel(presentation.kind)}: {statusCopy(presentation.status)}</h3>
          <p>Attempt {presentation.attempt}{presentation.pageCount === null ? "" : " / " + presentation.pageCount + " pages"}{presentation.failureCode ? " / " + presentation.failureCode : ""}</p>
          {presentation.status === "committed" ? <a href={apiPath(projectId, "/presentation/" + presentation.artifactId + "/download")}>Download presentation PDF</a> : null}
          {presentation.status === "failed_retryable" ? <button type="button" disabled={!canAct} onClick={() => void mutate(() => client.retryPresentation(presentation.artifactId, state.fence), "Presentation retry completed or was safely replayed.")}>Retry presentation PDF</button> : null}
        </article> : <p className="muted">No presentation export has been committed.</p>}
      </section>
      <section className="panel">
        <h2>Concept-stage boundary</h2>
        <p>The S6 handoff is read-only. This screen does not create engineering geometry, costing, CAD, 3D, venue measurements, or provider billing data.</p>
        <p className="muted">Telemetry remains unavailable unless the repository contains durable measurements; actual provider cost is never synthesized.</p>
      </section>
    </> : <p aria-live="polite">Loading persisted S5 state.</p>}
  </main>;
}
