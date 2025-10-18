import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";

export default function Reviews() {
  const [selectedImage, setSelectedImage] = useState(null);
  const [fadeIn, setFadeIn] = useState(false);

  // Fade-in effect
  useEffect(() => {
    if (selectedImage) setFadeIn(true);
    else setFadeIn(false);
  }, [selectedImage]);

  // Escape key & scroll lock
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape") setSelectedImage(null);
    };

    if (selectedImage) {
      document.body.style.overflow = "hidden";
      window.addEventListener("keydown", handleKeyDown);
    } else {
      document.body.style.overflow = "auto";
    }

    return () => {
      document.body.style.overflow = "auto";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedImage]);

  return (
    <section id="homepage-reviews" className="py-20 text-center">
      <h2 className="text-4xl font-extrabold text-white mb-3">
        What People Say
      </h2>
      <p className="text-slate-400 mb-10">
        Feedback from clients I've had the pleasure of helping.
      </p>

      <div className="flex flex-col items-center">
        {/* Review Image */}
        <div
          className="relative rounded-2xl overflow-hidden max-w-5xl border-2 cursor-pointer"
          style={{ borderColor: "#1f657e" }}
          onClick={() => setSelectedImage("/reviews_mod.png")}
        >
          <img
            src="/reviews_mod.png"
            alt="Client Discord Reviews"
            className="w-full h-auto block"
          />
        </div>

        {/* More Reviews Button */}
        <Link
          to="/morereviews"
          className="mt-8 rounded-md bg-gradient-to-r from-sky-600 to-blue-700 px-5 py-3 text-sm font-semibold text-white hover:from-sky-500 hover:to-blue-600 hover:shadow-[0_0_20px_rgba(56,189,248,0.7)] active:translate-y-px transition-all duration-300"
        >
          More Reviews →
        </Link>
      </div>

      {/* Modal */}
      {selectedImage && (
        <div
          className={`fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 transition-opacity duration-300 ${
            fadeIn ? "opacity-100" : "opacity-0"
          }`}
          onClick={() => setSelectedImage(null)}
        >
          <img
            src={selectedImage}
            alt="Enlarged Review"
            className="max-w-[90%] max-h-[90%] rounded-lg shadow-lg object-contain transition-transform duration-300 scale-95 hover:scale-100"
          />
        </div>
      )}
    </section>
  );
}
