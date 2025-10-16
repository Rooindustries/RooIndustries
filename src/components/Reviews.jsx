import React from "react";

export default function Reviews() {
  return (
    <section id="reviews" className="py-20 text-center">
      <h2 className="text-4xl font-extrabold text-white mb-3">
        What People Say
      </h2>
      <p className="text-slate-400 mb-10">
        Feedback from clients I've had the pleasure of helping.
      </p>

      {/* The image container */}
      <div className="flex justify-center">
        <div
          className="relative rounded-2xl overflow-hidden max-w-5xl border-2"
          style={{ borderColor: "#1f657e" }}
        >
          <img
            src="/reviews.png"
            alt="Client Discord Reviews"
            className="w-full h-auto block"
          />
        </div>
      </div>
    </section>
  );
}
