import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import { retrySqlPositions } from "./retry-sql-scan.mjs";

const scriptExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);
const extensions = new Set([".sql", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".sh", ".bash"]);

const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(directory, entry.name);
  if (entry.isDirectory()) return walk(file);
  return entry.isFile() && extensions.has(path.extname(entry.name)) ? [file] : [];
});

const sourceOffsets = (raw, start, text, preserveRaw = false) => {
  const positions = [];
  let i = 0;
  while (i < raw.length) {
    const origin = start + i;
    if (preserveRaw || raw[i] !== "\\") {
      positions.push(origin);
      if (!preserveRaw && raw[i] === "\r" && raw[i + 1] === "\n") i++;
      i++;
      continue;
    }
    const next = raw[i + 1];
    if (next === "\n" || next === "\r") { i += next === "\r" && raw[i + 2] === "\n" ? 3 : 2; continue; }
    if (next === "u" && raw[i + 2] === "{") {
      const end = raw.indexOf("}", i + 3);
      const count = Number.parseInt(raw.slice(i + 3, end), 16) > 0xffff ? 2 : 1;
      for (let j = 0; j < count; j++) positions.push(origin);
      i = end + 1;
    } else {
      positions.push(origin);
      i += next === "u" ? 6 : next === "x" ? 4 : 2;
    }
  }
  return text.length === positions.length ? positions : Array.from({ length: text.length }, (_, index) => start + Math.min(index, raw.length));
};

const scriptSegments = (source) => {
  const ast = parse(source, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript", "decorators-legacy"],
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
  });
  const segments = [];
  const visit = (node, parent) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "StringLiteral") {
      const start = node.start + 1;
      segments.push({ text: node.value, positions: sourceOffsets(source.slice(start, node.end - 1), start, node.value) });
    }
    if (node.type === "TemplateLiteral") {
      const raw = parent?.type === "TaggedTemplateExpression" && parent.tag?.object?.name === "String" && parent.tag?.property?.name === "raw";
      const parts = node.quasis.map((quasi) => {
        const text = raw ? quasi.value.raw : quasi.value.cooked ?? quasi.value.raw;
        return { text, positions: sourceOffsets(source.slice(quasi.start, quasi.end), quasi.start, text, raw) };
      });
      const positions = [];
      let text = "";
      for (const [index, part] of parts.entries()) {
        if (index) {
          text += "interpolated_value";
          positions.push(...Array("interpolated_value".length).fill(node.expressions[index - 1].start));
        }
        text += part.text;
        for (const position of part.positions) positions.push(position);
      }
      segments.push({ text, positions });
    }
    for (const [key, child] of Object.entries(node)) {
      if (["loc", "start", "end", "extra", "comments", "tokens", "errors"].includes(key)) continue;
      if (Array.isArray(child)) child.forEach((item) => visit(item, node));
      else if (child && typeof child === "object") visit(child, node);
    }
  };
  visit(ast, null);
  return segments;
};

export const retrySqlFailures = (migrationsDirectory, migrationFiles) => {
  const files = [
    ...migrationFiles.filter((name) => name > "20261115000000_return_deliberate_conflicts_at_once.sql").map((name) => path.join(migrationsDirectory, name)),
    ...walk("scripts"),
    ...walk("tests"),
    ...walk("supabase/follow-up-migrations"),
    ...walk("supabase/release"),
    ...walk("supabase/tests"),
    ...walk("supabase/rollbacks").filter((file) => file !== "supabase/rollbacks/20261115000000_return_deliberate_conflicts_at_once.sql"),
  ];
  return files.flatMap((file) => {
    const source = fs.readFileSync(file, "utf8");
    const segments = scriptExtensions.has(path.extname(file)) ? scriptSegments(source) : [{ text: source, start: 0 }];
    return segments.flatMap((segment) => retrySqlPositions(segment.text).map((index) => {
      const position = segment.positions?.[index] ?? index;
      const line = source.slice(0, position).split("\n").length;
      return `${file}:${line}: retry SQLSTATE in raised error`;
    }));
  });
};
