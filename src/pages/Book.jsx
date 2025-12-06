import React from "react";
import BookingForm from "../components/BookingForm";
import Footer from "../components/Footer";
export default function Book() {
  return (
    <section className="relative z-10 pt-32 pb-24 px-6 text-white text-center">
      <h2 className="text-4xl sm:text-5xl font-extrabold text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)] mb-10">
        Schedule Your Session
      </h2>
      <BookingForm />
      <Footer />
    </section>
  );
}
