import { useEffect, useRef } from "react";

const dialogs = [];
export const isTopDialog = (ref) => dialogs.at(-1) === ref;

export function useDialogFocus({ open, dialogRef, initialFocusRef, onClose, dismissible = true }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    const previousFocus = document.activeElement;
    dialogs.push(dialogRef);
    (initialFocusRef?.current || dialogRef.current?.querySelector("[data-autofocus], button, input") || dialogRef.current)?.focus();
    const handleKeyDown = (event) => {
      if (!isTopDialog(dialogRef)) return;
      const root = dialogRef.current;
      if (!root) return;
      if (event.key === "Escape" && dismissible) {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = Array.from(root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
        .filter(node => node.getClientRects().length && !node.closest('[inert], [aria-hidden="true"]'));
      if (!controls.length) {
        event.preventDefault();
        root.focus();
        return;
      }
      const outside = !root.contains(document.activeElement);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && (outside || document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (outside || document.activeElement === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      const wasTop = isTopDialog(dialogRef);
      const index = dialogs.lastIndexOf(dialogRef);
      if (index >= 0) dialogs.splice(index, 1);
      if (wasTop) {
        const parent = dialogs.at(-1)?.current;
        const opener = previousFocus?.isConnected && previousFocus !== document.body && previousFocus !== document.documentElement && previousFocus.id !== "main-content" ? previousFocus : null;
        const target = opener || parent?.querySelector("[data-autofocus], button, input") || parent ||
          document.querySelector("[data-reservation-continue]") || document.getElementById("main-content");
        target?.focus({ preventScroll: true });
        if (!opener && !parent && target?.id === "main-content") {
          window.requestAnimationFrame(() => {
            if (dialogs.length || (document.activeElement !== target && document.activeElement !== document.body)) return;
            document.querySelector("[data-reservation-continue]")?.focus({ preventScroll: true });
          });
        }
      }
    };
  }, [dialogRef, dismissible, initialFocusRef, open]);
}
