"use client";

import { useContext, useEffect, useState } from "react";
import { EditorContext } from "./FieldInput";
import styles from "./ContentAdmin.module.css";

export default function ReferenceInput({ field, value, onChange, readOnly, inputId, ariaLabel }) {
  const { loadReferenceOptions } = useContext(EditorContext);
  const targets = Array.isArray(field.to) ? field.to : [];
  const [options, setOptions] = useState(null);
  const [error, setError] = useState("");
  const currentRef = value?._ref || "";

  useEffect(() => {
    let active = true;
    setError("");
    loadReferenceOptions(targets)
      .then((loaded) => {
        if (active) setOptions(loaded);
      })
      .catch((loadError) => {
        if (active) setError(loadError.message || "Could not load choices.");
      });
    return () => {
      active = false;
    };
  }, [targets.join("|")]);

  const known = (options || []).some((option) => option._id === currentRef);

  return (
    <div className={styles.referenceField}>
      <select
        id={inputId}
        aria-label={ariaLabel}
        className={styles.input}
        value={currentRef}
        disabled={readOnly || options === null}
        onChange={(event) => {
          const nextRef = event.target.value;
          if (!nextRef) return onChange(undefined);
          return onChange({ ...(value || {}), _type: "reference", _ref: nextRef });
        }}
      >
        <option value="">{options === null && !error ? "Loading…" : "Choose…"}</option>
        {(options || []).map((option) => (
          <option key={option._id} value={option._id}>
            {option.title}
            {targets.length > 1 ? ` (${option._type})` : ""}
          </option>
        ))}
        {currentRef && options !== null && !known ? (
          <option value={currentRef}>Missing document ({currentRef})</option>
        ) : null}
      </select>
      {error ? <p className={styles.fieldHelpError}>{error}</p> : null}
      {currentRef && options !== null && !known ? (
        <p className={styles.fieldHelpError}>This reference points to a document that is not live. Choose another before publishing.</p>
      ) : null}
    </div>
  );
}
