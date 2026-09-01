import type { S5LayoutPlan } from "./types";
import { canonicalPlanJson, S5_Q16_DENOMINATOR, verifyPlanHash } from "./s5-layout";
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
  for (const path of plan.circulation) {
    lines.push(`<g id="${id(path.pathId)}" fill="none" stroke="${PALETTE.circulation}" stroke-width="5" stroke-dasharray="12 9" opacity="0.86"><line x1="${number(pxX(path.startXQ16))}" y1="${number(pxY(path.startYQ16))}" x2="${number(pxX(path.endXQ16))}" y2="${number(pxY(path.endYQ16))}"/></g>`);
  }
  let unknownIndex = 0;
  for (const zone of plan.zones) {
    const color = PALETTE[zone.category];
    lines.push(`<g id="${id(zone.zoneId)}" data-category="${escapeXml(zone.category)}">`);
    for (const instance of zone.instances) {
      if (instance.status === "placed" && instance.xQ16 !== null && instance.yQ16 !== null && instance.widthQ16 !== null && instance.heightQ16 !== null) {
        const x = pxX(instance.xQ16); const y = pxY(instance.yQ16);
        const width = instance.widthQ16 / S5_Q16_DENOMINATOR * 1_000; const height = instance.heightQ16 / S5_Q16_DENOMINATOR * 636;
        lines.push(`<g id="${id(instance.instanceId)}"><rect x="${number(x)}" y="${number(y)}" width="${number(width)}" height="${number(height)}" rx="8" fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-width="2"/>`);
        lines.push(`<text x="${number(x + 8)}" y="${number(y + 20)}" fill="${PALETTE.ink}" font-family="Noto Sans, sans-serif" font-size="12">${escapeXml(instance.label)}</text>`);
        for (const symbol of instance.symbols) {
          lines.push(`<text x="${number(x + 8)}" y="${number(y + 37)}" fill="${PALETTE.muted}" font-family="Noto Sans, sans-serif" font-size="10">${escapeXml(symbol.kind)} - symbolic</text>`);
        }
        lines.push("</g>");
      } else {
        unknownIndex += 1;
        lines.push(`<text id="${id(instance.instanceId)}" x="108" y="${number(736 + unknownIndex * 12)}" fill="${PALETTE.other_confirmed}" font-family="Noto Sans, sans-serif" font-size="10">Unplaced: ${escapeXml(instance.label)}</text>`);
      }
    }
    lines.push("</g>");
  }
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
