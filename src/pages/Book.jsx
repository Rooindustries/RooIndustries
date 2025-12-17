import React from "react";
import BookingForm from "../components/BookingForm";
import Footer from "../components/Footer";

export default function Book({ hideFooter = false, compact = false }) {
  const padY = compact ? "pt-2 pb-6" : "pt-32 pb-24";
  const titleMargin = compact ? "mb-4" : "mb-10";
  const titleSize = compact ? "text-3xl sm:text-4xl" : "text-4xl sm:text-5xl";

  return (
    <section
      className={`relative z-10 ${padY} px-6 text-white text-center`}
      style={{ margin: 0 }}
    >
      <h2
        className={`${titleSize} font-extrabold text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)] ${titleMargin}`}
      >
        Schedule Your Session
      </h2>
      <BookingForm />
      {!hideFooter && <Footer />}
    </section>
  );
}
