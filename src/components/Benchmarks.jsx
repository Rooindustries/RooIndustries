import React, { useState, useEffect } from "react";
import { client, urlFor } from "../sanityClient";

export default function Benchmarks({ setIsModalOpen = () => {} }) {
  const [benchmarks, setBenchmarks] = useState([]);
  const [selectedImage, setSelectedImage] = useState(null);
  const [fadeIn, setFadeIn] = useState(false);
  const [isZoomed, setIsZoomed] = useState(false);
  const [zoomOrigin, setZoomOrigin] = useState({ x: "50%", y: "50%" });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });

  // Fetch data from Sanity
  useEffect(() => {
    client
      .fetch(
        `*[_type == "benchmark"]{title, beforeImage, afterImage, reviewImage}`
      )
      .then(setBenchmarks)
      .catch(console.error);
  }, []);

  // Handle modal and body scroll lock
  useEffect(() => {
    const hasModal = Boolean(selectedImage);
    if (hasModal) {
      setFadeIn(true);
      setIsModalOpen(true);
      document.body.classList.add("is-modal-open");
    } else {
      setFadeIn(false);
      setIsModalOpen(false);
      document.body.classList.remove("is-modal-open");
    }
  }, [selectedImage, setIsModalOpen]);

  // Escape key to close modal
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
      document.body.classList.remove("is-modal-open");
    };
  }, [selectedImage]);

  // Zoom logic
  const handleImageClick = (e) => {
    e.stopPropagation();

    if (isZoomed) {
      setIsZoomed(false);
      setPanOffset({ x: 0, y: 0 });
    } else {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      setZoomOrigin({ x: `${x}%`, y: `${y}%` });
      setIsZoomed(true);
    }
  };

  // Pan handlers
  const handleMouseDown = (e) => {
    if (!isZoomed) return;
    e.preventDefault();
    setIsPanning(true);
    setPanStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
  };

  const handleMouseMove = (e) => {
    if (!isPanning || !isZoomed) return;
    e.preventDefault();
    setPanOffset({
      x: e.clientX - panStart.x,
      y: e.clientY - panStart.y,
    });
  };

  const handleMouseUp = () => {
    setIsPanning(false);
  };

  const handleClose = () => {
    setIsZoomed(false);
    setSelectedImage(null);
    setIsModalOpen(false);
    setPanOffset({ x: 0, y: 0 });
    document.body.classList.remove("is-modal-open");
  };

  return (
    <section className="relative py-28 px-4 max-w-7xl mx-auto text-white">
      {/* Image Modal */}
      {selectedImage && (
        <div
          className={`fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-[9999] transition-opacity duration-300 ${
            fadeIn ? "opacity-100" : "opacity-0"
          }`}
          onClick={handleClose}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <img
            src={selectedImage}
            alt="Zoomed"
            onClick={handleImageClick}
            onMouseDown={handleMouseDown}
            className={`rounded-lg shadow-lg w-[70%] h-auto sm:max-w-[70%] max-w-none select-none ${
              isPanning ? "" : "transition-transform duration-300"
            }`}
            style={{
              transformOrigin: `${zoomOrigin.x} ${zoomOrigin.y}`,
              transform: isZoomed
                ? `scale(1.6) translate(${panOffset.x / 1.6}px, ${
                    panOffset.y / 1.6
                  }px)`
                : "scale(1)",
              cursor: isZoomed ? (isPanning ? "grabbing" : "grab") : "zoom-in",
            }}
            draggable="false"
          />
        </div>
      )}

      {/* Title */}
      <h1 className="text-4xl font-extrabold text-center mb-2">
        Performance Benchmarks
      </h1>
      <p className="text-center text-gray-100 mb-12">
        Real results from real optimizations.
      </p>

      {/* Benchmarks */}
      <div className="py-5 px-4 max-w-7xl mx-auto text-white">
        {benchmarks.map((b, i) => (
          <div key={i} className="mb-12">
            <h2 className="text-3xl font-bold text-center mb-4">{b.title}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Before */}
              <div className="border-2 border-red-600 rounded-lg p-2">
                <div className="bg-red-600 text-white text-xs font-bold px-2 py-1 inline-block rounded mb-2">
                  BEFORE
                </div>
                <img
                  src={urlFor(b.beforeImage).url()}
                  alt={`${b.title} Before`}
                  className="rounded w-full cursor-pointer shadow-lg border border-red-600 hover:border-red-500 hover:shadow-red-500/40 transition duration-300"
                  onClick={() => setSelectedImage(urlFor(b.beforeImage).url())}
                />
              </div>

              {/* After */}
              <div className="border-2 border-cyan-600 rounded-lg p-2">
                <div className="bg-cyan-600 text-white text-xs font-bold px-2 py-1 inline-block rounded mb-2">
                  AFTER
                </div>
                <img
                  src={urlFor(b.afterImage).url()}
                  alt={`${b.title} After`}
                  className="rounded w-full cursor-pointer shadow-lg border border-cyan-600 hover:border-cyan-500 hover:shadow-cyan-500/40 transition duration-300"
                  onClick={() => setSelectedImage(urlFor(b.afterImage).url())}
                />
              </div>
            </div>

            {/* Review */}
            {b.reviewImage && (
              <div className="mt-6 text-center">
                <img
                  src={urlFor(b.reviewImage).url()}
                  alt={`${b.title} Review`}
                  className="rounded-lg shadow-lg mx-auto cursor-pointer border border-gray-500 hover:border-green-500 hover:shadow-green-500/40 transition duration-300"
                  onClick={() => setSelectedImage(urlFor(b.reviewImage).url())}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
