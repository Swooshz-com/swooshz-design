import { AppError, type S5LayoutPlan, type S5UnknownItem } from "./types";
import { canonicalPlanJson, layoutS5Label, s5LabelLineWidthUnits, S5_Q16_DENOMINATOR, verifyPlanHash } from "./s5-layout";
import { sha256 } from "./utils";

export const S5_SVG_RENDERER_VERSION = "s5-layout-svg-v1" as const;

const PALETTE = {
  paper: "#fffdf8",
  ink: "#17202a",
  muted: "#65727e",
  booth: "#243b53",
  circulation: "#d97706",
  reception_welcome: "#0f766e",
  presentation_display: "#db2777",
  demo_product: "#7c3aed",
  consultation_meeting: "#2563eb",
  storage: "#64748b",
  interactive_activity: "#0891b2",
  photo_branding: "#4f46e5",
  giveaway_brochure: "#65a30d",
  other_confirmed: "#b45309",
} as const;
const SVG_UNKNOWN_PANEL = { x: 475, y: 82, width: 250, height: 636 } as const;
const SVG_UNKNOWN_COLUMNS = 3;
const SVG_UNKNOWN_FONT_SIZE = 6;
const SVG_UNKNOWN_LINE_HEIGHT = 8;
const SVG_UNKNOWN_CONTENT_Y = 113;

type UnknownLegendEntry = { item: S5UnknownItem; count: number; lines: string[]; lineWidths: number[] };

function svgLayoutError(field = "layout"): AppError {
  return new AppError(422, "S5_LAYOUT_OVERCONSTRAINED", [{ field, code: "S5_LAYOUT_OVERCONSTRAINED" }]);
}

function unknownLegendEntries(plan: S5LayoutPlan): UnknownLegendEntry[] {
  const counts = new Map<string, number>();
  for (const zone of plan.zones) for (const instance of zone.instances) {
    if (instance.status !== "unplaced" || instance.unplacedReason === null) continue;
    const key = instance.requirementId + "|" + instance.unplacedReason;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return plan.unknowns.map((item) => {
    const count = counts.get((item.requirementId ?? "") + "|" + item.reason) ?? 0;
    const label = (count > 0 ? String(count) + "x" : "overflow:") + " " + item.label;
    return { item, count, lines: layoutS5Label(label), lineWidths: s5LabelLineWidthUnits(label) };
  });
}

function renderUnknownLegend(lines: string[], entries: readonly UnknownLegendEntry[]): void {
  if (!entries.length) return;
  const rowsPerColumn = Math.floor((SVG_UNKNOWN_PANEL.height - 31) / SVG_UNKNOWN_LINE_HEIGHT);
  let column = 0;
  let row = 0;
  for (const entry of entries) {
    if (row + entry.lines.length > rowsPerColumn) {
      column += 1;
      row = 0;
    }
    if (column >= SVG_UNKNOWN_COLUMNS) throw svgLayoutError("unknowns");
    const columnWidth = SVG_UNKNOWN_PANEL.width / SVG_UNKNOWN_COLUMNS;
    const x = SVG_UNKNOWN_PANEL.x + column * columnWidth + 2;
    if (entry.lineWidths.some((lineWidth) => lineWidth * SVG_UNKNOWN_FONT_SIZE + 4 > columnWidth)) throw svgLayoutError("unknowns");
    const groupId = id(entry.item.unknownId);
    lines.push('<g id="' + groupId + '" data-status="' + entry.item.status + '" data-reason="' + entry.item.reason + '" data-count="' + entry.count + '">');
    entry.lines.forEach((value, lineIndex) => {
      const y = SVG_UNKNOWN_CONTENT_Y + (row + lineIndex) * SVG_UNKNOWN_LINE_HEIGHT;
      if (y + SVG_UNKNOWN_FONT_SIZE > SVG_UNKNOWN_PANEL.y + SVG_UNKNOWN_PANEL.height) throw svgLayoutError("unknowns");
      lines.push('<text x="' + number(x) + '" y="' + number(y) + '" fill="' + PALETTE.other_confirmed + '" font-family="Noto Sans, sans-serif" font-size="' + SVG_UNKNOWN_FONT_SIZE + '">' + escapeXml(value) + "</text>");
    });
    lines.push("</g>");
    row += entry.lines.length;
  }
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function pxX(q16: number): number {
  return 100 + (q16 / S5_Q16_DENOMINATOR) * 1_000;
}

function pxY(q16: number): number {
  return 82 + (q16 / S5_Q16_DENOMINATOR) * 636;
}

function number(value: number): string {
  return value.toFixed(2).replace(/\.00$/u, "").replace(/(\.\d)0$/u, "$1");
}

function id(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-");
}

export function renderConceptLayoutSvg(plan: S5LayoutPlan): Buffer {
  verifyPlanHash(plan);
  const unknownEntries = unknownLegendEntries(plan);
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800" role="img" aria-labelledby="title desc">',
    `<title id="title">${escapeXml("Concept Layout Plan")}</title>`,
    `<desc id="desc">${escapeXml("Deterministic conceptual booth layout. Zone markers are not to scale.")}</desc>`,
    `<rect id="background" x="0" y="0" width="1200" height="800" fill="${PALETTE.paper}"/>`,
    `<text id="heading" x="48" y="42" fill="${PALETTE.ink}" font-family="Noto Sans, sans-serif" font-size="24" font-weight="700">Concept Layout Plan</text>`,
    `<text id="convention" x="48" y="68" fill="${PALETTE.muted}" font-family="Noto Sans, sans-serif" font-size="12">Origin NW - X east - Y south - conceptual Q16 - not to scale</text>`,
    `<rect id="booth" x="100" y="82" width="1000" height="636" fill="none" stroke="${PALETTE.booth}" stroke-width="4"/>`,
  ];
  if (unknownEntries.length) {
    lines.push('<rect id="unplaced-panel" x="475" y="82" width="250" height="636" fill="' + PALETTE.paper + '" fill-opacity="0.94"/>');
    lines.push('<text id="unplaced-heading" x="486" y="100" fill="' + PALETTE.ink + '" font-family="Noto Sans, sans-serif" font-size="8" font-weight="700">Unplaced / unknown (count-only)</text>');
  }
  for (const path of plan.circulation) {
    lines.push(`<g id="${id(path.pathId)}" fill="none" stroke="${PALETTE.circulation}" stroke-width="5" stroke-dasharray="12 9" opacity="0.86"><line x1="${number(pxX(path.startXQ16))}" y1="${number(pxY(path.startYQ16))}" x2="${number(pxX(path.endXQ16))}" y2="${number(pxY(path.endYQ16))}"/></g>`);
  }
  for (const zone of plan.zones) {
    const color = PALETTE[zone.category];
    lines.push(`<g id="${id(zone.zoneId)}" data-category="${escapeXml(zone.category)}">`);
    for (const instance of zone.instances) {
      if (instance.status === "placed" && instance.xQ16 !== null && instance.yQ16 !== null && instance.widthQ16 !== null && instance.heightQ16 !== null) {
        const x = pxX(instance.xQ16); const y = pxY(instance.yQ16);
        const width = instance.widthQ16 / S5_Q16_DENOMINATOR * 1_000; const height = instance.heightQ16 / S5_Q16_DENOMINATOR * 636;
        lines.push(`<g id="${id(instance.instanceId)}"><rect x="${number(x)}" y="${number(y)}" width="${number(width)}" height="${number(height)}" rx="8" fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-width="2"/>`);
        const labelLines = layoutS5Label(instance.label);
        const labelWidths = s5LabelLineWidthUnits(instance.label);
        const symbolLines = instance.symbols.flatMap((symbol) => layoutS5Label(symbol.kind + " - symbolic"));
        const symbolWidths = instance.symbols.flatMap((symbol) => s5LabelLineWidthUnits(symbol.kind + " - symbolic"));
        if (labelWidths.some((lineWidth) => lineWidth * 10 + 8 > width) || symbolWidths.some((lineWidth) => lineWidth * 7 + 8 > width)) throw svgLayoutError("zones");
        const contentHeight = 15 + labelLines.length * 11 + (symbolLines.length ? 3 + symbolLines.length * 9 : 0) + 2;
        if (contentHeight > height) throw svgLayoutError("zones");
        labelLines.forEach((value, lineIndex) => {
          lines.push('<text x="' + number(x + 8) + '" y="' + number(y + 15 + lineIndex * 11) + '" fill="' + PALETTE.ink + '" font-family="Noto Sans, sans-serif" font-size="10">' + escapeXml(value) + "</text>");
        });
        symbolLines.forEach((value, lineIndex) => {
          lines.push('<text x="' + number(x + 8) + '" y="' + number(y + 15 + labelLines.length * 11 + 3 + lineIndex * 9) + '" fill="' + PALETTE.muted + '" font-family="Noto Sans, sans-serif" font-size="7">' + escapeXml(value) + "</text>");
        });
        lines.push("</g>");
      }
    }
    lines.push("</g>");
  }
  renderUnknownLegend(lines, unknownEntries);
  lines.push(`<text id="disclaimer" x="48" y="786" fill="${PALETTE.muted}" font-family="Noto Sans, sans-serif" font-size="10">${escapeXml(plan.disclaimers[3] ?? "Conceptual only")}</text>`);
  lines.push("</svg>");
  return Buffer.from(lines.join("\n") + "\n", "utf8");
}

export function svgHash(plan: S5LayoutPlan): string {
  return sha256(renderConceptLayoutSvg(plan));
}

export function svgInputFingerprint(plan: S5LayoutPlan): string {
  return sha256(canonicalPlanJson(plan));
}
