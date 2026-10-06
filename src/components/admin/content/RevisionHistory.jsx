"use client";

import { useEffect, useState } from "react";
import { History, RotateCcw, X } from "lucide-react";
import styles from "./ContentAdmin.module.css";

const displayTime = (value) => {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
};


export default function RevisionHistory({ api, documentId, onRestore, onClose }) {
  const [revisions, setRevisions] = useState(null);
  const [error, setError] = useState("");
  const [loadingId, setLoadingId] = useState("");

  useEffect(() => {
    let active = true;
    api
      .listRevisions(documentId)
      .then((data) => {
        if (active) setRevisions(Array.isArray(data?.revisions) ? data.revisions : []);
      })
      .catch((loadError) => {
        if (active) setError(loadError.message);
      });
    return () => {
      active = false;
    };
  }, [api, documentId]);

  const restore = async (revision) => {
    setLoadingId(revision.revisionId);
    setError("");
    try {
      const data = await api.getRevision(documentId, revision.revisionId);
      onRestore({ document: data.document, assets: data.assets || {}, revision });
    } catch (restoreError) {
      setError(restoreError.message);
    } finally {
      setLoadingId("");
    }
  };

  return (
    <aside className={styles.historyPanel} aria-label="Version history">
      <div className={styles.historyHeader}>
        <h3><History size={18} aria-hidden="true" /> Version history</h3>
        <button type="button" className={styles.iconButton} aria-label="Close history" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <p className={styles.muted}>
        Earlier published versions are kept here. Loading one puts it in the editor; publish to make it live again.
      </p>
      {error ? <p className={styles.fieldHelpError} role="alert">{error}</p> : null}
      {revisions === null && !error ? <p className={styles.muted}>Loading…</p> : null}
      {revisions?.length === 0 ? (
        <p className={styles.muted}>No earlier versions yet. They are recorded from the first admin publish onward.</p>
      ) : null}
      <ol className={styles.historyList}>
        {(revisions || []).map((revision) => (
          <li key={revision.revisionId} className={styles.historyEntry}>
            <div>
              <strong>Before the edit at <time dateTime={revision.createdAt}>{displayTime(revision.createdAt)}</time></strong>
            </div>
            <span>{revision.actor?.startsWith("admin:") ? "Admin" : revision.actor?.startsWith("sanity:") ? "Studio editor" : revision.actor}</span>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => restore(revision)}
              disabled={Boolean(loadingId)}
            >
              <RotateCcw size={15} aria-hidden="true" />
              {loadingId === revision.revisionId ? "Loading…" : "Load this version"}
            </button>
          </li>
        ))}
      </ol>
    </aside>
  );
}
