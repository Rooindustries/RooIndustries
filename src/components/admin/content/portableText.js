import { isValidPublishLink } from "../../../lib/cms/contentSchema";
import { newKey, stableJson } from "./documentPaths";

export const BLOCK_STYLES = [
  { value: "normal", title: "Paragraph" },
  { value: "h1", title: "Heading 1" },
  { value: "h2", title: "Heading 2" },
  { value: "h3", title: "Heading 3" },
  { value: "h4", title: "Heading 4" },
  { value: "h5", title: "Heading 5" },
  { value: "h6", title: "Heading 6" },
  { value: "blockquote", title: "Quote" },
];

export const LIST_TYPES = [
  { value: "", title: "No list" },
  { value: "bullet", title: "Bulleted" },
  { value: "number", title: "Numbered" },
];

const DECORATOR_TAGS = {
  strong: "strong",
  em: "em",
  code: "code",
  underline: "u",
  "strike-through": "s",
};

const TAG_DECORATORS = {
  STRONG: "strong",
  B: "strong",
  EM: "em",
  I: "em",
  CODE: "code",
  U: "underline",
  S: "strike-through",
  STRIKE: "strike-through",
  DEL: "strike-through",
};

const DECORATOR_ORDER = ["strong", "em", "underline", "strike-through", "code"];

export const SAFE_LINK = { test: isValidPublishLink };

export const emptyBlock = (template = {}) => ({
  _type: "block",
  _key: newKey(),
  style: template.style && !/^h[1-6]$/.test(template.style) ? template.style : "normal",
  ...(template.listItem ? { listItem: template.listItem, level: template.level || 1 } : {}),
  markDefs: [],
  children: [{ _type: "span", _key: newKey(), text: "", marks: [] }],
});

const markDefMap = (block) =>
  new Map((Array.isArray(block?.markDefs) ? block.markDefs : []).map((def) => [def?._key, def]));

const appendText = (parent, text) => {
  const parts = String(text ?? "").split("\n");
  parts.forEach((part, index) => {
    if (index > 0) parent.appendChild(parent.ownerDocument.createElement("br"));
    if (part) parent.appendChild(parent.ownerDocument.createTextNode(part));
  });
};

export const renderBlockInto = (element, block) => {
  const doc = element.ownerDocument;
  element.replaceChildren();
  const defs = markDefMap(block);
  for (const child of Array.isArray(block?.children) ? block.children : []) {
    if (child?._type !== "span") {
      const marker = doc.createElement("span");
      marker.setAttribute("data-inline-object", child?._key || "");
      marker.setAttribute("contenteditable", "false");
      marker.textContent = `[${child?._type || "object"}]`;
      element.appendChild(marker);
      continue;
    }
    const marks = Array.isArray(child.marks) ? child.marks : [];
    let container = element;
    const annotations = marks.filter((mark) => defs.has(mark));
    const decorators = marks
      .filter((mark) => !defs.has(mark))
      .sort((left, right) => {
        const leftIndex = DECORATOR_ORDER.indexOf(left);
        const rightIndex = DECORATOR_ORDER.indexOf(right);
        return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex);
      });
    for (const markKey of annotations) {
      const def = defs.get(markKey);
      const node = doc.createElement(def?._type === "link" ? "a" : "span");
      node.setAttribute("data-mark-key", markKey);
      if (def?._type === "link" && typeof def.href === "string") node.setAttribute("href", def.href);
      container.appendChild(node);
      container = node;
    }
    for (const mark of decorators) {
      const tag = DECORATOR_TAGS[mark];
      const node = doc.createElement(tag || "span");
      if (!tag) node.setAttribute("data-mark", mark);
      container.appendChild(node);
      container = node;
    }
    appendText(container, child.text);
  }
  const spans = (Array.isArray(block?.children) ? block.children : []).filter((child) => child?._type === "span");
  if (String(spans[spans.length - 1]?.text ?? "").endsWith("\n")) {
    element.appendChild(doc.createElement("br"));
  }
};

export const endsWithLineBreakNode = (root) => {
  let node = root.lastChild;
  while (node && node.nodeType === 1 && node.tagName !== "BR" && node.lastChild) node = node.lastChild;
  while (node && node.nodeType === 3 && node.nodeValue === "" && node.previousSibling) node = node.previousSibling;
  return Boolean(node && node.nodeType === 1 && node.tagName === "BR");
};

const collectRuns = (root, original) => {
  const defs = markDefMap(original);
  const runs = [];
  const usedDefs = new Map();
  const inlineObjects = new Map(
    (Array.isArray(original?.children) ? original.children : [])
      .filter((child) => child?._type !== "span")
      .map((child) => [child?._key, child])
  );

  const marksFor = (node) => {
    const marks = [];
    for (let current = node.parentNode; current && current !== root; current = current.parentNode) {
      if (current.nodeType !== 1) continue;
      const decorator = current.getAttribute("data-mark") || TAG_DECORATORS[current.tagName];
      if (decorator && !marks.includes(decorator)) marks.push(decorator);
      if (current.tagName === "A" || current.hasAttribute("data-mark-key")) {
        let key = current.getAttribute("data-mark-key");
        const href = current.getAttribute("href") || "";
        if (current.tagName === "A" && !SAFE_LINK.test(href)) continue;
        if (!key || !defs.has(key)) {
          key = key || newKey();
          current.setAttribute("data-mark-key", key);
          if (!usedDefs.has(key)) usedDefs.set(key, { _key: key, _type: "link", href });
        } else if (!usedDefs.has(key)) {
          const existing = defs.get(key);
          usedDefs.set(
            key,
            existing?._type === "link" && current.tagName === "A" && existing.href !== href
              ? { ...existing, href }
              : existing
          );
        }
        if (!marks.includes(key)) marks.push(key);
      }
    }
    return marks;
  };

  const visit = (node) => {
    if (node.nodeType === 3) {
      if (node.nodeValue) runs.push({ text: node.nodeValue, marks: marksFor(node) });
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.hasAttribute("data-inline-object")) {
      const inline = inlineObjects.get(node.getAttribute("data-inline-object"));
      if (inline) runs.push({ inline });
      return;
    }
    if (node.tagName === "BR") {
      runs.push({ text: "\n", marks: marksFor(node) });
      return;
    }
    const isBlockElement = node !== root && /^(DIV|P)$/.test(node.tagName);
    if (isBlockElement && runs.length > 0) runs.push({ text: "\n", marks: [] });
    node.childNodes.forEach(visit);
  };

  root.childNodes.forEach(visit);
  return { runs, usedDefs };
};

const sameMarks = (left, right) =>
  left.length === right.length && [...left].sort().join("\u0000") === [...right].sort().join("\u0000");

export const readBlockFrom = (element, original) => {
  const { runs, usedDefs } = collectRuns(element, original);
  const merged = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (run.inline) {
      merged.push(run);
    } else if (last && !last.inline && sameMarks(last.marks, run.marks)) {
      last.text += run.text;
    } else {
      merged.push({ text: run.text, marks: run.marks });
    }
  }
  if (merged.length && !merged[merged.length - 1].inline && endsWithLineBreakNode(element)) {
    const last = merged[merged.length - 1];
    if (last.text.endsWith("\n")) last.text = last.text.slice(0, -1);
    if (last.text === "" && merged.length > 1) merged.pop();
  }
  const originalSpans = (Array.isArray(original?.children) ? original.children : []).filter(
    (child) => child?._type === "span"
  );
  let spanIndex = 0;
  const children = merged.map((run) => {
    if (run.inline) return run.inline;
    const reused = originalSpans[spanIndex];
    spanIndex += 1;
    const span = { ...(reused || {}), _type: "span", _key: reused?._key || newKey(), text: run.text, marks: run.marks };
    return span;
  });
  if (children.length === 0) {
    const reused = originalSpans[0];
    children.push({ ...(reused || {}), _type: "span", _key: reused?._key || newKey(), text: "", marks: [] });
  }
  const referencedBefore = new Set(originalSpans.flatMap((span) => span.marks || []));
  const danglingDefs = (Array.isArray(original?.markDefs) ? original.markDefs : []).filter(
    (def) => !referencedBefore.has(def?._key) && !usedDefs.has(def?._key)
  );
  const markDefs = [...usedDefs.values(), ...danglingDefs];
  const next = { ...original, children, markDefs };
  return equivalentBlocks(original, next) ? original : next;
};

const comparableBlock = (block) => ({
  ...block,
  markDefs: [...(block?.markDefs || [])].sort((left, right) =>
    String(left?._key).localeCompare(String(right?._key))
  ),
  children: (block?.children || []).map((child) =>
    child?._type === "span" ? { ...child, marks: [...(child.marks || [])].sort() } : child
  ),
});

export const equivalentBlocks = (left, right) =>
  stableJson(comparableBlock(left)) === stableJson(comparableBlock(right));

export const blockPlainText = (block) =>
  (Array.isArray(block?.children) ? block.children : [])
    .map((child) => (child?._type === "span" ? child.text || "" : ""))
    .join("");
