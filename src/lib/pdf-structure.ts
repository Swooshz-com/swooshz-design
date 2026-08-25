/**
 * Keep only PDF dictionary/object structure for the small page-tree check.
 * Brief text, comments, literal strings, hex strings, and stream payloads must
 * not be mistaken for `/Type /Page` or `/Count` entries.
 */
export function structuralPdfText(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "%") {
      const end = text.indexOf("\n", index + 1);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (char === "(") {
      let depth = 1;
      index += 1;
      while (index < text.length && depth > 0) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === "(") depth += 1;
        if (text[index] === ")") depth -= 1;
        index += 1;
      }
      continue;
    }
    if (char === "<" && text[index + 1] === "<") {
      output += "<<";
      index += 2;
      continue;
    }
    if (char === "<") {
      const end = text.indexOf(">", index + 1);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (
      text.startsWith("stream", index) &&
      (index === 0 || /\s/.test(text[index - 1])) &&
      /\s/.test(text[index + 6] ?? "")
    ) {
      const end = text.indexOf("endstream", index + 6);
      index = end === -1 ? text.length : end + "endstream".length;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}
