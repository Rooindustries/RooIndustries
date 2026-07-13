export const splitPostgresStatements = (source = "") => {
  const statements = [];
  let buffer = "";
  let quote = "";
  let dollarTag = "";
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1] || "";
    if (lineComment) {
      buffer += char;
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      buffer += char;
      if (char === "*" && next === "/") {
        buffer += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (dollarTag) {
      if (source.startsWith(dollarTag, index)) {
        buffer += dollarTag;
        index += dollarTag.length - 1;
        dollarTag = "";
      } else buffer += char;
      continue;
    }
    if (quote) {
      buffer += char;
      if (char === quote && next === quote) {
        buffer += next;
        index += 1;
      } else if (char === quote) quote = "";
      continue;
    }
    if (char === "-" && next === "-") lineComment = true;
    else if (char === "/" && next === "*") blockComment = true;
    else if (char === "'" || char === '"') quote = char;
    else if (char === "$") {
      const match = source.slice(index).match(/^\$[A-Za-z0-9_]*\$/);
      if (match) dollarTag = match[0];
    }
    if (char === ";" && !quote && !dollarTag && !lineComment && !blockComment) {
      if (buffer.trim()) statements.push(buffer.trim());
      buffer = "";
    } else buffer += char;
  }
  if (buffer.trim()) statements.push(buffer.trim());
  return statements;
};
