"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  createIdempotencyKeyRetainer,
  type IdempotencyKeyRetainer,
  UnknownNetworkOutcome,
  withRetainedIdempotencyKey,
} from "../../src/lib/client-idempotency";
import type { S6ConcurrencyToken, S6CorrectionOperation, S6ViewId } from "../../src/lib/types";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
type ClientPrimitive =
  | { kind: "rect_prism"; dimensionsMm: { widthMm: number; depthMm: number; heightMm: number }; localAnchor: "floor" | "center" }
  | { kind: "round_prism"; radiusMm: number; heightMm: number; localAnchor: "floor" | "center" }
  | { kind: "profile_extrusion"; profile: { winding: "ccw-from-positive-y-v1"; vertices: Array<{ xMm: number; zMm: number }> }; heightMm: number; localAnchor: "floor" | "center" };
type ClientObject = {
  objectId: string;
  objectType: string;
  role: string;
  label: string;
  primitive: ClientPrimitive;
  transform: { positionMm: { xMm: number; yMm: number; zMm: number }; rotationMd: { xMd: number; yMd: number; zMd: number } };
  materialIds: string[];
  zoneIds: string[];
  requirementIds: string[];
  unknownIds: string[];
  editable?: boolean;
  removable?: boolean;
};
type ClientMaterial = {
  materialId: string;
  label: string;
  finishKind: string;
  colorHex?: string | null;
  [key: string]: unknown;
};
type ClientUnknown = {
  unknownId: string;
  kind: string;
  status: string;
  fieldPath?: string;
  question?: string;
};
type ClientModel = {
  modelRevisionId: string;
  status: string;
  designFormReview: {
    status: string;
    evidenceAssetId: string;
    evidenceAssetSha256: string;
    unresolvedUnknownIds?: string[];
    reviewedObjectIds?: string[];
    explicitSimplificationUnknownIds?: string[];
    acceptedByUser?: boolean;
  };
  booth?: { widthMm: number; depthMm: number; openSides: string[]; maxHeightMm: number | null };
  objects: ClientObject[];
  materials: ClientMaterial[];
  unknowns: ClientUnknown[];
};
export type S6ClientState = {
  projectId: string;
  source: { readiness: string; sourceS5Fingerprint: string | null; approvalEventId: string | null; approvalGeneration: number | null };
  currentAcceptedRevisionId: string | null;
  currentAcceptedRevisionHash: string | null;
  editableRevision: (Record<string, unknown> & { revisionId: string; status: string }) | null;
  revisions: Array<Record<string, unknown>>;
  views: Array<{ viewId: S6ViewId; revisionId: string; status: string; purpose: string; preservationOutcome: string | null }>;
  concurrency: S6ConcurrencyToken | null;
};
export type S6ClientData = {
  state: S6ClientState;
  revision: { revision: ClientModel; validation: Record<string, unknown> | null; views: S6ClientState["views"] } | null;
};

const VIEW_IDS: readonly S6ViewId[] = ["perspective-northwest", "perspective-southeast", "top-orthographic"];
const GEOMETRY_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  counter: ["rect_prism", "round_prism", "profile_extrusion"],
  display_plinth: ["rect_prism", "round_prism", "profile_extrusion"],
  screen: ["rect_prism", "profile_extrusion"],
  storage_volume: ["rect_prism", "profile_extrusion"],
  table: ["rect_prism", "round_prism"],
  seating_marker: ["rect_prism", "round_prism"],
  equipment_placeholder: ["rect_prism", "round_prism", "profile_extrusion"],
  overhead_volume: ["rect_prism", "round_prism", "profile_extrusion"],
  partition: ["rect_prism", "profile_extrusion"],
  box: ["rect_prism", "round_prism", "profile_extrusion"],
};

function apiPath(projectId: string, suffix = ""): string {
  return "/api/projects/" + projectId + "/s6" + suffix;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function readJson<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.ok) throw new UnknownNetworkOutcome();
    throw new Error("The request could not be completed. Reference: unavailable");
  }
  if (!response.ok) {
    const error = record(record(body).error);
    throw new Error(String(error.message ?? "The request could not be completed.") + " Reference: " + String(error.referenceId ?? "unavailable"));
  }
  return body as T;
}

async function withKey<T>(
  retainer: IdempotencyKeyRetainer,
  operation: string,
  input: unknown,
  request: (key: string) => Promise<Response>,
): Promise<T> {
  return withRetainedIdempotencyKey(retainer, operation, input, async (key) => {
    let response: Response;
    try {
      response = await request(key);
    } catch {
      throw new UnknownNetworkOutcome();
    }
    return readJson<T>(response);
  });
}

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

export function createS6Client(options: { projectId: string; operationKeys?: IdempotencyKeyRetainer; fetcher?: Fetcher }) {
  const keys = options.operationKeys ?? createIdempotencyKeyRetainer();
  const fetcher = options.fetcher ?? defaultFetch;
  const refresh = async (): Promise<S6ClientData> => {
    const state = await readJson<S6ClientState>(await fetcher(apiPath(options.projectId), { cache: "no-store" }));
    const revisionId = state.editableRevision?.revisionId ?? state.currentAcceptedRevisionId;
    const revision = revisionId
      ? await readJson<S6ClientData["revision"]>(await fetcher(apiPath(options.projectId, "/revisions/" + revisionId), { cache: "no-store" }))
      : null;
    return { state, revision };
  };
  const mutate = <T,>(operation: string, suffix: string, body: Record<string, unknown>): Promise<T> => withKey(
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
    generate: () => mutate("s6_generation", "/generation", {}),
    reopen: (token: S6ConcurrencyToken) => mutate("s6_reopen", "/revisions/" + token.expectedRevisionId + "/reopen", token),
    correct: (token: S6ConcurrencyToken, operations: S6CorrectionOperation[]) => mutate("s6_correction", "/revisions/" + token.expectedRevisionId + "/corrections", { ...token, operations }),
    validate: (token: S6ConcurrencyToken) => mutate("s6_validation", "/revisions/" + token.expectedRevisionId + "/validate", token),
    accept: (token: S6ConcurrencyToken) => mutate("s6_acceptance", "/revisions/" + token.expectedRevisionId + "/accept", token),
    render: (token: S6ConcurrencyToken) => mutate("s6_render", "/revisions/" + token.expectedRevisionId + "/render", token),
    publish: (token: S6ConcurrencyToken, viewId: S6ViewId) => mutate("s6_publication", "/revisions/" + token.expectedRevisionId + "/views/" + viewId + "/publish", token),
  };
}

function geometryCorrection(object: ClientObject, kind: string, widthMm: number, depthMm: number, radiusMm: number, heightMm: number, profileVertices: Array<{ xMm: number; zMm: number }>): Record<string, unknown> {
  if (kind === "round_prism") return { kind, radiusMm, heightMm, localAnchor: object.primitive.localAnchor };
  if (kind === "profile_extrusion") return { kind, profile: { winding: "ccw-from-positive-y-v1", vertices: profileVertices }, heightMm, localAnchor: object.primitive.localAnchor };
  return { kind: "rect_prism", dimensionsMm: { widthMm, depthMm, heightMm }, localAnchor: object.primitive.localAnchor };
}

const MATERIAL_FINISH_KINDS = ["solid_color", "wood_like", "metal_like", "fabric_like", "glass_like", "brand_reference", "unknown"] as const;
type ClientMaterialFinishKind = typeof MATERIAL_FINISH_KINDS[number];

function materialFinishKind(value: string): ClientMaterialFinishKind {
  return (MATERIAL_FINISH_KINDS as readonly string[]).includes(value) ? value as ClientMaterialFinishKind : "unknown";
}

function commaSeparatedValues(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

const fieldStyle: CSSProperties = { display: "grid", gap: 6 };
const compactGrid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10 };

export function S6Screen({ projectId, initialData, fetcher }: { projectId: string; initialData?: S6ClientData; fetcher?: Fetcher }) {
  const [data, setData] = useState<S6ClientData | null>(initialData ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [geometryKind, setGeometryKind] = useState("rect_prism");
  const [radiusMm, setRadiusMm] = useState(450);
  const [widthMm, setWidthMm] = useState(900);
  const [depthMm, setDepthMm] = useState(900);
  const [heightMm, setHeightMm] = useState(1100);
  const [profileVertices, setProfileVertices] = useState<Array<{ xMm: number; zMm: number }>>([{ xMm: 0, zMm: 0 }, { xMm: 1200, zMm: 0 }, { xMm: 1200, zMm: 400 }, { xMm: 0, zMm: 400 }]);
  const [move, setMove] = useState({ xMm: 0, yMm: 0, zMm: 0 });
  const [rotation, setRotation] = useState({ xMd: 0, yMd: 0, zMd: 0 });
  const [materialLabel, setMaterialLabel] = useState("");
  const [finishKind, setFinishKind] = useState<ClientMaterialFinishKind>("unknown");
  const [colorHex, setColorHex] = useState("#888888");
  const [zoneIdsText, setZoneIdsText] = useState("");
  const [requirementIdsText, setRequirementIdsText] = useState("");
  const [reviewNote, setReviewNote] = useState("User confirmed the bounded typed form after reference review.");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const keys = useRef<IdempotencyKeyRetainer | null>(null);
  if (!keys.current) keys.current = createIdempotencyKeyRetainer();
  const client = useMemo(() => createS6Client({ projectId, operationKeys: keys.current!, fetcher }), [projectId, fetcher]);
  const model = data?.revision?.revision ?? null;
  const objects = model?.objects ?? [];
  const selected = objects.find((item) => item.objectId === selectedId) ?? objects[0] ?? null;
  const unresolved = model?.unknowns.filter((item) => item.status === "unresolved") ?? [];
  const currentToken = data?.state.concurrency ?? null;
  const draftPreview = data?.state.views.find((item) => item.viewId === "top-orthographic" && item.purpose === "draft_preview" && (item.status === "staged" || item.status === "promoted" || item.status === "committed") && item.preservationOutcome === "pass") ?? null;
  const topView = data?.state.views.find((item) => item.viewId === "top-orthographic" && item.purpose === "accepted_view" && item.status === "committed") ?? null;
  const draftPreviewUrl = draftPreview ? apiPath(projectId, "/revisions/" + draftPreview.revisionId + "/views/top-orthographic/download") : null;
  const topViewUrl = topView ? apiPath(projectId, "/revisions/" + topView.revisionId + "/views/top-orthographic/download") : null;
  const approvedReferenceUrl = "/api/projects/" + projectId + "/s5/hero/download";
  const reviewed = model?.designFormReview.status === "complete" && model.designFormReview.acceptedByUser === true && unresolved.length === 0;
  const allowedShapes = selected ? GEOMETRY_ALLOWLIST[selected.objectType] ?? ["rect_prism"] : ["rect_prism"];
  const selectedIsEditable = Boolean(selected && selected.editable !== false && selected.role !== "booth_floor" && selected.role !== "booth_wall" && selected.role !== "zone");

  useEffect(() => {
    if (initialData) return;
    let active = true;
    void client.refresh().then((next) => { if (active) setData(next); }).catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : "The request could not be completed."); });
    return () => { active = false; };
  }, [client, initialData]);

  useEffect(() => {
    if (!selected) return;
    setSelectedId(selected.objectId);
    setGeometryKind(selected.primitive.kind);
    if (selected.primitive.kind === "rect_prism") {
      setWidthMm(selected.primitive.dimensionsMm.widthMm);
      setDepthMm(selected.primitive.dimensionsMm.depthMm);
    }
    setHeightMm(selected.primitive.kind === "round_prism" || selected.primitive.kind === "profile_extrusion" ? selected.primitive.heightMm : selected.primitive.dimensionsMm.heightMm);
    if (selected.primitive.kind === "round_prism") setRadiusMm(selected.primitive.radiusMm);
    if (selected.primitive.kind === "profile_extrusion") setProfileVertices(selected.primitive.profile.vertices);
    const selectedMaterial = model?.materials.find((item) => selected.materialIds.includes(item.materialId)) ?? model?.materials[0];
    if (selectedMaterial) {
      setMaterialLabel(selectedMaterial.label);
      setFinishKind(materialFinishKind(selectedMaterial.finishKind));
      setColorHex(/^#[0-9a-f]{6}$/iu.test(selectedMaterial.colorHex ?? "") ? selectedMaterial.colorHex! : "#888888");
    }
    setZoneIdsText(selected.zoneIds.join(", "));
    setRequirementIdsText(selected.requirementIds.join(", "));
    setMove({ xMm: 0, yMm: 0, zMm: 0 });
    setRotation(selected.transform.rotationMd);
  }, [selected?.objectId]);

  async function refresh(): Promise<void> {
    try { setData(await client.refresh()); setError(""); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be completed."); }
  }

  async function generateDraft(): Promise<void> {
    setBusy(true); setError(""); setNotice("");
    try {
      await client.generate();
      const generated = await client.refresh();
      setData(generated);
      const token = generated.state.concurrency;
      if (!token) throw new Error("The draft was created but could not be reloaded. Reference: unavailable");
      await client.render(token);
      setData(await client.refresh());
      setNotice("Fresh spatial draft generated. The diagnostic top preview is non-final and unpublishable.");
    } catch (caught) {
      setError(caught instanceof UnknownNetworkOutcome ? "Unknown network outcome. Retry the same action to reuse its key." : caught instanceof Error ? caught.message : "The request could not be completed.");
    } finally { setBusy(false); }
  }

  async function mutate(input: unknown, action: () => Promise<unknown>, message: string): Promise<void> {
    setBusy(true); setError(""); setNotice("");
    try { await action(); await refresh(); setNotice(message); }
    catch (caught) {
      setError(caught instanceof UnknownNetworkOutcome ? "Unknown network outcome. Retry the same action to reuse its key." : caught instanceof Error ? caught.message : "The request could not be completed.");
    } finally { setBusy(false); void input; }
  }

  async function correct(operation: S6CorrectionOperation, message: string): Promise<void> {
    if (!currentToken) return;
    await mutate(operation, () => client.correct(currentToken, [operation]), message);
  }

  const material = selected && model ? model.materials.find((item) => selected.materialIds.includes(item.materialId)) ?? model.materials[0] : null;
  const selectedGeometry = selected ? geometryCorrection(selected, geometryKind, widthMm, depthMm, radiusMm, heightMm, profileVertices) : null;
  const selectedMaterial = material ? { ...material, label: materialLabel.trim() || material.label, finishKind, colorHex } : null;
  const selectedPosition = selected?.transform.positionMm ?? { xMm: 0, yMm: 0, zMm: 0 };
  const selectedRotation = selected?.transform.rotationMd ?? { xMd: 0, yMd: 0, zMd: 0 };
  const reviewObjectIds = unresolved
    .map((item) => /^objects\[(.+)\]\.primitive$/u.exec(item.fieldPath ?? "")?.[1])
    .filter((item): item is string => item !== undefined);

  return <main>
    <p className="muted">Swooshz Design / S6 spatial review</p>
    <h1>Spatial model review</h1>
    <p className="disclaimer">Review the bounded spatial draft against the approved reference. Accepted geometry remains typed, source-fenced, and revisioned.</p>
    {error ? <p className="error" role="alert">{error}</p> : null}
    {notice ? <p className="success" role="status">{notice}</p> : null}
    <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh persisted state</button>
    {!data ? <p aria-live="polite">Loading persisted spatial state.</p> : <>
      <section className="panel">
        <h2>Source and review status</h2>
        <p>Source readiness: <strong>{data.state.source.readiness}</strong></p>
        <p>Revision status: <strong>{model?.status ?? "not generated"}</strong></p>
        <p>Design-form review: <strong>{model?.designFormReview.status ?? "not available"}</strong>{reviewed ? " / complete" : " / acceptance blocked until explicit coverage"}</p>
        {model ? <p className="muted">Approved reference: <span aria-label="evidenceAssetId">{model.designFormReview.evidenceAssetId}</span> / {model.designFormReview.evidenceAssetSha256}</p> : null}
        <p className="muted">The approved reference is a private comparison visual; its pixels are never metric input.</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <button type="button" disabled={busy || data.state.source.readiness !== "ready" || data.state.editableRevision !== null || data.state.currentAcceptedRevisionId !== null} onClick={() => void generateDraft()}>Generate spatial draft</button>
          <button type="button" disabled={busy || !currentToken} onClick={() => currentToken && void mutate(currentToken, () => client.validate(currentToken), "Validation receipt reloaded.")}>Validate draft</button>
          <button type="button" disabled={busy || !currentToken || !reviewed} onClick={() => currentToken && void mutate(currentToken, () => client.accept(currentToken), "Accepted revision reloaded.")}>Accept reviewed model</button>
          <button type="button" disabled={busy || !currentToken || !reviewed} onClick={() => currentToken && void mutate(currentToken, () => client.render(currentToken), "Three coherent views staged for publication.")}>Render three views</button>
        </div>
      </section>
      <section className="panel">
        <h2>Top view / reference comparison</h2>
        <div className="candidate-grid">
          <figure className="candidate">
            <figcaption><strong>Approved private reference visual</strong></figcaption>
            <img src={approvedReferenceUrl} alt="Approved private S5 reference visual" style={{ width: "100%", maxHeight: 360, objectFit: "contain", background: "#f5f3ef", border: "1px solid #ddd7ce" }} />
          </figure>
          <figure className="candidate">
            <figcaption><strong>Spatial draft comparison</strong></figcaption>
            {draftPreviewUrl ? <img src={draftPreviewUrl} alt="Diagnostic draft preview top orthographic spatial view" style={{ width: "100%", maxHeight: 360, objectFit: "contain", background: "#f5f3ef", border: "1px solid #ddd7ce" }} /> : topViewUrl ? <img src={topViewUrl} alt="Persisted accepted top orthographic spatial view" style={{ width: "100%", maxHeight: 360, objectFit: "contain", background: "#f5f3ef", border: "1px solid #ddd7ce" }} /> : <p className="muted">Generate a spatial draft to create the diagnostic comparison preview.</p>}
          </figure>
        </div>
        {draftPreview ? <p className="muted">Diagnostic draft_preview: this top view is visibly non-final and unpublishable until the model is reviewed, accepted, and rendered as an accepted_view.</p> : null}
        <h3>Object selection</h3>
        <div className="candidate-grid">
          {objects.map((object) => <button key={object.objectId} type="button" data-object-id={object.objectId} aria-pressed={selected?.objectId === object.objectId} disabled={busy} onClick={() => setSelectedId(object.objectId)}>{object.label} / {object.primitive.kind}</button>)}
        </div>
      </section>
      <section className="panel">
        <h2>Typed correction</h2>
        {!selected ? <p className="muted">No editable object is selected.</p> : !selectedIsEditable ? <p className="muted">This server-owned booth or zone object is not editable. Hard facts remain outside the correction controls.</p> : <>
          <p>Selected object: <strong data-selected-object-id={selected.objectId}>{selected.label}</strong></p>
          <div style={compactGrid}>
            <label style={fieldStyle}>Shape family
              <select value={allowedShapes.includes(geometryKind) ? geometryKind : allowedShapes[0]} onChange={(event) => setGeometryKind(event.target.value)} disabled={busy}>
                {allowedShapes.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
              </select>
            </label>
            <label style={fieldStyle}>Width (mm)
              <input aria-label="Width" type="number" step={1} value={widthMm} onChange={(event) => setWidthMm(Number(event.target.value))} disabled={busy || geometryKind !== "rect_prism"} />
            </label>
            <label style={fieldStyle}>Depth (mm)
              <input aria-label="Depth" type="number" step={1} value={depthMm} onChange={(event) => setDepthMm(Number(event.target.value))} disabled={busy || geometryKind !== "rect_prism"} />
            </label>
            <label style={fieldStyle}>Radius (mm)
              <input aria-label="Radius" type="number" step={1} value={radiusMm} onChange={(event) => setRadiusMm(Number(event.target.value))} disabled={busy || geometryKind !== "round_prism"} />
            </label>
            <label style={fieldStyle}>Height (mm)
              <input aria-label="Height" type="number" step={1} value={heightMm} onChange={(event) => setHeightMm(Number(event.target.value))} disabled={busy} />
            </label>
          </div>
          {geometryKind === "profile_extrusion" ? <div>
            <p><strong>Profile vertices</strong> (integer X/Z, maximum 24)</p>
            {profileVertices.map((vertex, index) => <div key={index} style={{ ...compactGrid, marginBottom: 6 }}>
              <label style={fieldStyle}>X {index}<input type="number" value={vertex.xMm} onChange={(event) => setProfileVertices((current) => current.map((item, position) => position === index ? { ...item, xMm: Number(event.target.value) } : item))} /></label>
              <label style={fieldStyle}>Z {index}<input type="number" value={vertex.zMm} onChange={(event) => setProfileVertices((current) => current.map((item, position) => position === index ? { ...item, zMm: Number(event.target.value) } : item))} /></label>
              <button type="button" disabled={busy || profileVertices.length <= 3} onClick={() => setProfileVertices((current) => current.filter((_item, position) => position !== index))}>Remove vertex</button>
            </div>)}
            <button type="button" disabled={busy || profileVertices.length >= 24} onClick={() => setProfileVertices((current) => [...current, { xMm: 0, zMm: 0 }])}>Add profile vertex</button>
          </div> : <p className="muted">Profile vertices (integer X/Z, maximum 24) are available when profile_extrusion is selected.</p>}
          {material ? <div style={compactGrid}>
            <label style={fieldStyle}>Material label
              <input aria-label="Material label" type="text" value={materialLabel} onChange={(event) => setMaterialLabel(event.target.value)} disabled={busy} />
            </label>
            <label style={fieldStyle}>Finish
              <select aria-label="Finish" value={finishKind} onChange={(event) => setFinishKind(materialFinishKind(event.target.value))} disabled={busy}>
                {MATERIAL_FINISH_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
              </select>
            </label>
            <label style={fieldStyle}>Color
              <input aria-label="Material color" type="color" value={colorHex} onChange={(event) => setColorHex(event.target.value)} disabled={busy} />
            </label>
          </div> : null}
          <div style={compactGrid}>
            <label style={fieldStyle}>Zone IDs (comma separated)
              <input aria-label="Zone IDs" type="text" value={zoneIdsText} onChange={(event) => setZoneIdsText(event.target.value)} disabled={busy} />
            </label>
            <label style={fieldStyle}>Requirement IDs (comma separated)
              <input aria-label="Requirement IDs" type="text" value={requirementIdsText} onChange={(event) => setRequirementIdsText(event.target.value)} disabled={busy} />
            </label>
          </div>
          <div style={compactGrid}>
            {(["xMm", "yMm", "zMm"] as const).map((axis) => <label key={axis} style={fieldStyle}>Move {axis}<input type="number" value={move[axis]} onChange={(event) => setMove((current) => ({ ...current, [axis]: Number(event.target.value) }))} /></label>)}
            {(["xMd", "yMd", "zMd"] as const).map((axis) => <label key={axis} style={fieldStyle}>Rotate {axis}<input type="number" value={rotation[axis]} onChange={(event) => setRotation((current) => ({ ...current, [axis]: Number(event.target.value) }))} /></label>)}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <button type="button" disabled={busy || !currentToken} onClick={() => void correct({ kind: "replace_geometry", objectId: selected.objectId, geometry: selectedGeometry as never }, "Typed geometry correction saved as a child revision.")}>Save typed geometry</button>
            <button type="button" disabled={busy || !currentToken} onClick={() => void correct({ kind: "move", objectId: selected.objectId, deltaMm: move }, "Position correction saved as a child revision.")}>Move selected object</button>
            <button type="button" disabled={busy || !currentToken} onClick={() => void correct({ kind: "rotate", objectId: selected.objectId, rotationMd: rotation }, "Rotation correction saved as a child revision.")}>Rotate selected object</button>
            <button type="button" disabled={busy || !currentToken || selected.primitive.kind !== "rect_prism"} onClick={() => void correct({ kind: "resize", objectId: selected.objectId, dimensionsMm: { widthMm, depthMm, heightMm } }, "Rectangular dimensions saved as a child revision.")}>Resize selected object</button>
            {selectedMaterial ? <button type="button" disabled={busy || !currentToken} onClick={() => void correct({ kind: "material", objectId: selected.objectId, material: selectedMaterial as never }, "Material and finish correction saved without changing geometry.")}>Save material and finish</button> : null}
            <button type="button" disabled={busy || !currentToken} onClick={() => void correct({ kind: "zone_requirement_map", objectId: selected.objectId, zoneIds: commaSeparatedValues(zoneIdsText), requirementIds: commaSeparatedValues(requirementIdsText) }, "Zone and requirement mapping saved as a bounded correction.")}>Map zones and requirements</button>
            <button type="button" disabled={busy || !currentToken || selected.removable === false} onClick={() => void correct({ kind: "remove", objectId: selected.objectId }, "Removal saved as a visible draft correction.")}>Remove selected object</button>
            <button type="button" disabled={busy || !currentToken || !selectedMaterial} onClick={() => selectedMaterial && void correct({ kind: "add", objectType: "counter", role: "furniture", label: "Typed counter", geometry: { kind: "rect_prism", dimensionsMm: { widthMm: 900, depthMm: 600, heightMm: 900 }, localAnchor: "floor" } as never, positionMm: selectedPosition, rotationMd: selectedRotation, material: selectedMaterial as never, parentObjectId: null, zoneIds: selected.zoneIds, requirementIds: selected.requirementIds }, "A server-identified typed object was added to the draft.")}>Add typed counter</button>
          </div>
        </>}
      </section>
      <section className="panel">
        <h2>Design-form decision</h2>
        {unresolved.length === 0 ? <p className="success">No unresolved blocking form unknowns remain in the loaded revision.</p> : <>
          <p className="error">Unresolved or unsupported form blocks acceptance and final view publication.</p>
          <p>Review object IDs: <strong>{reviewObjectIds.length > 0 ? reviewObjectIds.join(", ") : "none linked in this response"}</strong></p>
          <label style={fieldStyle}>Review note
            <textarea aria-label="Review note" rows={3} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} disabled={busy} style={{ minHeight: 80 }} />
          </label>
          <button type="button" disabled={busy || !currentToken || reviewObjectIds.length === 0 || !reviewNote.trim()} onClick={() => currentToken && void correct({ kind: "confirm_design_inference", objectIds: reviewObjectIds, note: reviewNote }, "Bounded design inference confirmation saved.")}>Confirm design inference</button>
          {selected && selectedMaterial && unresolved[0] ? <button type="button" disabled={busy || !currentToken} onClick={() => currentToken && void correct({
            kind: "resolve_unknown",
            unknownId: unresolved[0]!.unknownId,
            resolutionKind: "explicit_simplification",
            resolutionNote: "User explicitly accepted this bounded typed simplification after review.",
            replacement: { objectType: selected.objectType as never, role: selected.role as never, label: selected.label, geometry: selectedGeometry as never, positionMm: selectedPosition, rotationMd: selectedRotation, material: selectedMaterial as never },
          }, "Explicit simplification decision saved with the original unknown preserved.")}>Record Explicit simplification</button> : null}
        </>}
      </section>
      <section className="panel">
        <h2>View artifacts</h2>
        <p className="muted">Only accepted_view artifacts can be published. draft_preview artifacts remain diagnostic and unpublishable.</p>
        {VIEW_IDS.map((viewId) => {
          const view = data.state.views.find((item) => item.viewId === viewId);
          return <article className="candidate" key={viewId}>
            <strong>{viewId}</strong>
            <p>{view ? view.status + " / preservation " + String(view.preservationOutcome ?? "pending") : "not rendered"}</p>
            <button type="button" disabled={busy || !currentToken || !reviewed || view?.purpose !== "accepted_view" || view.status !== "staged"} onClick={() => currentToken && void mutate({ viewId, token: currentToken }, () => client.publish(currentToken, viewId), "View published with exact private promotion.")}>Publish view</button>
          </article>;
        })}
      </section>
    </>}
  </main>;
}
