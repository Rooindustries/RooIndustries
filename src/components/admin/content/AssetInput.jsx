"use client";

import { useContext, useEffect, useRef, useState } from "react";
import { FileArchive, ImageUp, RefreshCw, Trash2, Upload } from "lucide-react";
import { EditorContext } from "./FieldInput";
import styles from "./ContentAdmin.module.css";
import { acceptFor, describeFile, hashFile, imageDimensions, putToSignedUrl } from "./assetUpload";

const formatBytes = (bytes) => {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
};

export default function AssetInput({ kind, field, value, onChange, readOnly, inputId, ariaLabel, path }) {
  const { api, assets, registerAsset, captureEditTarget, applyAtTarget, beginUpload, endUpload } = useContext(EditorContext);
  const fileInput = useRef(null);
  const abortRef = useRef(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const assetRef = value?.asset?._ref || "";
  const meta = assetRef ? assets[assetRef] : null;

  useEffect(() => () => abortRef.current?.abort(), []);

  const upload = async (file) => {
    setError("");
    const described = describeFile(kind, file);
    if (described.error) {
      setError(described.error);
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    const stopIfCancelled = () => {
      if (signal.aborted) throw Object.assign(new Error("Upload cancelled."), { name: "AbortError" });
    };
    abortRef.current = controller;
    const target = captureEditTarget(path);
    beginUpload();
    try {
      setStatus({ label: "Checking file…", progress: 0 });
      const [{ sha1, sha256 }, dimensions] = await Promise.all([
        hashFile(file),
        kind === "image" && described.mimeType !== "image/svg+xml" ? imageDimensions(file) : Promise.resolve({}),
      ]);
      stopIfCancelled();
      setStatus({ label: "Preparing upload…", progress: 0 });
      const issued = await api.startUpload(
        {
          kind,
          fileName: file.name,
          mimeType: described.mimeType,
          byteSize: file.size,
          sha1,
          sha256,
          ...(dimensions.width && dimensions.height ? dimensions : {}),
        },
        { signal }
      );
      stopIfCancelled();
      let finalized = issued;
      if (!issued?.alreadyExists) {
        await putToSignedUrl({
          signedUrl: issued.signedUrl,
          file,
          mimeType: described.mimeType,
          signal,
          onProgress: (progress) => setStatus({ label: "Uploading…", progress }),
        });
        stopIfCancelled();
        setStatus({ label: "Verifying on the server…", progress: 1 });
        finalized = await api.finalizeUpload(issued.uploadId, { signal });
        stopIfCancelled();
      }
      const ref = finalized?.asset?._ref || finalized?.assetId;
      if (!ref) throw new Error("The server did not return an asset reference.");
      registerAsset(ref, {
        url: finalized.url || null,
        width: finalized.width,
        height: finalized.height,
        mimeType: finalized.mimeType,
        byteSize: finalized.byteSize,
        fileName: file.name,
      });
      const attached = applyAtTarget(target, (current) => {
        const { crop: _crop, hotspot: _hotspot, ...rest } =
          current && typeof current === "object" ? current : {};
        return { ...rest, _type: kind, asset: { _type: "reference", _ref: ref } };
      });
      if (!attached && !signal.aborted) {
        setError("The document changed while this file uploaded. Select the file again to attach it.");
      }
      setStatus(null);
    } catch (uploadError) {
      setStatus(null);
      if (uploadError?.name !== "AbortError") setError(uploadError.message || "Upload failed.");
    } finally {
      endUpload();
      if (abortRef.current === controller) abortRef.current = null;
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const Icon = kind === "image" ? ImageUp : FileArchive;

  return (
    <div className={styles.assetField}>
      {assetRef ? (
        <div className={styles.assetPreview}>
          {kind === "image" && meta?.url ? (
            <img src={meta.url} alt="" loading="lazy" />
          ) : (
            <span className={styles.assetIcon}><Icon size={22} aria-hidden="true" /></span>
          )}
          <span className={styles.assetMeta}>
            <strong>{meta?.fileName || (kind === "image" ? "Image" : "File")}</strong>
            <small>
              {[
                meta?.width && meta?.height ? `${meta.width}×${meta.height}` : null,
                meta?.byteSize ? formatBytes(meta.byteSize) : null,
                meta ? null : "Preview unavailable",
              ]
                .filter(Boolean)
                .join(" · ")}
            </small>
          </span>
        </div>
      ) : (
        <p className={styles.muted}>No {kind === "image" ? "image" : "file"} selected.</p>
      )}
      {status ? (
        <div className={styles.uploadStatus} role="status">
          <span>{status.label}</span>
          <progress max="1" value={status.progress || 0} />
          <button type="button" className={styles.linkButton} onClick={() => abortRef.current?.abort()}>
            Cancel
          </button>
        </div>
      ) : null}
      {error ? <p className={styles.fieldHelpError} role="alert">{error}</p> : null}
      {!readOnly ? (
        <div className={styles.inlineGroup}>
          <input
            ref={fileInput}
            id={inputId}
            aria-label={ariaLabel}
            type="file"
            tabIndex={-1}
            className={styles.visuallyHidden}
            accept={acceptFor(kind)}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) upload(file);
            }}
          />
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={Boolean(status)}
            onClick={() => fileInput.current?.click()}
          >
            {assetRef ? <RefreshCw size={16} aria-hidden="true" /> : <Upload size={16} aria-hidden="true" />}
            {assetRef ? "Replace" : "Upload"}
          </button>
          {assetRef ? (
            <button
              type="button"
              className={styles.secondaryButtonDanger}
              disabled={Boolean(status)}
              onClick={() => onChange(undefined)}
            >
              <Trash2 size={16} aria-hidden="true" /> Remove
            </button>
          ) : null}
          <small className={styles.muted}>
            {kind === "image" ? "Up to 20 MB" : "Up to 64 MB, .zip or .exe"}
          </small>
        </div>
      ) : null}
    </div>
  );
}
