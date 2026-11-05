import React from "react";
import { FaArrowLeft } from "react-icons/fa";

const BACK_BUTTON_CLASS = [
  "flex scale-90 items-center justify-center rounded-full border border-line-soft bg-surface-solid p-2 text-ink",
  "transition duration-200 hover:border-line-accent hover:text-[color:var(--color-link-hover)] active:scale-95 sm:p-3",
].join(" ");

export default function BackButton() {
  return (
    <button onClick={() => window.history.back()} aria-label="Go Back" className={BACK_BUTTON_CLASS}>
      <FaArrowLeft className="text-base sm:text-lg" />
    </button>
  );
}
