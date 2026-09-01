import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { AppError } from "./types";
import type { BoothGeometry, S5LayoutPlan, S5LayoutRequirement, S5UnknownItem } from "./types";
import { S5_Q16_DENOMINATOR, verifyPlanHash } from "./s5-layout";
import { sha256 } from "./utils";

export const S5_PDF_RENDERER_VERSION = "s5-presentation-pdf-v1" as const;
export const S5_PDF_WIDTH = 595.28;
export const S5_PDF_HEIGHT = 841.89;
export const S5_PDF_MARGIN = 42.52;
export const S5_PDF_MAX_PAGES = 12;
export const S5_PDF_MIN_PAGES = 5;
export const S5_PDF_MAX_BYTES = 20_971_520;
export const S5_NOTO_SANS_ASSET = "src/assets/fonts/NotoSans-VF.ttf" as const;
export const S5_NOTO_SANS_SOURCE = "https://github.com/notofonts/noto-fonts/blob/ffebf8c1ee449e544955a7e813c54f9b73848eac/unhinted/variable-ttf/NotoSans-VF.ttf" as const;
export const S5_NOTO_SANS_SHA256 = "2af0393ceff5554cbcd6a51a017046f624525046cb0a218f5c7f94fe2324d673" as const;

export type S5PdfInput = {
  projectName: string;
  projectFacts: { clientName: string | null; eventName: string | null; venueName: string | null; eventLocation: string | null; eventStartDate: string | null; eventEndDate: string | null };
  geometry: BoothGeometry;
  quality: "PASS" | "WARNING";
  activeRevisionKind: string;
  plan: S5LayoutPlan;
  requirements: S5LayoutRequirement[];
  designRules: Array<{ ruleId: string; applicability: "applicable" | "not_applicable"; materiality: "material" | "warning"; repairable: boolean }>;
  unknowns: S5UnknownItem[];
  heroBytes: Uint8Array;
  fontBytes?: Uint8Array;
};
type Cursor = { page: PDFPage; y: number };

function pdfError(code: string, field = "pdf"): AppError { return new AppError(422, code, [{ field, code }]); }
export async function loadApprovedNotoSansFont(): Promise<Uint8Array> {
  try {
    const bytes = new Uint8Array(await readFile(join(process.cwd(), S5_NOTO_SANS_ASSET)));
    if (sha256(bytes) !== S5_NOTO_SANS_SHA256) throw new Error("font identity");
    return bytes;
  } catch { throw pdfError("S5_FONT_UNAVAILABLE", "font"); }
}
function ensureGlyphs(font: PDFFont, text: string): void { try { font.widthOfTextAtSize(text, 10); font.encodeText(text); } catch { throw pdfError("S5_PDF_UNICODE_UNSUPPORTED", "text"); } }
function wrap(font: PDFFont, value: string, size: number, width: number): string[] {
  const words = value.split(/\s+/u).filter(Boolean); if (!words.length) return [""]; const result: string[] = []; let current = "";
  for (const word of words) {
    ensureGlyphs(font, word); const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) { current = candidate; continue; }
    if (current) result.push(current);
    current = "";
    for (const character of Array.from(word)) {
      const next = current + character;
      if (current && font.widthOfTextAtSize(next, size) > width) { result.push(current); current = character; } else current = next;
    }
  }
  if (current) result.push(current); return result;
}
function addPage(document: PDFDocument): Cursor { if (document.getPageCount() >= S5_PDF_MAX_PAGES) throw pdfError("S5_PDF_OVERFLOW"); return { page: document.addPage([S5_PDF_WIDTH, S5_PDF_HEIGHT]), y: S5_PDF_HEIGHT - S5_PDF_MARGIN }; }
function line(document: PDFDocument, cursor: Cursor, font: PDFFont, value: string, options: { size?: number; color?: ReturnType<typeof rgb>; gap?: number } = {}): Cursor {
  const size = options.size ?? 10; const gap = options.gap ?? 15; ensureGlyphs(font, value); if (cursor.y < S5_PDF_MARGIN + size) cursor = addPage(document);
  cursor.page.drawText(value, { x: S5_PDF_MARGIN, y: cursor.y, size, font, color: options.color ?? rgb(0.09, 0.12, 0.16) }); return { page: cursor.page, y: cursor.y - gap };
}
function paragraph(document: PDFDocument, cursor: Cursor, font: PDFFont, value: string, options: { size?: number; color?: ReturnType<typeof rgb>; gap?: number; width?: number } = {}): Cursor {
  const size = options.size ?? 10; const width = options.width ?? S5_PDF_WIDTH - 2 * S5_PDF_MARGIN; let next = cursor;
  for (const part of value.split("\n")) for (const text of wrap(font, part, size, width)) next = line(document, next, font, text, options); return next;
}
function title(document: PDFDocument, cursor: Cursor, font: PDFFont, value: string): Cursor { return line(document, cursor, font, value, { size: 20, gap: 28, color: rgb(0.04, 0.25, 0.31) }); }
function section(document: PDFDocument, font: PDFFont, value: string): Cursor { return title(document, addPage(document), font, value); }
function displayPlan(document: PDFDocument, cursor: Cursor, font: PDFFont, plan: S5LayoutPlan): Cursor {
  const x = S5_PDF_MARGIN; const y = 210; const width = S5_PDF_WIDTH - 2 * S5_PDF_MARGIN; const height = 360;
  cursor.page.drawRectangle({ x, y, width, height, borderColor: rgb(0.14, 0.23, 0.33), borderWidth: 2, color: rgb(0.99, 0.98, 0.94) });
  const pxX = (q: number) => x + q / S5_Q16_DENOMINATOR * width; const pxY = (q: number) => y + height - q / S5_Q16_DENOMINATOR * height;
  for (const path of plan.circulation) cursor.page.drawLine({ start: { x: pxX(path.startXQ16), y: pxY(path.startYQ16) }, end: { x: pxX(path.endXQ16), y: pxY(path.endYQ16) }, thickness: 2, color: rgb(0.85, 0.45, 0.05), dashArray: [5, 4] });
  const colors: Record<string, ReturnType<typeof rgb>> = { reception_welcome: rgb(0.06, 0.46, 0.43), presentation_display: rgb(0.86, 0.12, 0.47), demo_product: rgb(0.49, 0.24, 0.70), consultation_meeting: rgb(0.15, 0.39, 0.78), storage: rgb(0.39, 0.45, 0.55), interactive_activity: rgb(0.03, 0.57, 0.70), photo_branding: rgb(0.31, 0.27, 0.78), giveaway_brochure: rgb(0.40, 0.64, 0.05), other_confirmed: rgb(0.71, 0.33, 0.05) };
  for (const zone of plan.zones) for (const instance of zone.instances) if (instance.status === "placed" && instance.xQ16 !== null && instance.yQ16 !== null && instance.widthQ16 !== null && instance.heightQ16 !== null) {
    const boxX = pxX(instance.xQ16); const boxY = pxY(instance.yQ16 + instance.heightQ16); const boxWidth = instance.widthQ16 / S5_Q16_DENOMINATOR * width; const boxHeight = instance.heightQ16 / S5_Q16_DENOMINATOR * height; const color = colors[zone.category] ?? colors.other_confirmed;
    cursor.page.drawRectangle({ x: boxX, y: boxY, width: boxWidth, height: boxHeight, borderColor: color, borderWidth: 1.5, color, opacity: 0.15 }); ensureGlyphs(font, instance.label); cursor.page.drawText(instance.label, { x: boxX + 4, y: boxY + boxHeight - 13, size: 7, font, color: rgb(0.09, 0.12, 0.16) });
  }
  return line(document, { page: cursor.page, y: 180 }, font, `${plan.zones.length} conceptual zone(s); ${plan.circulation.length} symbolic open-side route(s).`, { size: 9, color: rgb(0.40, 0.45, 0.49) });
}

export async function renderConceptPresentationPdf(input: S5PdfInput): Promise<Buffer> {
  verifyPlanHash(input.plan); if (!input.plan.projectId || !input.plan.approvalEventId) throw pdfError("S5_RENDER_FAILURE", "plan");
  const fontBytes = input.fontBytes ?? await loadApprovedNotoSansFont(); if (sha256(fontBytes) !== S5_NOTO_SANS_SHA256) throw pdfError("S5_FONT_UNAVAILABLE", "font");
  const document = await PDFDocument.create({ updateMetadata: false }); document.registerFontkit(fontkit);
  let font: PDFFont; try { font = await document.embedFont(fontBytes, { subset: false }); } catch { throw pdfError("S5_FONT_UNAVAILABLE", "font"); }
  document.setTitle("Swooshz Concept Presentation"); document.setAuthor("Swooshz Design"); document.setSubject("Concept Layout Plan"); document.setCreator("Swooshz Design S5"); document.setProducer("pdf-lib 1.17.1"); document.setKeywords(["S5", "Concept Layout Plan"]);

  let cursor = section(document, font, "1. Cover / hero"); cursor = paragraph(document, cursor, font, input.projectName, { size: 18, gap: 24 }); cursor = paragraph(document, cursor, font, "Swooshz Concept Presentation", { size: 12, color: rgb(0.04, 0.46, 0.43), gap: 20 });
  try { const image = await document.embedPng(input.heroBytes); const availableWidth = S5_PDF_WIDTH - 2 * S5_PDF_MARGIN; const availableHeight = 430; const scale = Math.min(availableWidth / image.width, availableHeight / image.height); const width = image.width * scale; const height = image.height * scale; cursor.page.drawImage(image, { x: S5_PDF_MARGIN, y: cursor.y - height, width, height }); cursor = { page: cursor.page, y: cursor.y - height - 26 }; } catch { throw pdfError("S5_APPROVED_ASSET_CORRUPT", "hero"); }
  cursor = paragraph(document, cursor, font, "Exact approved hero visual. Quality: " + input.quality + ".", { color: rgb(0.40, 0.45, 0.49) });

  cursor = section(document, font, "2. Project and booth"); cursor = paragraph(document, cursor, font, `Project: ${input.projectName}`); for (const [label, value] of Object.entries({ Client: input.projectFacts.clientName, Event: input.projectFacts.eventName, Venue: input.projectFacts.venueName, Location: input.projectFacts.eventLocation, "Start date": input.projectFacts.eventStartDate, "End date": input.projectFacts.eventEndDate })) cursor = paragraph(document, cursor, font, `${label}: ${value ?? "Not specified"}`); cursor = paragraph(document, cursor, font, `Confirmed booth: ${input.geometry.widthMm} mm W x ${input.geometry.depthMm} mm D.`); cursor = paragraph(document, cursor, font, `Open sides: ${input.geometry.openSides.join(", ")}.`); cursor = paragraph(document, cursor, font, `Maximum height: ${input.geometry.maxHeightMm === null ? "not specified" : `${input.geometry.maxHeightMm} mm`}.`); cursor = paragraph(document, cursor, font, "North is the diagram top; this is not surveyed bearing. Final engineering, access, safety, and venue verification remain required.", { color: rgb(0.40, 0.45, 0.49) });

  cursor = section(document, font, "3. Confirmed requirements"); if (!input.requirements.length) cursor = paragraph(document, cursor, font, "No functional requirements were confirmed; the zero-zone plan is valid."); for (const requirement of input.requirements) cursor = paragraph(document, cursor, font, `${requirement.mandatory ? "Mandatory" : "Optional"}: ${requirement.name}; count ${requirement.countIsExact ? String(requirement.count) : "not exact"}${requirement.details ? `; ${requirement.details}` : ""}`); cursor = paragraph(document, cursor, font, "Mandatory flags and exact-count metadata are copied from the hash-verified confirmed brief; they are not inferred from criticality.", { gap: 20, color: rgb(0.40, 0.45, 0.49) });

  cursor = section(document, font, "4. Concept Layout Plan"); cursor = paragraph(document, cursor, font, `Coordinate convention: origin north-west; X east; Y south; units mm; display boxes use conceptual Q16 space.`); cursor = paragraph(document, cursor, font, "Furniture and equipment are symbolic markers only. No exact doors, aisle widths, furniture dimensions, or construction geometry are asserted.", { gap: 20 }); cursor = displayPlan(document, cursor, font, input.plan);

  cursor = section(document, font, "5. Concept-stage verification notes"); cursor = paragraph(document, cursor, font, `Active revision: ${input.activeRevisionKind}; visual quality: ${input.quality}.`); cursor = paragraph(document, cursor, font, "Main circulation is a symbolic indication from each confirmed open-side midpoint to the diagram centre; width is not specified as a measured aisle."); cursor = paragraph(document, cursor, font, `Coverage records: ${input.plan.coverage.length}; symbolic zones: ${input.plan.zones.length}; unknown or unplaced items: ${input.unknowns.length}.`); for (const rule of input.designRules.filter((item) => item.applicability === "applicable")) cursor = paragraph(document, cursor, font, `Design rule: ${rule.materiality}; ${rule.repairable ? "repairable" : "not repairable"}.`); for (const item of input.unknowns) cursor = paragraph(document, cursor, font, `${item.mandatory ? "Mandatory" : "Optional"} unknown/unplaced: ${item.label}; reason ${item.reason}.`); for (const disclaimer of input.plan.disclaimers) cursor = paragraph(document, cursor, font, disclaimer, { gap: 17 });

  if (document.getPageCount() < S5_PDF_MIN_PAGES) throw pdfError("S5_RENDER_FAILURE", "pageCount");
  let bytes: Uint8Array; try { bytes = await document.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false }); } catch { throw pdfError("S5_RENDER_FAILURE"); }
  if (bytes.byteLength > S5_PDF_MAX_BYTES) throw pdfError("S5_PDF_SIZE_EXCEEDED"); const output = Buffer.from(bytes); if (/\/(?:CreationDate|ModDate)\s*\(/u.test(output.toString("latin1"))) throw pdfError("S5_RENDER_FAILURE", "metadata"); return output;
}

export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  try {
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    return document.getPageCount();
  } catch {
    throw pdfError("S5_RENDER_FAILURE", "pageCount");
  }
}
