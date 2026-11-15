const levels = new Set(["exception", "warning", "notice", "info", "log", "debug"]);
const conditions = new Set(["serialization_failure", "deadlock_detected"]);
const retryCode = (value) => /^(?:40001|40p01|serialization_failure|deadlock_detected)$/i.test(value);

const escapeValue = (source, index) => {
  const tail = source.slice(index + 1);
  const hex = tail.match(/^x([0-9a-f]{1,2})/i);
  const unicode = tail.match(/^(?:u([0-9a-f]{4})|U([0-9a-f]{8}))/);
  const octal = tail.match(/^([0-7]{1,3})/);
  if (hex) return { value: String.fromCodePoint(Number.parseInt(hex[1], 16)), length: hex[0].length + 1 };
  if (unicode) return { value: String.fromCodePoint(Number.parseInt(unicode[1] || unicode[2], 16)), length: unicode[0].length + 1 };
  if (octal) return { value: String.fromCodePoint(Number.parseInt(octal[1], 8)), length: octal[0].length + 1 };
  const simple = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
  return { value: simple[tail[0]] ?? tail[0], length: 2 };
};

const tokens = (source, base = 0, offsets = null) => {
  const result = [];
  let i = 0;
  const position = (index) => offsets?.[index] ?? base + index;
  const add = (kind, value, start) => result.push({ kind, value, index: position(start) });
  const bodyExpected = () => {
    const previous = result.at(-1);
    if (previous?.kind === "word" && ["as", "do"].includes(previous.value)) return true;
    const tail = result.slice(result.findLastIndex((token) => token.kind === "symbol" && token.value === ";") + 1);
    return tail[0]?.value === "do" && tail[1]?.value === "language" && tail.length === 3;
  };
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source.startsWith("--", i)) { i = source.indexOf("\n", i); if (i < 0) break; continue; }
    if (source.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < source.length && depth) {
        if (source.startsWith("/*", i)) { depth++; i += 2; }
        else if (source.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    const start = i;
    const escaped = /[eE]/.test(source[i]) && source[i + 1] === "'" && !/[a-z0-9_$]/i.test(source[i - 1] || "");
    if (escaped) i++;
    if (source[i] === "'" || source[i] === '"') {
      const quote = source[i++];
      let value = "";
      const valueOffsets = [];
      while (i < source.length) {
        if (source[i] === quote && source[i + 1] === quote) { value += quote; valueOffsets.push(position(i)); i += 2; }
        else if (source[i] === quote) { i++; break; }
        else if (escaped && source[i] === "\\" && i + 1 < source.length) {
          const decoded = escapeValue(source, i);
          value += decoded.value;
          for (let j = 0; j < decoded.value.length; j++) valueOffsets.push(position(i));
          i += decoded.length;
        }
        else { value += source[i]; valueOffsets.push(position(i)); i++; }
      }
      if (quote === "'" && bodyExpected()) {
        add("symbol", ";", start);
        result.push(...tokens(value, 0, valueOffsets));
        add("symbol", ";", i);
      } else add(quote === "'" ? "literal" : "identifier", value, start);
      continue;
    }
    if (source[i] === "$") {
      const delimiter = source.slice(i).match(/^\$(?:[a-z_][a-z_0-9]*)?\$/i)?.[0];
      if (delimiter) {
        const end = source.indexOf(delimiter, i + delimiter.length);
        if (end < 0) { add("other", source.slice(i), i); break; }
        const bodyStart = i + delimiter.length;
        if (bodyExpected()) {
          add("symbol", ";", start);
          result.push(...tokens(source.slice(bodyStart, end), base + bodyStart, offsets?.slice(bodyStart, end)));
          add("symbol", ";", end);
        } else add("literal", source.slice(bodyStart, end), start);
        i = end + delimiter.length;
        continue;
      }
    }
    const word = source.slice(i).match(/^[a-z_][a-z_0-9$]*/i)?.[0];
    if (word) { add("word", word.toLowerCase(), i); i += word.length; continue; }
    const symbol = source.startsWith(":=", i) || source.startsWith("::", i) ? source.slice(i, i + 2) : source[i];
    add("symbol", symbol, i);
    i += symbol.length;
  }
  return result;
};

const unwrap = (expression) => {
  let start = 0, end = expression.length;
  while (expression[start]?.kind === "symbol" && expression[start].value === "(" && expression[end - 1]?.kind === "symbol" && expression[end - 1].value === ")") {
    let depth = 0, closesEarly = false;
    for (let i = start; i < end; i++) {
      if (expression[i].kind === "symbol" && expression[i].value === "(") depth++;
      if (expression[i].kind === "symbol" && expression[i].value === ")" && --depth === 0 && i < end - 1) { closesEarly = true; break; }
    }
    if (closesEarly || depth !== 0) break;
    start++;
    end--;
  }
  return expression.slice(start, end);
};

const unsafeExpression = (expression, sqlstate = false) => {
  const value = unwrap(expression);
  if (value.length !== 1 || value[0].kind !== "literal") return true;
  return retryCode(value[0].value) || (sqlstate && /^40[a-z0-9]{3}$/i.test(value[0].value));
};

export const retrySqlPositions = (source, { handlers = true } = {}) => {
  const list = tokens(source);
  const failures = [];
  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    if (token.kind !== "word") continue;
    if (handlers && token.value === "when" && list[i + 1]?.kind === "word" && conditions.has(list[i + 1].value)) failures.push(token.index);
    if (token.value !== "raise") continue;
    let end = i + 1;
    while (end < list.length && !(list[end].kind === "symbol" && list[end].value === ";")) end++;
    let cursor = i + 1;
    if (list[cursor]?.kind === "word" && levels.has(list[cursor].value)) cursor++;
    if (list[cursor]?.kind === "word" && conditions.has(list[cursor].value)) { failures.push(token.index); continue; }
    if (list[cursor]?.kind === "word" && list[cursor].value === "sqlstate") {
      cursor++;
      let valueEnd = cursor;
      while (valueEnd < end && !(list[valueEnd].kind === "word" && list[valueEnd].value === "using")) valueEnd++;
      if (unsafeExpression(list.slice(cursor, valueEnd), true)) failures.push(token.index);
      cursor = valueEnd;
    }
    while (cursor < end && !(list[cursor].kind === "word" && list[cursor].value === "using")) cursor++;
    let depth = 0;
    for (cursor++; cursor < end; cursor++) {
      const current = list[cursor];
      if (current.kind === "symbol" && ["(", "["].includes(current.value)) depth++;
      else if (current.kind === "symbol" && [")", "]"].includes(current.value)) depth--;
      else if (depth === 0 && current.kind === "word" && current.value === "errcode" && list[cursor + 1]?.kind === "symbol" && ["=", ":="].includes(list[cursor + 1].value)) {
        let valueEnd = cursor + 2, expressionDepth = 0;
        while (valueEnd < end) {
          const { kind, value } = list[valueEnd];
          if (kind === "symbol" && value === "," && expressionDepth === 0) break;
          if (kind === "symbol" && ["(", "["].includes(value)) expressionDepth++;
          else if (kind === "symbol" && [")", "]"].includes(value)) expressionDepth--;
          valueEnd++;
        }
        if (unsafeExpression(list.slice(cursor + 2, valueEnd))) failures.push(current.index);
        cursor = valueEnd;
      }
    }
  }
  return failures;
};
