"use client";

import { useEffect, useState } from "react";

export default function OverlayCopyUrl({ path }) {
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
    <div className="ov-docs-url">
      <code>{url}</code>
      <button type="button" onClick={copy}>
        {copied ? "Copied" : "Copy URL"}
      </button>
    </div>
  );
}
