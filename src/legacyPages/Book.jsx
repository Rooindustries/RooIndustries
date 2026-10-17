import React, { lazy, Suspense, useEffect } from "react";
import BookingForm from "../components/BookingForm";
import { preloadConfirmationPages } from "../lib/confirmationPages";

const Footer = lazy(() => import("../components/Footer"));

export default function Book({ hideFooter = false, compact = false }) {
  useEffect(() => {
    preloadConfirmationPages().catch(() => {});
  }, []);
  const padY = compact ? "p-0" : "pt-32 pb-24";
  const titleMargin = compact ? "mb-4" : "mb-10";
  const titleSize = compact ? "text-3xl sm:text-4xl" : "text-4xl sm:text-5xl";

  return (
    <>
      <section
        className={`ri-booking relative z-10 ${padY} ${compact ? "" : "px-6"} text-ink text-center`}
        style={{ margin: 0 }}
      >
        <h2
          className={`${titleSize} font-extrabold text-info-text drop-shadow-[0_0_15px_rgba(56,189,248,0.5)] ${titleMargin}`}
        >
          Schedule Your Session
        </h2>
        <BookingForm />
      </section>
      {!hideFooter && <Suspense fallback={null}><Footer /></Suspense>}
    </>
  );
}
