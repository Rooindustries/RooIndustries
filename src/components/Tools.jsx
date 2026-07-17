import React, { useCallback, useEffect, useRef, useState } from "react";
import { getPublicContent } from "../lib/publicContentClient";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

// Category label is now just the text from Sanity, or "Tool" if empty
const categoryLabel = (cat) => cat || "Tool";

const optimizeIconUrl = (url) => {
  if (!url) return "";
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}auto=format&fit=max&w=64&h=64`;
};

export default function Tools() {
  const [tools, setTools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [pendingDownload, setPendingDownload] = useState(null);
  const [downloadFadeOut, setDownloadFadeOut] = useState(false);
  const [downloadFadeIn, setDownloadFadeIn] = useState(false);
  const dialogRef = useRef(null);
  const closeButtonRef = useRef(null);
  const previousFocusRef = useRef(null);
  const openTimerRef = useRef(null);
  const closeTimerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchTools() {
      try {
        const data = await getPublicContent("tools");
        if (!cancelled) {
          const normalizedTools = (data || []).map((tool) => ({
            ...tool,
            iconUrl: optimizeIconUrl(tool?.iconUrl),
          }));
          setTools(normalizedTools);
          setLoading(false);
        }
      } catch (err) {
        console.error("Error fetching tools:", err);
        if (!cancelled) setLoading(false);
      }
    }

    fetchTools();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const body = document.body;
    if (showDownloadModal) {
      body.classList.add("is-modal-open");
      body.classList.add("is-modal-blur");
    } else {
      body.classList.remove("is-modal-open");
      body.classList.remove("is-modal-blur");
    }

    return () => {
      body.classList.remove("is-modal-open");
      body.classList.remove("is-modal-blur");
    };
  }, [showDownloadModal]);

  useEffect(
    () => () => {
      window.clearTimeout(openTimerRef.current);
      window.clearTimeout(closeTimerRef.current);
    },
    []
  );

  const openDownloadModal = (toolMeta) => {
    if (!toolMeta?.href) return;
    window.clearTimeout(openTimerRef.current);
    window.clearTimeout(closeTimerRef.current);
    setDownloadFadeOut(false);
    setDownloadFadeIn(false);
    setPendingDownload(toolMeta);
    setShowDownloadModal(true);
    openTimerRef.current = window.setTimeout(() => {
      setDownloadFadeIn(true);
      openTimerRef.current = null;
    }, 20);
  };

  const closeDownloadModal = useCallback(() => {
    window.clearTimeout(openTimerRef.current);
    window.clearTimeout(closeTimerRef.current);
    setDownloadFadeOut(true);
    setDownloadFadeIn(false);
    closeTimerRef.current = window.setTimeout(() => {
      setShowDownloadModal(false);
      setPendingDownload(null);
      setDownloadFadeOut(false);
      closeTimerRef.current = null;
    }, 200);
  }, []);

  useEffect(() => {
    if (!showDownloadModal) return undefined;
    previousFocusRef.current = document.activeElement;
    closeButtonRef.current?.focus();

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDownloadModal();
        return;
      }

      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll(FOCUSABLE_SELECTOR) || []
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;
      const focusIsInside = dialogRef.current?.contains(activeElement);

      if (event.shiftKey && (activeElement === first || !focusIsInside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeElement === last || !focusIsInside)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus?.();
    };
  }, [closeDownloadModal, showDownloadModal]);

  const handleConfirmDownload = () => {
    if (!pendingDownload?.href) return;

    const link = document.createElement("a");
    link.href = pendingDownload.href;
    link.rel = "noopener noreferrer";

    if (pendingDownload.isHosted) {
      link.setAttribute("download", pendingDownload.downloadName || "");
    } else {
      link.target = "_blank";
    }

    document.body.appendChild(link);
    link.click();
    link.remove();

    closeDownloadModal();
  };

  const placeholderCards = 9;
  const toolItems = loading
    ? Array.from({ length: placeholderCards }, (_, index) => ({
        _id: `placeholder-${index}`,
        __placeholder: true,
      }))
    : tools;

  return (
    <section
      className="relative z-10 pt-28 pb-24 px-6 max-w-6xl mx-auto text-ink"
      style={{
        width: "100%",
        maxWidth: "1152px",
        ...(loading ? { minHeight: "1840px" } : {}),
      }}
    >
      {/* Heading */}
      <header className="text-center mb-10">
        <p className="text-xs tracking-[0.3em] uppercase text-accent mb-2">
          Tools I Use
        </p>
        <h1 className="text-4xl sm:text-5xl font-extrabold text-info-text drop-shadow-[0_0_30px_rgba(56,189,248,0.45)]">
          All Tools & Utilities
        </h1>
        <p className="mt-3 text-sm sm:text-base text-ink-secondary max-w-2xl mx-auto">
          Quick access to the exact software I use during optimization, stress
          testing, overclocking and troubleshooting. Downloads are either direct
          from the official developer or securely hosted by Roo Industries.
        </p>
      </header>

      {!loading && tools.length === 0 ? (
        <div className="mt-16 text-center text-ink-secondary">
          No tools configured yet. Add some in Sanity Studio.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
          {toolItems.map((tool) => {
            if (tool.__placeholder) {
              return (
                <article
                  key={tool._id}
                  className="group relative rounded-2xl border border-line-input bg-[color:var(--color-surface-solid)] overflow-hidden p-6"
                  aria-hidden="true"
                >
                  <div className="h-5 w-24 rounded bg-surface-hover-accent animate-pulse" />
                  <div className="mt-4 h-6 w-3/4 rounded bg-surface-hover-accent animate-pulse" />
                  <div className="mt-3 h-4 w-full rounded bg-surface-hover animate-pulse" />
                  <div className="mt-2 h-4 w-5/6 rounded bg-surface-hover animate-pulse" />
                  <div className="mt-8 h-10 w-full rounded-xl bg-surface-hover-accent animate-pulse" />
                </article>
              );
            }

            const {
              _id,
              title,
              category,
              shortDescription,
              downloadMode,
              downloadUrl,
              officialSite,
              downloadNote,
              iconUrl,
              fileUrl,
            } = tool;

            // Decide final download href
            const href =
              downloadMode === "hosted" && fileUrl ? fileUrl : downloadUrl;

            const disabled = !href;
            const isHostedFile = downloadMode === "hosted" && Boolean(fileUrl);
            const downloadMeta = {
              title,
              href,
              iconUrl,
              isHosted: isHostedFile,
              downloadName: title ? `${title.replace(/\s+/g, "_")}` : "",
            };

            return (
              <article
                key={_id}
                className="group relative rounded-2xl border border-line-input bg-[color:var(--color-surface-solid)] shadow-[0_0_25px_rgba(15,23,42,0.9)] hover:shadow-[var(--shadow-card-glow)] overflow-hidden transition-all duration-300"
              >
                {/* subtle gradient glow background */}
                <div className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.18),transparent_55%),radial-gradient(circle_at_bottom,_rgba(8,47,73,0.7),transparent_55%)]" />

                <div className="relative p-5 sm:p-6 flex flex-col h-full">
                  {/* top row: icon + tag */}
                  <div className="flex items-start justify-between gap-3 mb-5">
                    <div className="w-9 h-9 rounded-xl bg-surface-input border border-line-input flex items-center justify-center overflow-hidden shrink-0">
                      {/* SEO: ensure tool icons are crawlable with descriptive alt text. */}
                      {iconUrl ? (
                        <img
                          src={iconUrl}
                          alt={title ? `${title} tool icon` : "Tool icon"}
                          width={28}
                          height={28}
                          loading="lazy"
                          decoding="async"
                          className="w-7 h-7 object-contain"
                        />
                      ) : (
                        <span className="text-accent text-lg">⚙️</span>
                      )}
                    </div>

                    {category && (
                      <span className="px-3 py-1 rounded-full text-[10px] tracking-[0.18em] uppercase border border-info-border bg-info-soft text-info-text">
                        {categoryLabel(category)}
                      </span>
                    )}
                  </div>

                  {/* title + desc */}
                  <div className="flex-1">
                    <h2 className="text-lg sm:text-xl font-semibold text-info-text">
                      {title}
                    </h2>
                    {shortDescription && (
                      <p className="mt-1.5 text-xs sm:text-sm text-ink-secondary leading-snug">
                        {shortDescription}
                      </p>
                    )}

                    {/* editable note about where it downloads from */}
                    <p className="mt-2 text-[10px] text-ink-muted">
                      {downloadNote
                        ? downloadNote
                        : downloadMode === "hosted"
                        ? "Installer delivered directly via Roo Industries."
                        : "Download served from the official developer’s website."}
                    </p>
                  </div>

                  {/* buttons */}
                  <div className="mt-5 flex flex-col sm:flex-row gap-3">
                    {officialSite && (
                      <a
                        href={officialSite}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 inline-flex items-center justify-center px-4 py-2.5 rounded-xl text-sm font-semibold border border-line-input text-info-text hover:border-line-accent hover:bg-info-soft transition-colors"
                      >
                        Official Site
                      </a>
                    )}

                    <button
                      type="button"
                      onClick={() => openDownloadModal(downloadMeta)}
                      className={`glow-button flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold ${
                        disabled
                          ? "opacity-40 cursor-not-allowed pointer-events-none"
                          : ""
                      }`}
                      disabled={disabled}
                    >
                      {disabled ? "No Download Configured" : "Download"}
                      <span className="glow-line glow-line-top" />
                      <span className="glow-line glow-line-right" />
                      <span className="glow-line glow-line-bottom" />
                      <span className="glow-line glow-line-left" />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {showDownloadModal && pendingDownload && (
        <div
          className={`fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-center justify-center px-4 transition-opacity duration-200 ${
            downloadFadeOut
              ? "opacity-0 pointer-events-none"
              : downloadFadeIn
              ? "opacity-100"
              : "opacity-0"
          }`}
          onClick={closeDownloadModal}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="download-dialog-title"
            aria-describedby="download-dialog-description"
            tabIndex={-1}
            className="relative w-full max-w-md bg-panel border border-info-border rounded-2xl shadow-glow-strong p-6 text-center transition-all duration-300 hover:shadow-glow-strong"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              ref={closeButtonRef}
              type="button"
              aria-label="Close"
              className="absolute right-3 top-3 text-info-text hover:text-white transition text-2xl"
              onClick={closeDownloadModal}
            >
              ×
            </button>

            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-surface-input border border-line-input flex items-center justify-center shadow-info-soft">
              {/* SEO: keep the modal icon descriptive for screen readers. */}
              {pendingDownload.iconUrl ? (
                <img
                  src={pendingDownload.iconUrl}
                  alt={
                    pendingDownload.title
                      ? `${pendingDownload.title} tool icon`
                      : "Tool icon"
                  }
                  width={48}
                  height={48}
                  decoding="async"
                  className="w-12 h-12 object-contain"
                />
              ) : (
                <span className="text-accent font-semibold text-lg">Tool</span>
              )}
            </div>

            <h3 id="download-dialog-title" className="text-2xl font-bold text-ink">
              {pendingDownload.title || "Download"}
            </h3>
            <p
              id="download-dialog-description"
              className="mt-2 text-sm text-ink-secondary"
            >
              You&apos;re about to download this tool. Continue?
            </p>

            <div className="mt-6">
              <button
                type="button"
                onClick={handleConfirmDownload}
                className="glow-button w-full inline-flex items-center justify-center px-4 py-3 rounded-lg font-semibold text-white gap-2"
              >
                Download
                <span className="glow-line glow-line-top" />
                <span className="glow-line glow-line-right" />
                <span className="glow-line glow-line-bottom" />
                <span className="glow-line glow-line-left" />
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
