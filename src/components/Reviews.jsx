import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";

export default function Reviews() {
  const [selectedImage, setSelectedImage] = useState(null);
  const [fadeIn, setFadeIn] = useState(false);
  const [isZoomed, setIsZoomed] = useState(false);
  const [zoomOrigin, setZoomOrigin] = useState({ x: "50%", y: "50%" });

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

  // handle zoom when clicking the image
  const handleImageClick = (e) => {
    e.stopPropagation();
    const rect = e.target.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setZoomOrigin({ x: `${x}%`, y: `${y}%` });
    setIsZoomed((prev) => !prev);
  };

  // reset zoom when closing
  const handleClose = () => {
    setIsZoomed(false);
    setSelectedImage(null);
  };

  return (
    <section id="homepage-reviews" className="py-20 text-center">
      <h2 className="text-4xl font-extrabold text-white mb-3">
        What People Say
      </h2>
      <p className="text-slate-200 mb-10">
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
          onClick={handleClose}
        >
          <img
            src={selectedImage}
            alt="Enlarged Review"
            onClick={handleImageClick}
            className="rounded-lg shadow-lg transition-transform duration-300 
                       w-[75%] sm:max-w-[70%] sm:max-h-[70%] max-w-none max-h-none"
            style={{
              transformOrigin: `${zoomOrigin.x} ${zoomOrigin.y}`,
              transform: isZoomed ? "scale(1.6)" : "scale(1)",
              cursor: isZoomed ? "zoom-out" : "zoom-in",
            }}
          />
        </div>
      )}
    </section>
  );
}
