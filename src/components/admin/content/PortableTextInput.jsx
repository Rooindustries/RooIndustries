"use client";

import { useEffect, useRef } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bold,
  Code,
  Italic,
  Link2,
  Link2Off,
  Plus,
  Strikethrough,
  Trash2,
  Underline,
} from "lucide-react";
import styles from "./ContentAdmin.module.css";
import {
  BLOCK_STYLES,
  LIST_TYPES,
  SAFE_LINK,
  emptyBlock,
  endsWithLineBreakNode,
  readBlockFrom,
  renderBlockInto,
} from "./portableText";

const runCommand = (command, value) => {
  try {
    document.execCommand("styleWithCSS", false, false);
  } catch {
    return false;
  }
  return document.execCommand(command, false, value);
};

const insertNewlineAtCaret = (editor) => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return false;
  range.deleteContents();
  const node = document.createTextNode("\n");
  range.insertNode(node);
  const caret = document.createRange();
  caret.setStartAfter(node);
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);
  const rest = document.createRange();
  rest.setStartAfter(node);
  rest.setEnd(editor, editor.childNodes.length);
  if (!rest.toString() && !endsWithLineBreakNode(editor)) editor.appendChild(document.createElement("br"));
  return true;
};

const closestInEditor = (node, editor, tagName) => {
  for (let current = node; current && current !== editor; current = current.parentNode) {
    if (current.nodeType === 1 && current.tagName === tagName) return current;
  }
  return null;
};

const toggleCode = (editor) => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return;
  const existing = closestInEditor(range.commonAncestorContainer, editor, "CODE");
  if (existing) {
    existing.replaceWith(...existing.childNodes);
    return;
  }
  if (range.collapsed) return;
  const code = document.createElement("code");
  code.appendChild(range.extractContents());
  range.insertNode(code);
  selection.removeAllRanges();
  const after = document.createRange();
  after.selectNodeContents(code);
  selection.addRange(after);
};

function BlockEditor({ block, label, onChange, onSplit, onRemoveEmpty, registerEditor }) {
  const editorRef = useRef(null);
  const blockRef = useRef(block);
  const editedRef = useRef(false);
  blockRef.current = block;

  useEffect(() => {
    if (editorRef.current) renderBlockInto(editorRef.current, blockRef.current);
    registerEditor(block._key, editorRef.current);
    return () => registerEditor(block._key, null);
  }, []);

  const commit = () => {
    if (!editorRef.current || !editedRef.current) return;
    const next = readBlockFrom(editorRef.current, blockRef.current);
    if (next !== blockRef.current) onChange(next);
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const editor = editorRef.current;
      const selection = window.getSelection();
      if (!editor || !selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const tail = document.createRange();
      tail.setStart(range.startContainer, range.startOffset);
      tail.setEnd(editor, editor.childNodes.length);
      const fragment = tail.extractContents();
      const holder = document.createElement("div");
      holder.appendChild(fragment);
      const current = readBlockFrom(editor, blockRef.current);
      const template = emptyBlock(current);
      const rest = readBlockFrom(holder, { ...template, markDefs: current.markDefs, children: [] });
      onSplit(current, { ...template, children: rest.children, markDefs: rest.markDefs });
      return;
    }
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      if (editorRef.current && insertNewlineAtCaret(editorRef.current)) {
        editedRef.current = true;
        commit();
      }
      return;
    }
    if (event.key === "Backspace") {
      const editor = editorRef.current;
      if (editor && editor.textContent === "" && !editor.querySelector("[data-inline-object]")) {
        event.preventDefault();
        onRemoveEmpty();
      }
    }
  };

  const handlePaste = (event) => {
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") || "";
    text.split(/\r?\n/).forEach((line, index) => {
      if (index > 0 && editorRef.current) insertNewlineAtCaret(editorRef.current);
      if (line) runCommand("insertText", line);
    });
    editedRef.current = true;
    commit();
  };

  return (
    <div
      ref={editorRef}
      className={`${styles.ptEditable} ${styles[`ptStyle_${block.style || "normal"}`] || ""}`}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={label}
      spellCheck
      onInput={() => {
        editedRef.current = true;
        commit();
      }}
      onBlur={commit}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
    />
  );
}

export default function PortableTextInput({ value, onChange, label, readOnly = false }) {
  const blocks = Array.isArray(value) ? value : [];
  const editors = useRef(new Map());
  const focusRequest = useRef(null);
  const activeKey = useRef(null);

  const registerEditor = (key, element) => {
    if (element) editors.current.set(key, element);
    else editors.current.delete(key);
  };

  useEffect(() => {
    const request = focusRequest.current;
    if (!request) return;
    const element = editors.current.get(request.key);
    if (!element) return;
    focusRequest.current = null;
    element.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(request.atEnd !== true);
    if (request.atEnd) range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });

  const replaceAt = (index, next) => {
    const copy = blocks.slice();
    copy[index] = next;
    onChange(copy);
  };

  const updateBlock = (index, patch) => {
    const block = blocks[index];
    const next = { ...block, ...patch };
    if (!next.listItem) {
      delete next.listItem;
      delete next.level;
    } else if (!next.level) {
      next.level = 1;
    }
    replaceAt(index, next);
  };

  const insertAfter = (index, block) => {
    const copy = blocks.slice();
    copy.splice(index + 1, 0, block);
    focusRequest.current = { key: block._key, atEnd: false };
    onChange(copy);
  };

  const removeAt = (index) => {
    const copy = blocks.slice();
    copy.splice(index, 1);
    const previous = copy[Math.max(0, index - 1)];
    if (previous) focusRequest.current = { key: previous._key, atEnd: true };
    onChange(copy);
  };

  const move = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= blocks.length) return;
    const copy = blocks.slice();
    const [item] = copy.splice(index, 1);
    copy.splice(target, 0, item);
    onChange(copy);
  };

  const applyToActive = (action) => {
    const editor = editors.current.get(activeKey.current);
    if (!editor) return;
    editor.focus();
    action(editor);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const addLink = () => {
    const href = window.prompt("Link address (https://, mailto:, tel: or a site path)");
    if (href == null) return;
    const trimmed = href.trim();
    if (!SAFE_LINK.test(trimmed)) {
      window.alert("Use a link that starts with https://, http://, mailto:, tel:, / or #.");
      return;
    }
    applyToActive(() => runCommand("createLink", trimmed));
  };

  if (readOnly) {
    return (
      <div className={styles.ptReadOnly}>
        {blocks.map((block) => (
          <p key={block._key}>{(block.children || []).map((child) => child.text || "").join("")}</p>
        ))}
      </div>
    );
  }

  const toolbarButton = (title, Icon, action) => (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={styles.iconButton}
      onMouseDown={(event) => event.preventDefault()}
      onClick={action}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );

  return (
    <div className={styles.ptField}>
      <div className={styles.ptToolbar} role="toolbar" aria-label={`${label} formatting`}>
        {toolbarButton("Bold", Bold, () => applyToActive(() => runCommand("bold")))}
        {toolbarButton("Italic", Italic, () => applyToActive(() => runCommand("italic")))}
        {toolbarButton("Underline", Underline, () => applyToActive(() => runCommand("underline")))}
        {toolbarButton("Strikethrough", Strikethrough, () =>
          applyToActive(() => runCommand("strikeThrough"))
        )}
        {toolbarButton("Inline code", Code, () => applyToActive(toggleCode))}
        {toolbarButton("Add link", Link2, addLink)}
        {toolbarButton("Remove link", Link2Off, () => applyToActive(() => runCommand("unlink")))}
      </div>
      {blocks.length === 0 ? <p className={styles.muted}>No text yet.</p> : null}
      {blocks.map((block, index) =>
        block?._type === "block" ? (
          <div
            key={block._key}
            className={styles.ptBlock}
            onFocusCapture={() => {
              activeKey.current = block._key;
            }}
          >
            <div className={styles.ptBlockControls}>
              <select
                aria-label="Text style"
                value={block.style || "normal"}
                onChange={(event) => updateBlock(index, { style: event.target.value })}
              >
                {BLOCK_STYLES.map((style) => (
                  <option key={style.value} value={style.value}>{style.title}</option>
                ))}
                {!BLOCK_STYLES.some((style) => style.value === (block.style || "normal")) ? (
                  <option value={block.style}>{block.style}</option>
                ) : null}
              </select>
              <select
                aria-label="List type"
                value={block.listItem || ""}
                onChange={(event) => updateBlock(index, { listItem: event.target.value })}
              >
                {LIST_TYPES.map((list) => (
                  <option key={list.value} value={list.value}>{list.title}</option>
                ))}
                {block.listItem && !LIST_TYPES.some((list) => list.value === block.listItem) ? (
                  <option value={block.listItem}>{block.listItem}</option>
                ) : null}
              </select>
              {block.listItem ? (
                <select
                  aria-label="List level"
                  value={block.level || 1}
                  onChange={(event) => updateBlock(index, { level: Number(event.target.value) })}
                >
                  {[1, 2, 3, 4].map((level) => (
                    <option key={level} value={level}>Level {level}</option>
                  ))}
                </select>
              ) : null}
              <span className={styles.ptBlockActions}>
                {toolbarButton("Move paragraph up", ArrowUp, () => move(index, -1))}
                {toolbarButton("Move paragraph down", ArrowDown, () => move(index, 1))}
                {toolbarButton("Remove paragraph", Trash2, () => removeAt(index))}
              </span>
            </div>
            <BlockEditor
              block={block}
              label={`${label}, paragraph ${index + 1}`}
              registerEditor={registerEditor}
              onChange={(next) => replaceAt(index, next)}
              onSplit={(current, created) => {
                const copy = blocks.slice();
                copy[index] = current;
                copy.splice(index + 1, 0, created);
                focusRequest.current = { key: created._key, atEnd: false };
                onChange(copy);
              }}
              onRemoveEmpty={() => (blocks.length > 1 ? removeAt(index) : undefined)}
            />
          </div>
        ) : (
          <div key={block?._key || index} className={styles.ptObject}>
            <span>Embedded {block?._type || "object"} (kept as is)</span>
            {toolbarButton("Remove embedded item", Trash2, () => removeAt(index))}
          </div>
        )
      )}
      <button
        type="button"
        className={styles.addButton}
        onClick={() => insertAfter(blocks.length - 1, emptyBlock())}
      >
        <Plus size={16} aria-hidden="true" /> Add paragraph
      </button>
    </div>
  );
}
