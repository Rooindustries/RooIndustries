import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";

export default function Reviews() {
  const [selectedImage, setSelectedImage] = useState(null);
  const [fadeIn, setFadeIn] = useState(false);
  const [isZoomed, setIsZoomed] = useState(false);
  const [zoomOrigin, setZoomOrigin] = useState({ x: "50%", y: "50%" });
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragStart, setDragStart] = useState(null);

  useEffect(() => setFadeIn(Boolean(selectedImage)), [selectedImage]);

  useEffect(() => {
    const handleKeyDown = (e) => e.key === "Escape" && setSelectedImage(null);
    if (selectedImage) {
      document.body.style.overflow = "hidden";
      document.body.classList.add("is-modal-open");
      window.addEventListener("keydown", handleKeyDown);
    } else {
      document.body.style.overflow = "auto";
      document.body.classList.remove("is-modal-open");
    }
    return () => {
      document.body.style.overflow = "auto";
      document.body.classList.remove("is-modal-open");
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedImage]);

  const handleImageClick = (e) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setZoomOrigin({ x: `${x}%`, y: `${y}%` });
    setIsZoomed((z) => !z);
    if (!isZoomed) setOffset({ x: 0, y: 0 });
  };

  const handleMouseDown = (e) => {
    if (!isZoomed) return;
    e.preventDefault();
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const handleMouseMove = (e) => {
    if (!isZoomed || !dragStart) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    setOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const handleMouseUp = () => setDragStart(null);
  const handleClose = () => {
    setIsZoomed(false);
    setSelectedImage(null);
    setOffset({ x: 0, y: 0 });
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

        <Link
          to="/morereviews"
          className="mt-8 rounded-md bg-gradient-to-r from-sky-600 to-blue-700 px-5 py-3 text-sm font-semibold text-white hover:from-sky-500 hover:to-blue-600 hover:shadow-[0_0_20px_rgba(56,189,248,0.7)] active:translate-y-px transition-all duration-300"
        >
          More Reviews →
        </Link>
      </div>

      {selectedImage && (
        <div
          className={`fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 transition-opacity duration-300 ${
            fadeIn ? "opacity-100" : "opacity-0"
          }`}
          onClick={handleClose}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <img
            src={selectedImage}
            alt="Enlarged Review"
            onClick={handleImageClick}
            onMouseDown={handleMouseDown}
            className={`rounded-lg shadow-lg select-none ${
              dragStart ? "" : "transition-transform duration-300"
            } w-[75%] sm:max-w-[70%] sm:max-h-[70%] max-w-none max-h-none`}
            style={{
              transformOrigin: `${zoomOrigin.x} ${zoomOrigin.y}`,
              transform: isZoomed
                ? `translate(${offset.x / 1.6}px, ${
                    offset.y / 1.6
                  }px) scale(1.6)`
                : "scale(1)",
              cursor: isZoomed ? (dragStart ? "grabbing" : "grab") : "zoom-in",
            }}
            draggable="false"
          />
        </div>
      )}
    </section>
  );
}
