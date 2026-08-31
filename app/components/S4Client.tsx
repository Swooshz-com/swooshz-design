"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createIdempotencyKeyRetainer,
  type IdempotencyKeyRetainer,
  UnknownNetworkOutcome,
  withRetainedIdempotencyKey,
} from "../../src/lib/client-idempotency";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
export type S4Primitive =
  | { kind: "rectangle"; xQ16: number; yQ16: number; widthQ16: number; heightQ16: number }
  | { kind: "brush"; radiusQ8: number; points: Array<{ xQ16: number; yQ16: number }> };

export const S4_CLIENT_MAX_PRIMITIVES = 64;
export const S4_CLIENT_MAX_BRUSH_POINTS_PER_PRIMITIVE = 1_024;
export const S4_CLIENT_MAX_TOTAL_BRUSH_POINTS = 4_096;
export const S4_CLIENT_Q16_MAX = 65_536;
export const S4_CLIENT_MIN_BRUSH_RADIUS_Q8 = 64;
export const S4_CLIENT_MAX_BRUSH_RADIUS_Q8 = 25_600;
export const S4_CLIENT_MAX_INSTRUCTION_SCALARS = 600;
export const S4_CLIENT_MAX_INSTRUCTION_BYTES = 2_400;

export type S4InstructionDraftState = {
  scalarCount: number;
  utf8ByteCount: number;
  valid: boolean;
};

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { index += 1; continue; }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function normalizedInstruction(value: string): string {
  try { return value.normalize("NFC").trim(); } catch { return value.trim(); }
}

export function instructionDraftState(value: string): S4InstructionDraftState {
  const normalized = normalizedInstruction(value);
  const scalarCount = hasUnpairedSurrogate(normalized) ? Number.MAX_SAFE_INTEGER : Array.from(normalized).length;
  const utf8ByteCount = new TextEncoder().encode(normalized).byteLength;
  const valid = scalarCount >= 1 && scalarCount <= S4_CLIENT_MAX_INSTRUCTION_SCALARS &&
    utf8ByteCount <= S4_CLIENT_MAX_INSTRUCTION_BYTES &&
    !hasUnpairedSurrogate(normalized) && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(normalized);
  return { scalarCount, utf8ByteCount, valid };
}

function q16(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= S4_CLIENT_Q16_MAX;
}

export function isS4PrimitiveLocallyValid(primitive: S4Primitive): boolean {
  if (primitive.kind === "rectangle") {
    return q16(primitive.xQ16) && q16(primitive.yQ16) &&
      Number.isSafeInteger(primitive.widthQ16) && primitive.widthQ16 >= 1 && primitive.widthQ16 <= S4_CLIENT_Q16_MAX &&
      Number.isSafeInteger(primitive.heightQ16) && primitive.heightQ16 >= 1 && primitive.heightQ16 <= S4_CLIENT_Q16_MAX &&
      primitive.xQ16 + primitive.widthQ16 <= S4_CLIENT_Q16_MAX &&
      primitive.yQ16 + primitive.heightQ16 <= S4_CLIENT_Q16_MAX;
  }
  if (primitive.kind !== "brush" || !Number.isSafeInteger(primitive.radiusQ8) ||
      primitive.radiusQ8 < S4_CLIENT_MIN_BRUSH_RADIUS_Q8 || primitive.radiusQ8 > S4_CLIENT_MAX_BRUSH_RADIUS_Q8 ||
      !Array.isArray(primitive.points) || primitive.points.length < 1 || primitive.points.length > S4_CLIENT_MAX_BRUSH_POINTS_PER_PRIMITIVE) return false;
  return primitive.points.every((point) => q16(point.xQ16) && q16(point.yQ16));
}

function primitiveIdentity(primitive: S4Primitive): string {
  return primitive.kind === "rectangle"
    ? [primitive.kind, primitive.xQ16, primitive.yQ16, primitive.widthQ16, primitive.heightQ16].join(":")
    : JSON.stringify([primitive.kind, primitive.radiusQ8, primitive.points.map((point) => [point.xQ16, point.yQ16])]);
}

export function isS4DraftSubmitReady(input: {
  primitives: S4Primitive[];
  instructionText: string;
  hasActiveRevision: boolean;
  cyclesRemaining: number;
  busy?: boolean;
}): boolean {
  if (input.busy || !input.hasActiveRevision || !Number.isInteger(input.cyclesRemaining) || input.cyclesRemaining < 1 ||
      !Array.isArray(input.primitives) || input.primitives.length < 1 || input.primitives.length > S4_CLIENT_MAX_PRIMITIVES) return false;
  const identities = new Set<string>();
  let brushPointCount = 0;
  for (const primitive of input.primitives) {
    if (!isS4PrimitiveLocallyValid(primitive)) return false;
    const identity = primitiveIdentity(primitive);
    if (identities.has(identity)) return false;
    identities.add(identity);
    if (primitive.kind === "brush") brushPointCount += primitive.points.length;
  }
  if (brushPointCount > S4_CLIENT_MAX_TOTAL_BRUSH_POINTS) return false;
  return instructionDraftState(input.instructionText).valid;
}

export function isS4DraftClearEnabled(primitives: S4Primitive[], busy = false): boolean {
  return !busy && primitives.length > 0;
}
type S4Assessment = {
  status: string;
  requestedEditSatisfaction: string | null;
  overallRequirementResult: string | null;
  overallBuildabilityResult: string | null;
  materialFindingCount: number;
  warningFindingCount: number;
  uncertainFindingCount: number;
  retryAvailable: boolean;
};
type S4Edit = {
  editId: string;
  cycleNumber: 1 | 2;
  baseRevisionId: string;
  baseRevisionKind: "s3" | "s4";
  status: string;
  instructionText: string;
  maskReady: boolean;
  primitiveCount: number;
  editablePixelCount: number;
  comparisonPixelCount: number;
  outputRevisionId: string | null;
  preservationStatus: string;
  assessment: S4Assessment | null;
  imageRetryAvailable: boolean;
  assessmentRetryAvailable: boolean;
  activationState: "active_tip" | "usable_history" | "historical_non_activatable";
  previewAvailable: boolean;
  createdAt: string;
  terminalAt: string | null;
};
type S4State = {
  projectId: string;
  generationSetId: string;
  selectionVersion: number;
  activeRevisionId: string | null;
  activeRevisionKind: "s3" | "s4" | null;
  activeQuality: "PASS" | "WARNING" | null;
  activePreviewAvailable: boolean;
  stageStatus: "not_started" | "started";
  s3RefinementClosed: boolean;
  cyclesConsumed: 0 | 1 | 2;
  cyclesRemaining: 0 | 1 | 2;
  edits: S4Edit[];
};

function apiPath(projectId: string, suffix = ""): string {
  return "/api/projects/" + projectId + "/s4" + suffix;
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

export function createS4Client(options: { projectId: string; operationKeys?: IdempotencyKeyRetainer; fetcher?: Fetcher }) {
  const keys = options.operationKeys ?? createIdempotencyKeyRetainer();
  const fetcher = options.fetcher ?? defaultFetch;
  const refresh = async (): Promise<S4State> => readJson(await fetcher(apiPath(options.projectId), { cache: "no-store" }));
  const edit = (body: { baseRevisionId: string; expectedSelectionVersion: number; primitives: S4Primitive[]; instructionText: string }) => withKey(
    keys,
    "s4_edit_admission",
    JSON.stringify(body),
    (key) => fetcher(apiPath(options.projectId, "/edits"), {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    }),
  );
  const retry = (editId: string, kind: "image" | "assessment") => withKey(
    keys,
    "s4_" + kind + "_retry",
    editId,
    (key) => fetcher(apiPath(options.projectId, "/edits/" + editId + "/" + kind + "-retry"), {
      method: "POST",
      headers: { "Idempotency-Key": key },
    }),
  );
  const rollback = (targetId: string, expectedSelectionVersion: number) => withKey(
    keys,
    "s4_rollback",
    JSON.stringify({ targetId, expectedSelectionVersion }),
    (key) => fetcher("/api/projects/" + options.projectId + "/s3/selection", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ targetKind: "revision", targetId, expectedSelectionVersion }),
    }),
  );
  return { refresh, edit, retry, rollback };
}

function percentQ16(value: string): number { return Math.round(Number(value) * 655.36); }

function statusCopy(status: string): string {
  const labels: Record<string, string> = {
    preparing_mask: "Preparing local mask",
    generating: "Generating one image attempt",
    image_retry_available: "Image retry available",
    publication_pending: "Publishing privately",
    preservation_running: "Checking preservation",
    assessment_pending: "Preparing assessment",
    assessment_running: "Assessing requirements",
    assessment_retry_available: "Assessment retry available",
    usable_pass: "Usable - pass",
    usable_warning: "Usable - warning",
    material_fail: "Material preservation or QA failure",
    qa_unavailable: "QA unavailable",
    image_failed: "Image failed",
    publication_failed: "Publication failed",
    stale: "Stale - pointer moved",
    waived: "Retry waived",
  };
  return labels[status] ?? status;
}

export function S4Screen({ projectId, initialState = null }: { projectId: string; initialState?: S4State | null }) {
  const [state, setState] = useState<S4State | null>(initialState);
  const [instructionText, setInstructionText] = useState("");
  const [rect, setRect] = useState({ x: "20", y: "20", width: "30", height: "30" });
  const [brush, setBrush] = useState({ x: "50", y: "50", radius: "16" });
  const [primitives, setPrimitives] = useState<S4Primitive[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const keys = useRef<IdempotencyKeyRetainer | null>(null);
  if (!keys.current) keys.current = createIdempotencyKeyRetainer();
  const client = useMemo(() => createS4Client({ projectId, operationKeys: keys.current! }), [projectId]);
  const instruction = instructionDraftState(instructionText);
  const draftReady = Boolean(state && isS4DraftSubmitReady({
    primitives,
    instructionText,
    hasActiveRevision: Boolean(state.activeRevisionId),
    cyclesRemaining: state.cyclesRemaining,
    busy,
  }));

  const refresh = async () => {
    try { setState(await client.refresh()); setError(""); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); }
  };

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try { const next = await client.refresh(); if (active) setState(next); }
      catch (caught) { if (active) setError(caught instanceof Error ? caught.message : "The request could not be completed."); }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1200);
    return () => { active = false; window.clearInterval(timer); };
  }, [client]);

  function addRectangle() {
    const next: S4Primitive = {
      kind: "rectangle", xQ16: percentQ16(rect.x), yQ16: percentQ16(rect.y),
      widthQ16: percentQ16(rect.width), heightQ16: percentQ16(rect.height),
    };
    if (!isS4PrimitiveLocallyValid(next)) return;
    setPrimitives((current) => current.length >= S4_CLIENT_MAX_PRIMITIVES ? current : [...current, next]);
  }

  function addBrush() {
    const point = { xQ16: percentQ16(brush.x), yQ16: percentQ16(brush.y) };
    const radiusQ8 = Math.round(Number(brush.radius) * 256);
    const next: S4Primitive = { kind: "brush", radiusQ8, points: [point] };
    if (!isS4PrimitiveLocallyValid(next)) return;
    setPrimitives((current) => {
      const pointCount = current.reduce((sum, primitive) => sum + (primitive.kind === "brush" ? primitive.points.length : 0), 0);
      return current.length >= S4_CLIENT_MAX_PRIMITIVES || pointCount + 1 > S4_CLIENT_MAX_TOTAL_BRUSH_POINTS ? current : [...current, next];
    });
  }

  function clearLocalMask() {
    setPrimitives([]);
  }

  async function submit() {
    if (!state?.activeRevisionId || !isS4DraftSubmitReady({
      primitives,
      instructionText,
      hasActiveRevision: true,
      cyclesRemaining: state.cyclesRemaining,
    })) return;
    setBusy(true); setError("");
    try {
      await client.edit({
        baseRevisionId: state.activeRevisionId,
        expectedSelectionVersion: state.selectionVersion,
        primitives,
        instructionText,
      });
      setInstructionText(""); setPrimitives([]); await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The request could not be completed.");
      await refresh();
    } finally { setBusy(false); }
  }

  async function retry(editId: string, kind: "image" | "assessment") {
    setBusy(true); setError("");
    try { await client.retry(editId, kind); await refresh(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); await refresh(); }
    finally { setBusy(false); }
  }

  async function rollback(revisionId: string) {
    if (!state) return;
    setBusy(true); setError("");
    try { await client.rollback(revisionId, state.selectionVersion); await refresh(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); await refresh(); }
    finally { setBusy(false); }
  }

  return <main>
    <p className="muted">Swooshz Design / S4 local-region editing</p>
    <h1>Local edit stage</h1>
    <p className="disclaimer">Masks and instructions stay local to this editor until the server accepts an edit. The server-owned persisted state remains authoritative.</p>
    {error ? <p className="error" role="alert">{error}</p> : null}
    <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh persisted state</button>
    {state ? <>
      <section className="panel">
        <h2>Current pointer</h2>
        <p>Selection version {state.selectionVersion} / {state.cyclesRemaining} S4 cycle(s) remaining / stage {state.stageStatus}</p>
        <p>{state.activeRevisionKind ? "Active " + state.activeRevisionKind + " revision" : "No active visual revision"} {state.activeQuality ? "/ " + state.activeQuality : ""}</p>
        {state.activeRevisionId && state.activePreviewAvailable ? <img src={"/api/projects/" + projectId + "/s3/revisions/" + state.activeRevisionId + "/preview"} alt="Current active visual revision" loading="lazy" style={{ maxWidth: "100%", height: "auto" }} /> : null}
        {state.s3RefinementClosed ? <p className="muted">S3 whole-concept refinement is closed for this lineage while S4 is active.</p> : null}
      </section>
      <section className="panel">
        <h2>Local mask</h2>
        <p>Rectangles are normalized locally and sent as exact Q16 primitives. No source image bytes are uploaded by the editor.</p>
        <div className="candidate-grid">
          {(["x", "y", "width", "height"] as const).map((key) => <label key={key}>{key} (% 0-100)<input inputMode="decimal" value={rect[key]} disabled={busy} onChange={(event) => setRect({ ...rect, [key]: event.target.value })} /></label>)}
        </div>
        <button type="button" disabled={busy} onClick={addRectangle}>Add rectangle to local mask</button>
        <div className="candidate-grid">
          {(["x", "y", "radius"] as const).map((key) => <label key={key}>{key} ({key === "radius" ? "px" : "% 0-100"})<input inputMode="decimal" value={brush[key]} disabled={busy} onChange={(event) => setBrush({ ...brush, [key]: event.target.value })} /></label>)}
        </div>
        <button type="button" disabled={busy} onClick={addBrush}>Add brush point to local mask</button>
        <button type="button" disabled={!isS4DraftClearEnabled(primitives, busy)} onClick={clearLocalMask}>Clear local mask</button>
        <p>{primitives.length} local primitive(s) staged for submission.</p>
        {primitives.length ? <ol>{primitives.map((primitive, index) => <li key={index}>{primitive.kind === "rectangle" ? "Rectangle" : "Brush point"} {index + 1} / editable region</li>)}</ol> : null}
      </section>
      <section className="panel">
        <h2>Instruction</h2>
        <textarea aria-describedby="instruction-limits" value={instructionText} disabled={busy || state.cyclesRemaining === 0} onChange={(event) => setInstructionText(event.target.value)} placeholder="Example: replace the selected counter finish while preserving the booth geometry." />
        <p id="instruction-limits" aria-live="polite">{instruction.scalarCount}/{S4_CLIENT_MAX_INSTRUCTION_SCALARS} Unicode scalar values / {instruction.utf8ByteCount}/{S4_CLIENT_MAX_INSTRUCTION_BYTES} UTF-8 bytes {instruction.valid ? "- ready" : "- incomplete or over limit"}</p>
        <button type="button" disabled={busy || !draftReady} onClick={() => void submit()}>Submit local edit</button>
      </section>
      <section className="panel">
        <h2>Persisted edit history</h2>
        {state.edits.length === 0 ? <p>No S4 edit admitted.</p> : state.edits.map((edit) => <article className="candidate" key={edit.editId}>
          <h3>Cycle {edit.cycleNumber}: {statusCopy(edit.status)}</h3>
          <p>{edit.maskReady ? "Mask verified" : "Mask preparing"} / {edit.primitiveCount} primitive(s) / {edit.editablePixelCount} editable pixel(s)</p>
          <p>Preservation {edit.preservationStatus}{edit.assessment ? " / assessment " + edit.assessment.status : ""}</p>
          {edit.assessment ? <p>Requested edit: {edit.assessment.requestedEditSatisfaction ?? "pending"} / findings {edit.assessment.materialFindingCount} material, {edit.assessment.warningFindingCount} warning, {edit.assessment.uncertainFindingCount} uncertain</p> : null}
          {edit.imageRetryAvailable ? <button type="button" disabled={busy} onClick={() => void retry(edit.editId, "image")}>Retry image</button> : null}
          {edit.assessmentRetryAvailable ? <button type="button" disabled={busy} onClick={() => void retry(edit.editId, "assessment")}>Retry assessment</button> : null}
          {edit.outputRevisionId && edit.activationState === "usable_history" ? <button type="button" disabled={busy} onClick={() => void rollback(edit.outputRevisionId!)}>Rollback pointer to this revision</button> : null}
        </article>)}
      </section>
    </> : <p aria-live="polite">Loading persisted S4 state.</p>}
  </main>;
}
