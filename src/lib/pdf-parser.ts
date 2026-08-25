import { getDocument, PasswordException } from "pdfjs-dist/legacy/build/pdf.mjs";

export type ParsedPdf = {
  pageCount: number;
};

export async function parsePdf(bytes: Uint8Array): Promise<ParsedPdf> {
  const source = new Uint8Array(bytes);
  const task = getDocument({
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
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      await document.getPage(pageNumber);
    }
    return { pageCount };
  } catch (error) {
    if (error instanceof PasswordException || (error as { name?: unknown })?.name === "PasswordException") {
      throw new Error("PDF password required");
    }
    throw new Error("PDF parse failed");
  } finally {
    await task.destroy().catch(() => undefined);
  }
}
