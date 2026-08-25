import { getDocument, PasswordException } from "pdfjs-dist/legacy/build/pdf.mjs";

export const MAX_PDF_PAGES = 20;

export class PdfPageLimitError extends Error {
  constructor() {
    super("PDF page limit exceeded");
    this.name = "PdfPageLimitError";
  }
}

type PdfDocumentTask = ReturnType<typeof getDocument>;
type PdfDocumentOpener = (options: Parameters<typeof getDocument>[0]) => PdfDocumentTask;

export type ParsedPdf = {
  pageCount: number;
};

export async function parsePdf(
  bytes: Uint8Array,
  options: { openDocument?: PdfDocumentOpener } = {},
): Promise<ParsedPdf> {
  const source = new Uint8Array(bytes);
  const task = (options.openDocument ?? getDocument)({
    data: source,
    disableAutoFetch: true,
    disableStream: true,
    stopAtErrors: true,
    useWasm: false,
    useWorkerFetch: false,
    verbosity: 0,
  });
  task.onPassword = (updatePassword: (password: Error) => void) => {
    updatePassword(new Error("PDF password required"));
  };

  let document: Awaited<typeof task.promise> | null = null;
  try {
    document = await task.promise;
    const pageCount = document.numPages;
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      throw new Error("PDF page count unavailable");
    }
    if (pageCount > MAX_PDF_PAGES) {
      throw new PdfPageLimitError();
    }
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      await document.getPage(pageNumber);
    }
    return { pageCount };
  } catch (error) {
    if (error instanceof PdfPageLimitError) throw error;
    if (error instanceof PasswordException || (error as { name?: unknown })?.name === "PasswordException") {
      throw new Error("PDF password required");
    }
    throw new Error("PDF parse failed");
  } finally {
    await task.destroy().catch(() => undefined);
  }
}
