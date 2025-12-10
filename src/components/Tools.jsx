import React, { useEffect, useState } from "react";
import { client } from "../sanityClient";

// Category label is now just the text from Sanity, or "Tool" if empty
const categoryLabel = (cat) => cat || "Tool";

export default function Tools() {
  const [tools, setTools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [pendingDownload, setPendingDownload] = useState(null);
  const [downloadFadeOut, setDownloadFadeOut] = useState(false);
  const [downloadFadeIn, setDownloadFadeIn] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function fetchTools() {
      try {
        const data = await client.fetch(
          `*[_type == "tool"] | order(sortOrder asc, title asc) {
            _id,
            title,
            category,
            shortDescription,
            downloadMode,
            downloadUrl,
            officialSite,
            downloadNote,
            "iconUrl": icon.asset->url,
            "fileUrl": downloadFile.asset->url
          }`
        );
        if (!cancelled) {
          setTools(data || []);
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

  const openDownloadModal = (toolMeta) => {
    if (!toolMeta?.href) return;
    setDownloadFadeOut(false);
    setDownloadFadeIn(false);
    setPendingDownload(toolMeta);
    setShowDownloadModal(true);
    setTimeout(() => setDownloadFadeIn(true), 20);
  };

  const closeDownloadModal = () => {
    setDownloadFadeOut(true);
    setDownloadFadeIn(false);
    setTimeout(() => {
      setShowDownloadModal(false);
      setPendingDownload(null);
      setDownloadFadeOut(false);
    }, 200);
  };

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

  return (
    <section className="relative z-10 pt-28 pb-24 px-6 max-w-6xl mx-auto text-white">
      {/* Heading */}
      <header className="text-center mb-10">
        <p className="text-xs tracking-[0.3em] uppercase text-sky-400/80 mb-2">
          Tools I Use
        </p>
        <h1 className="text-4xl sm:text-5xl font-extrabold text-sky-100 drop-shadow-[0_0_30px_rgba(56,189,248,0.45)]">
          All Tools & Utilities
        </h1>
        <p className="mt-3 text-sm sm:text-base text-slate-300/80 max-w-2xl mx-auto">
          Quick access to the exact software I use during optimization, stress
          testing, overclocking and troubleshooting. Downloads are either direct
          from the official developer or securely hosted by Roo Industries.
        </p>
      </header>

      {loading ? (
        <div className="mt-16 text-center text-sky-300">Loading tools…</div>
      ) : tools.length === 0 ? (
        <div className="mt-16 text-center text-slate-300">
          No tools configured yet. Add some in Sanity Studio.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
          {tools.map((tool) => {
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
                className="group relative rounded-2xl border border-sky-800/50 bg-[#020617]/95 shadow-[0_0_25px_rgba(15,23,42,0.9)] hover:shadow-[0_0_35px_rgba(56,189,248,0.35)] overflow-hidden transition-all duration-300"
              >
                {/* subtle gradient glow background */}
                <div className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.18),transparent_55%),radial-gradient(circle_at_bottom,_rgba(8,47,73,0.7),transparent_55%)]" />

                <div className="relative p-5 sm:p-6 flex flex-col h-full">
                  {/* top row: icon + tag */}
                  <div className="flex items-start justify-between gap-3 mb-5">
                    <div className="w-9 h-9 rounded-xl bg-slate-900/80 border border-sky-700/50 flex items-center justify-center overflow-hidden shrink-0">
                      {iconUrl ? (
                        <img
                          src={iconUrl}
                          alt={title}
                          className="w-7 h-7 object-contain"
                        />
                      ) : (
                        <span className="text-sky-400 text-lg">⚙️</span>
                      )}
                    </div>

                    {category && (
                      <span className="px-3 py-1 rounded-full text-[10px] tracking-[0.18em] uppercase border border-sky-600/60 bg-sky-500/10 text-sky-200">
                        {categoryLabel(category)}
                      </span>
                    )}
                  </div>

                  {/* title + desc */}
                  <div className="flex-1">
                    <h2 className="text-lg sm:text-xl font-semibold text-sky-100">
                      {title}
                    </h2>
                    {shortDescription && (
                      <p className="mt-1.5 text-xs sm:text-sm text-slate-300/85 leading-snug">
                        {shortDescription}
                      </p>
                    )}

                    {/* editable note about where it downloads from */}
                    <p className="mt-2 text-[10px] text-slate-400/80">
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
                        className="flex-1 inline-flex items-center justify-center px-4 py-2.5 rounded-xl text-sm font-semibold border border-sky-700/60 text-sky-200 hover:border-sky-400 hover:bg-sky-500/10 transition-colors"
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
            className="relative w-full max-w-md bg-gradient-to-b from-slate-900 via-slate-950 to-slate-900 border border-sky-500/60 rounded-2xl shadow-[0_0_40px_rgba(56,189,248,0.45)] p-6 text-center transition-all duration-300 hover:shadow-[0_0_52px_rgba(56,189,248,0.6)]"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              aria-label="Close"
              className="absolute right-3 top-3 text-sky-200 hover:text-white transition text-2xl"
              onClick={closeDownloadModal}
            >
              ×
            </button>

            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-slate-900/80 border border-sky-700/60 flex items-center justify-center shadow-[0_0_25px_rgba(56,189,248,0.35)]">
              {pendingDownload.iconUrl ? (
                <img
                  src={pendingDownload.iconUrl}
                  alt={pendingDownload.title || "Tool icon"}
                  className="w-12 h-12 object-contain"
                />
              ) : (
                <span className="text-sky-300 font-semibold text-lg">Tool</span>
              )}
            </div>

            <h3 className="text-2xl font-bold text-white">
              {pendingDownload.title || "Download"}
            </h3>
            <p className="mt-2 text-sm text-slate-300/90">
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
