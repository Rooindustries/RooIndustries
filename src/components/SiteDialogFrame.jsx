"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isTopDialog, useDialogFocus } from "../lib/useDialogFocus";

export default function SiteDialogFrame({
  ariaDescribedBy,
  ariaLabelledBy,
  children,
  className = "",
  closeLabel = "Close",
  dismissible = true,
  onClose,
  open,
  overlay: Overlay = "div",
  overlayProps = {},
  panel: Panel = "div",
  panelProps = {},
  presence,
  returnFocusRef,
}) {
  const closeButtonRef = useRef(null);
  const dialogRef = useRef(null);
  const overlayRef = useRef(null);
  const scrollLockRef = useRef(null);
  const openRef = useRef(open);
  openRef.current = open;
  const [rendered, setRendered] = useState(open);
  if (open && !rendered) setRendered(true);
  const closing = !presence && rendered && !open;

  useEffect(() => {
    if (!closing) return undefined;
    let cancelled = false;
    const exits = [overlayRef.current, dialogRef.current]
      .flatMap((element) => (typeof element?.getAnimations === "function" ? element.getAnimations() : []))
      .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime));
    Promise.allSettled(exits.map((animation) => animation.finished)).then(() => {
      if (!cancelled) setRendered(false);
    });
    return () => {
      cancelled = true;
    };
  }, [closing]);

  useDialogFocus({ open, dialogRef, initialFocusRef: closeButtonRef, returnFocusRef, onClose, dismissible });

  useEffect(() => {
    if (!open) return undefined;
    const body = document.body;
    const html = document.documentElement;
    const original = {
      htmlOverflow: html.style.overflow,
      overflow: body.style.overflow,
      scrollY: window.scrollY,
    };
    scrollLockRef.current = original;
    body.classList.add("is-modal-open", "is-modal-blur");
    body.style.overflow = "hidden";
    html.style.overflow = "hidden";
    return () => {
      const stored = scrollLockRef.current || original;
      body.classList.remove("is-modal-open", "is-modal-blur");
      body.style.overflow = stored.overflow || "";
      html.style.overflow = stored.htmlOverflow || "";
      window.scrollTo(0, stored.scrollY || 0);
    };
  }, [open]);

  if (typeof document === "undefined") return null;

  const visible = presence ? open : rendered;
  const overlayClassName = [
    "glass-overlay low-perf-overlay fixed inset-0 z-[100] flex items-center justify-center px-4",
    presence ? "" : "site-dialog-overlay",
    overlayProps.className || "",
  ].join(" ");
  const panelClassName = [
    "low-perf-surface glass-premium glass-card-surface relative w-full max-w-md rounded-2xl border border-info-border",
    "p-6 text-center transition-all duration-500 ease-in-out hover:shadow-glow-strong",
    presence ? "" : "site-dialog-panel",
    panelProps.className || "",
    className,
  ].join(" ");
  const content = visible ? (
    <Overlay
      {...overlayProps}
      className={overlayClassName}
      data-closing={closing || undefined}
      ref={overlayRef}
      onClick={(event) => {
        event.stopPropagation();
        if (dismissible && isTopDialog(dialogRef)) onClose?.();
      }}
      onMouseDown={(event) => {
        if (!openRef.current) event.preventDefault();
      }}
    >
      <Panel
        {...panelProps}
        aria-describedby={ariaDescribedBy}
        aria-labelledby={ariaLabelledBy}
        aria-modal="true"
        className={panelClassName}
        inert={closing || undefined}
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        {dismissible ? (
          <button
            aria-label={closeLabel}
            className="absolute right-3 top-3 z-10 text-2xl text-info-text transition hover:text-white"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            <span aria-hidden="true">&times;</span>
          </button>
        ) : null}
        {children}
      </Panel>
    </Overlay>
  ) : null;

  return createPortal(presence ? presence(content) : content, document.body);
}
