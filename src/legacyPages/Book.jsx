import React, { lazy, Suspense, useEffect } from "react";
import BookingForm from "../components/BookingForm";
import { preloadConfirmationPages } from "../lib/confirmationPages";

const Footer = lazy(() => import("../components/Footer"));

export default function Book({ hideFooter = false, compact = false }) {
  useEffect(() => {
    preloadConfirmationPages().catch(() => {});
  }, []);
  const padY = compact ? "pt-2 pb-6" : "pt-32 pb-24";
  const titleClass = compact ? "section-title section-title-compact mb-4" : "section-title mb-10";

  return (
    <>
      <section
        className={`ri-booking relative z-10 ${padY} px-6 text-ink text-center`}
        style={{ margin: 0 }}
      >
        <h2 className={titleClass}>
          Schedule Your Session
        </h2>
        <BookingForm />
      </section>
      {!hideFooter && <Suspense fallback={null}><Footer /></Suspense>}
    </>
  );
}
