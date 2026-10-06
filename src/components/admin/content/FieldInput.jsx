"use client";

import { createContext, useContext, useId, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Trash2, Wand2 } from "lucide-react";
import styles from "./ContentAdmin.module.css";
import AssetInput from "./AssetInput";
import PortableTextInput from "./PortableTextInput";
import ReferenceInput from "./ReferenceInput";
import { newKey, pathLabel } from "./documentPaths";
import {
  defaultsFor,
  fromLocalDateTimeInput,
  isFieldHidden,
  isPortableTextField,
  optionTitle,
  optionValue,
  slugify,
  toLocalDateTimeInput,
} from "./fieldRules";

export const EditorContext = createContext(null);

const useEditor = () => useContext(EditorContext);

function FieldErrors({ path }) {
  const { errorsByPath } = useEditor();
  const messages = errorsByPath.get(pathLabel(path)) || [];
  if (messages.length === 0) return null;
  return (
    <ul className={styles.fieldErrors} role="alert">
      {messages.map((message, index) => (
        <li key={index}>{message}</li>
      ))}
    </ul>
  );
}

function FieldShell({ field, path, htmlFor, children, inline = false }) {
  const { errorsByPath } = useEditor();
  const invalid = (errorsByPath.get(pathLabel(path)) || []).length > 0;
  return (
    <div className={`${styles.field} ${invalid ? styles.fieldInvalid : ""} ${inline ? styles.fieldInline : ""}`}>
      <label className={styles.fieldLabel} htmlFor={htmlFor}>
        {field.title || field.name}
        {field.required ? <span className={styles.required} aria-label="required">*</span> : null}
        {field.readOnly ? <span className={styles.readOnlyTag}>Read only</span> : null}
      </label>
      {field.description ? <p className={styles.fieldHelp}>{field.description}</p> : null}
      {children}
      <FieldErrors path={path} />
    </div>
  );
}

const itemSummary = (item, itemType) => {
  if (item == null) return "Empty item";
  if (typeof item !== "object") return String(item);
  for (const field of itemType?.fields || []) {
    const value = item[field.name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const value of Object.values(item)) {
    if (typeof value === "string" && value.trim() && !String(value).startsWith("image-")) return value.trim();
  }
  return itemType?.title || "Item";
};

const itemTypeFor = (field, item) =>
  (field.of || []).find((candidate) => candidate.name && candidate.name === item?._type) ||
  (field.of || []).find((candidate) => candidate.type === item?._type) ||
  field.of?.[0];

function ArrayInput({ field, path, value, onChange, readOnly }) {
  const items = Array.isArray(value) ? value : [];
  const [openKeys, setOpenKeys] = useState(() => new Set());
  const ofTypes = field.of || [];
  const primitive = ofTypes.every((item) => ["string", "number", "text", "url", "date"].includes(item.type));
  const listOptions = field.options?.list;

  const replace = (next) => onChange(next.length ? next : []);
  const move = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const copy = items.slice();
    const [entry] = copy.splice(index, 1);
    copy.splice(target, 0, entry);
    replace(copy);
  };
  const remove = (index) => {
    const copy = items.slice();
    copy.splice(index, 1);
    replace(copy);
  };
  const add = (itemType) => {
    let item;
    if (itemType.type === "object") {
      item = { _key: newKey(), _type: itemType.name || "object", ...defaultsFor(itemType.fields) };
    } else if (itemType.type === "reference") {
      item = { _key: newKey(), _type: "reference", _ref: "" };
    } else if (itemType.type === "image" || itemType.type === "file") {
      item = { _key: newKey(), _type: itemType.type };
    } else if (itemType.type === "number") {
      item = 0;
    } else {
      item = "";
    }
    const next = [...items, item];
    if (item && typeof item === "object") {
      setOpenKeys((keys) => new Set([...keys, item._key]));
    }
    replace(next);
  };

  if (listOptions && primitive) {
    return (
      <div className={styles.checkGroup}>
        {listOptions.map((option) => {
          const optionVal = optionValue(option);
          const checked = items.includes(optionVal);
          return (
            <label key={String(optionVal)} className={styles.checkOption}>
              <input
                type="checkbox"
                checked={checked}
                disabled={readOnly}
                onChange={(event) =>
                  replace(
                    event.target.checked
                      ? [...items, optionVal]
                      : items.filter((entry) => entry !== optionVal)
                  )
                }
              />
              {optionTitle(option)}
            </label>
          );
        })}
      </div>
    );
  }

  return (
    <div className={styles.arrayField}>
      {items.length === 0 ? <p className={styles.muted}>No items yet.</p> : null}
      {items.map((item, index) => {
        const itemType = itemTypeFor(field, item);
        const itemPath = [...path, index];
        const key = item && typeof item === "object" ? item._key || `index-${index}` : `index-${index}`;
        const isObject = itemType?.type === "object";
        const open = !isObject || openKeys.has(key);
        return (
          <div key={key} className={styles.arrayItem}>
            <div className={styles.arrayItemHeader}>
              {isObject ? (
                <button
                  type="button"
                  className={styles.disclosure}
                  aria-expanded={open}
                  onClick={() =>
                    setOpenKeys((keys) => {
                      const next = new Set(keys);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                >
                  {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
                  <span>{itemSummary(item, itemType)}</span>
                </button>
              ) : (
                <span className={styles.arrayIndex}>{index + 1}</span>
              )}
              {!isObject ? (
                <div className={styles.arrayInline}>
                  <ValueInput
                    field={{ ...itemType, title: `${field.title || field.name} ${index + 1}` }}
                    path={itemPath}
                    value={item}
                    parent={items}
                    onChange={(next) => {
                      const copy = items.slice();
                      copy[index] = next;
                      replace(copy);
                    }}
                    readOnly={readOnly}
                    bare
                  />
                </div>
              ) : null}
              {!readOnly ? (
                <span className={styles.arrayActions}>
                  <button type="button" className={styles.iconButton} aria-label="Move up" title="Move up" onClick={() => move(index, -1)} disabled={index === 0}>
                    <ArrowUp size={16} aria-hidden="true" />
                  </button>
                  <button type="button" className={styles.iconButton} aria-label="Move down" title="Move down" onClick={() => move(index, 1)} disabled={index === items.length - 1}>
                    <ArrowDown size={16} aria-hidden="true" />
                  </button>
                  <button type="button" className={styles.iconButtonDanger} aria-label="Remove item" title="Remove item" onClick={() => remove(index)}>
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </span>
              ) : null}
            </div>
            {isObject && open ? (
              <div className={styles.arrayItemBody}>
                <ObjectFields
                  fields={itemType.fields || []}
                  path={itemPath}
                  value={item}
                  readOnly={readOnly}
                  onChange={(next) => {
                    const copy = items.slice();
                    copy[index] = next;
                    replace(copy);
                  }}
                />
              </div>
            ) : null}
            <FieldErrors path={itemPath} />
          </div>
        );
      })}
      {!readOnly ? (
        <div className={styles.addRow}>
          {ofTypes.map((itemType, index) => (
            <button key={`${itemType.name || itemType.type}-${index}`} type="button" className={styles.addButton} onClick={() => add(itemType)}>
              <Plus size={16} aria-hidden="true" />
              Add {ofTypes.length > 1 ? itemType.title || itemType.name || itemType.type : "item"}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ObjectFields({ fields, path, value, onChange, readOnly }) {
  const current = value && typeof value === "object" ? value : {};
  return (
    <div className={styles.objectFields}>
      {fields.map((field) => {
        if (isFieldHidden(field, current)) return null;
        return (
          <ValueInput
            key={field.name}
            field={field}
            path={[...path, field.name]}
            value={current[field.name]}
            parent={current}
            readOnly={readOnly || field.readOnly === true}
            onChange={(next) => {
              const copy = { ...current };
              if (next === undefined) delete copy[field.name];
              else copy[field.name] = next;
              onChange(copy);
            }}
          />
        );
      })}
    </div>
  );
}

export function ValueInput({ field, path, value, parent, onChange, readOnly = false, bare = false }) {
  const id = useId();
  const type = field.type;
  const ariaLabel = bare ? field.title || field.name : undefined;
  const wrap = (control, inline = false) =>
    bare ? control : (
      <FieldShell field={field} path={path} htmlFor={id} inline={inline}>
        {control}
      </FieldShell>
    );

  if (isPortableTextField(field)) {
    return wrap(
      <PortableTextInput
        value={value}
        label={field.title || field.name}
        readOnly={readOnly}
        onChange={onChange}
      />
    );
  }

  if (type === "array") {
    return wrap(<ArrayInput field={field} path={path} value={value} onChange={onChange} readOnly={readOnly} />);
  }

  if (type === "object") {
    return wrap(
      <div className={styles.nestedObject}>
        <ObjectFields fields={field.fields || []} path={path} value={value} onChange={onChange} readOnly={readOnly} />
      </div>
    );
  }

  if (type === "image" || type === "file") {
    return wrap(
      <AssetInput kind={type} field={field} value={value} onChange={onChange} readOnly={readOnly} inputId={id} ariaLabel={ariaLabel || field.title || field.name} path={path} />
    );
  }

  if (type === "reference") {
    return wrap(<ReferenceInput field={field} value={value} onChange={onChange} readOnly={readOnly} inputId={id} ariaLabel={ariaLabel} />);
  }

  if (type === "boolean") {
    return wrap(
      <label className={styles.toggle}>
        <input
          id={id}
          aria-label={ariaLabel}
          type="checkbox"
          checked={value === true}
          disabled={readOnly}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{value === true ? "On" : "Off"}</span>
      </label>,
      true
    );
  }

  const list = field.options?.list;
  if (list && (type === "string" || type === "number")) {
    if (field.options?.layout === "radio") {
      return wrap(
        <div className={styles.radioGroup} role="radiogroup" aria-label={field.title || field.name}>
          {list.map((option) => {
            const optionVal = optionValue(option);
            return (
              <label key={String(optionVal)} className={styles.radioOption}>
                <input
                  type="radio"
                  name={id}
                  checked={value === optionVal}
                  disabled={readOnly}
                  onChange={() => onChange(optionVal)}
                />
                {optionTitle(option)}
              </label>
            );
          })}
        </div>
      );
    }
    return wrap(
      <select
        id={id}
        aria-label={ariaLabel}
        className={styles.input}
        value={value ?? ""}
        disabled={readOnly}
        onChange={(event) => {
          const raw = event.target.value;
          if (raw === "") return onChange(undefined);
          const match = list.find((option) => String(optionValue(option)) === raw);
          return onChange(match === undefined ? raw : optionValue(match));
        }}
      >
        <option value="">Choose…</option>
        {list.map((option) => (
          <option key={String(optionValue(option))} value={String(optionValue(option))}>
            {optionTitle(option)}
          </option>
        ))}
        {value !== undefined && value !== "" && !list.some((option) => optionValue(option) === value) ? (
          <option value={String(value)}>{String(value)} (current)</option>
        ) : null}
      </select>
    );
  }

  if (type === "text") {
    return wrap(
      <textarea
        id={id}
        aria-label={ariaLabel}
        className={styles.input}
        rows={field.rows || 4}
        value={typeof value === "string" ? value : ""}
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
      />
    );
  }

  if (type === "number") {
    return wrap(
      <input
        id={id}
        aria-label={ariaLabel}
        className={styles.input}
        type="number"
        inputMode="decimal"
        step={field.integer ? 1 : "any"}
        min={field.min}
        max={field.max}
        value={typeof value === "number" && Number.isFinite(value) ? value : ""}
        readOnly={readOnly}
        onChange={(event) => {
          const raw = event.target.value;
          if (raw === "") return onChange(undefined);
          const number = Number(raw);
          return onChange(Number.isFinite(number) ? number : undefined);
        }}
      />
    );
  }

  if (type === "date") {
    return wrap(
      <input
        id={id}
        aria-label={ariaLabel}
        className={styles.input}
        type="date"
        value={typeof value === "string" ? value.slice(0, 10) : ""}
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value || undefined)}
      />
    );
  }

  if (type === "datetime") {
    return wrap(
      <input
        id={id}
        aria-label={ariaLabel}
        className={styles.input}
        type="datetime-local"
        value={toLocalDateTimeInput(value)}
        readOnly={readOnly}
        onChange={(event) => onChange(fromLocalDateTimeInput(event.target.value))}
      />
    );
  }

  if (type === "slug") {
    const current = value && typeof value === "object" ? value.current || "" : "";
    const source = field.options?.source;
    return wrap(
      <div className={styles.inlineGroup}>
        <input
          id={id}
          aria-label={ariaLabel}
          className={styles.input}
          value={current}
          readOnly={readOnly}
          onChange={(event) =>
            onChange(event.target.value ? { ...(value || {}), _type: "slug", current: event.target.value } : undefined)
          }
        />
        {source && !readOnly ? (
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => {
              const generated = slugify(parent?.[source]);
              if (generated) onChange({ ...(value || {}), _type: "slug", current: generated });
            }}
          >
            <Wand2 size={16} aria-hidden="true" /> Generate
          </button>
        ) : null}
      </div>
    );
  }

  return wrap(
    <input
      id={id}
      aria-label={ariaLabel}
      className={styles.input}
      type={type === "url" && !field.allowRelative ? "url" : type === "email" ? "email" : "text"}
      value={typeof value === "string" ? value : value == null ? "" : String(value)}
      readOnly={readOnly}
      maxLength={typeof field.max === "number" && type !== "number" ? field.max : undefined}
      onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
      onBlur={(event) => {
        if (readOnly || (type !== "url" && type !== "email")) return;
        const trimmed = event.target.value.trim();
        if (trimmed !== event.target.value) onChange(trimmed === "" ? undefined : trimmed);
      }}
    />
  );
}
