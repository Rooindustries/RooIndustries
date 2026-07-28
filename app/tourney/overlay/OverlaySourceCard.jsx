"use client";

import { useEffect, useState } from "react";

export default function OverlaySourceCard({
  title,
  description,
  path,
  recommendedSize,
  params = [],
  notes = [],
  previewSrc,
  previewHeight = 120,
}) {
  const [url, setUrl] = useState(path);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setUrl(`${window.location.origin}${path}`);
  }, [path]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard blocked; the URL stays visible for manual copy.
    }
  };

  return (
    <article className="ov-docs-card">
      <h3>{title}</h3>
      <p>{description}</p>
      <div className="ov-docs-url">
        <code>{url}</code>
        <button type="button" onClick={copy}>
          {copied ? "Copied" : "Copy URL"}
        </button>
      </div>
      {params.length > 0 ? (
        <ul className="ov-docs-params">
          {params.map((param) => (
            <li key={param.name}>
              <code>{param.name}</code> — {param.text}
            </li>
          ))}
        </ul>
      ) : null}
      {notes.map((note) => (
        <p key={note}>{note}</p>
      ))}
      {recommendedSize ? <p>Recommended browser source size: {recommendedSize}.</p> : null}
      {previewSrc ? (
        <div className="ov-docs-preview">
          <iframe
            src={previewSrc}
            title={`${title} preview`}
            loading="lazy"
            style={{ height: previewHeight }}
          />
        </div>
      ) : null}
    </article>
  );
}
