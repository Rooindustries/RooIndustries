import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";

export default function Benchmarks({ setIsModalOpen = () => {} }) {
  const [selectedImage, setSelectedImage] = useState(null);
  const [fadeIn, setFadeIn] = useState(false);
  const [isZoomed, setIsZoomed] = useState(false);
  const [zoomOrigin, setZoomOrigin] = useState({ x: "50%", y: "50%" });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });

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
      document.body.classList.remove("is-modal-open");
    };
  }, [selectedImage]);

  // Handle zoom click
  const handleImageClick = (e) => {
    e.stopPropagation();

    if (isZoomed) {
      // Zoom out - reset everything
      setIsZoomed(false);
      setPanOffset({ x: 0, y: 0 });
    } else {
      // Zoom in
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
    <>
      <div className="relative py-28 px-4 max-w-7xl mx-auto text-white">
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
              alt="Enlarged"
              onClick={handleImageClick}
              onMouseDown={handleMouseDown}
              className={`rounded-lg shadow-lg w-[70%] h-auto sm:max-w-70%] sm:max-h-[70%] max-w-none max-h-none select-none ${
                isPanning ? "" : "transition-transform duration-300"
              }`}
              style={{
                transformOrigin: `${zoomOrigin.x} ${zoomOrigin.y}`,
                transform: isZoomed
                  ? `scale(1.6) translate(${panOffset.x / 1.6}px, ${
                      panOffset.y / 1.6
                    }px)`
                  : "scale(1)",
                cursor: isZoomed
                  ? isPanning
                    ? "grabbing"
                    : "grab"
                  : "zoom-in",
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

        <div className="py-5 px-4 max-w-7xl mx-auto text-white">
          {/* ================== Bul ================== */}
          <div className="mb-12">
            <h2 className="text-3xl font-bold text-center mb-4">Bul</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="border-2 border-red-600 rounded-lg p-2">
                <div className="bg-red-600 text-white text-xs font-bold px-2 py-1 inline-block rounded mb-2">
                  BEFORE
                </div>
                <img
                  src="/Benchmark/Bul/before.png"
                  alt="Before Image"
                  className="rounded w-full cursor-pointer shadow-lg border border-red-600 hover:border-red-500 hover:shadow-red-500/40 transition duration-300"
                  onClick={() => setSelectedImage("/Benchmark/Bul/before.png")}
                />
              </div>
              <div className="border-2 border-cyan-600 rounded-lg p-2">
                <div className="bg-cyan-600 text-white text-xs font-bold px-2 py-1 inline-block rounded mb-2">
                  AFTER
                </div>
                <img
                  src="/Benchmark/Bul/after.png"
                  alt="After Image"
                  className="rounded w-full cursor-pointer shadow-lg border border-cyan-600 hover:border-cyan-500 hover:shadow-cyan-500/40 transition duration-300"
                  onClick={() => setSelectedImage("/Benchmark/Bul/after.png")}
                />
              </div>
            </div>
            <div className="mt-6 text-center">
              <img
                src="/Benchmark/Bul/discordMod.png"
                alt="Customer Discord Review"
                className="rounded-lg shadow-lg mx-auto cursor-pointer border border-gray-500 hover:border-green-500 hover:shadow-green-500/40 transition duration-300"
                onClick={() =>
                  setSelectedImage("/Benchmark/Bul/discordMod.png")
                }
              />
            </div>
          </div>

          {/* ================== Cata ================== */}
          <div className="mb-12">
            <h2 className="text-3xl font-bold text-center mb-4">Cata</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="border-2 border-red-600 rounded-lg p-2">
                <div className="bg-red-600 text-white text-xs font-bold px-2 py-1 inline-block rounded mb-2">
                  BEFORE
                </div>
                <img
                  src="/Benchmark/Cata/before1.png"
                  alt="Before Image"
                  className="rounded w-full cursor-pointer shadow-lg border border-red-600 hover:border-red-500 hover:shadow-red-500/40 transition duration-300"
                  onClick={() =>
                    setSelectedImage("/Benchmark/Cata/before1.png")
                  }
                />
              </div>
              <div className="border-2 border-cyan-600 rounded-lg p-2">
                <div className="bg-cyan-600 text-white text-xs font-bold px-2 py-1 inline-block rounded mb-2">
                  AFTER
                </div>
                <img
                  src="/Benchmark/Cata/after1.png"
                  alt="After Image"
                  className="rounded w-full cursor-pointer shadow-lg border border-cyan-600 hover:border-cyan-500 hover:shadow-cyan-500/40 transition duration-300"
                  onClick={() => setSelectedImage("/Benchmark/Cata/after1.png")}
                />
              </div>
            </div>
            <div className="mt-6 text-center">
              <img
                src="/Benchmark/Cata/discord.png"
                alt="Customer Discord Review"
                className="rounded-lg shadow-lg mx-auto cursor-pointer border border-gray-500 hover:border-green-500 hover:shadow-green-500/40 transition duration-300"
                onClick={() => setSelectedImage("/Benchmark/Cata/discord.png")}
              />
            </div>
          </div>

          {/* ================== Rsk ================== */}
          <div className="mb-12">
            <h2 className="text-3xl font-bold text-center mb-4">Rsk</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="border-2 border-red-600 rounded-lg p-2">
                <div className="bg-red-600 text-white text-xs font-bold px-2 py-1 inline-block rounded mb-2">
                  BEFORE
                </div>
                <img
                  src="/Benchmark/Rsk/before.png"
                  alt="Before Image"
                  className="rounded w-full cursor-pointer shadow-lg border border-red-600 hover:border-red-500 hover:shadow-red-500/40 transition duration-300"
                  onClick={() => setSelectedImage("/Benchmark/Rsk/before.png")}
                />
              </div>
              <div className="border-2 border-cyan-600 rounded-lg p-2">
                <div className="bg-cyan-600 text-white text-xs font-bold px-2 py-1 inline-block rounded mb-2">
                  AFTER
                </div>
                <img
                  src="/Benchmark/Rsk/after.png"
                  alt="After Image"
                  className="rounded w-full cursor-pointer shadow-lg border border-cyan-600 hover:border-cyan-500 hover:shadow-cyan-500/40 transition duration-300"
                  onClick={() => setSelectedImage("/Benchmark/Rsk/after.png")}
                />
              </div>
            </div>
            <div className="mt-6 text-center">
              <img
                src="/Benchmark/Rsk/discordMod.png"
                alt="Customer Discord Review"
                className="rounded-lg shadow-lg mx-auto cursor-pointer border border-gray-500 hover:border-green-500 hover:shadow-green-500/40 transition duration-300"
                onClick={() =>
                  setSelectedImage("/Benchmark/Rsk/discordMod.png")
                }
              />
            </div>
          </div>

          {/* ================== Benzah ================== */}
          <div className="mb-12">
            <h2 className="text-3xl font-bold text-center mb-4">Benzah</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="border-2 border-red-600 rounded-lg p-2">
                <div className="bg-red-600 text-white text-xs font-bold px-2 py-1 inline-block rounded mb-2">
                  BEFORE
                </div>
                <img
                  src="/Benchmark/Benzah/before.png"
                  alt="Before Image"
                  className="rounded w-full cursor-pointer shadow-lg border border-red-600 hover:border-red-500 hover:shadow-red-500/40 transition duration-300"
                  onClick={() =>
                    setSelectedImage("/Benchmark/Benzah/before.png")
                  }
                />
              </div>
              <div className="border-2 border-cyan-600 rounded-lg p-2">
                <div className="bg-cyan-600 text-white text-xs font-bold px-2 py-1 inline-block rounded mb-2">
                  AFTER
                </div>
                <img
                  src="/Benchmark/Benzah/after.png"
                  alt="After Image"
                  className="rounded w-full cursor-pointer shadow-lg border border-cyan-600 hover:border-cyan-500 hover:shadow-cyan-500/40 transition duration-300"
                  onClick={() =>
                    setSelectedImage("/Benchmark/Benzah/after.png")
                  }
                />
              </div>
            </div>
            <div className="mt-6 text-center">
              <img
                src="/Benchmark/Benzah/discordMod.png"
                alt="Customer Discord Review"
                className="rounded-lg shadow-lg mx-auto cursor-pointer border border-gray-500 hover:border-green-500 hover:shadow-green-500/40 transition duration-300"
                onClick={() =>
                  setSelectedImage("/Benchmark/Benzah/discordMod.png")
                }
              />
            </div>
          </div>

          {/* ================== Aum ================== */}
          <div className="mb-12">
            <h2 className="text-3xl font-bold text-center mb-4">Aum</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="border-2 border-red-600 rounded-lg p-2">
                <div className="bg-red-600 text-white text-xs font-bold px-2 py-1 inline-block rounded mb-2">
                  BEFORE
                </div>
                <img
                  src="/Benchmark/Aum/before.webp"
                  alt="Before Image"
                  className="rounded w-full cursor-pointer shadow-lg border border-red-600 hover:border-red-500 hover:shadow-red-500/40 transition duration-300"
                  onClick={() => setSelectedImage("/Benchmark/Aum/before.webp")}
                />
              </div>
              <div className="border-2 border-cyan-600 rounded-lg p-2">
                <div className="bg-cyan-600 text-white text-xs font-bold px-2 py-1 inline-block rounded mb-2">
                  AFTER
                </div>
                <img
                  src="/Benchmark/Aum/after.webp"
                  alt="After Image"
                  className="rounded w-full cursor-pointer shadow-lg border border-cyan-600 hover:border-cyan-500 hover:shadow-cyan-500/40 transition duration-300"
                  onClick={() => setSelectedImage("/Benchmark/Aum/after.webp")}
                />
              </div>
            </div>
            <div className="mt-6 text-center">
              <img
                src="/Benchmark/Aum/discordMod.png"
                alt="Customer Discord Review"
                className="rounded-lg shadow-lg mx-auto cursor-pointer border border-gray-500 hover:border-green-500 hover:shadow-green-500/40 transition duration-300"
                onClick={() =>
                  setSelectedImage("/Benchmark/Aum/discordMod.png")
                }
              />
            </div>
          </div>

          {/* ================== Jx ================== */}
          <div className="mb-12">
            <h2 className="text-3xl font-bold text-center mb-4">Jx</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="border-2 border-red-600 rounded-lg p-2">
                <div className="bg-red-600 text-white text-xs font-bold px-2 py-1 inline-block rounded mb-2">
                  BEFORE
                </div>
                <img
                  src="/Benchmark/Jx/before.png"
                  alt="Before Image"
                  className="rounded w-full cursor-pointer shadow-lg border border-red-600 hover:border-red-500 hover:shadow-red-500/40 transition duration-300"
                  onClick={() => setSelectedImage("/Benchmark/Jx/before.png")}
                />
              </div>
              <div className="border-2 border-cyan-600 rounded-lg p-2">
                <div className="bg-cyan-600 text-white text-xs font-bold px-2 py-1 inline-block rounded mb-2">
                  AFTER
                </div>
                <img
                  src="/Benchmark/Jx/after.png"
                  alt="After Image"
                  className="rounded w-full cursor-pointer shadow-lg border border-cyan-600 hover:border-cyan-500 hover:shadow-cyan-500/40 transition duration-300"
                  onClick={() => setSelectedImage("/Benchmark/Jx/after.png")}
                />
              </div>
            </div>
            <div className="mt-6 text-center">
              <img
                src="/Benchmark/Jx/discordMod.png"
                alt="Customer Discord Review"
                className="rounded-lg shadow-lg mx-auto cursor-pointer border border-gray-500 hover:border-green-500 hover:shadow-green-500/40 transition duration-300"
                onClick={() => setSelectedImage("/Benchmark/Jx/discordMod.png")}
              />
            </div>
          </div>

          {/* ================== Void ================== */}
          <div className="mb-12">
            <h2 className="text-3xl font-bold text-center mb-4">Void</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="border-2 border-red-600 rounded-lg p-2">
                <div className="bg-red-600 text-white text-xs font-bold px-2 py-1 inline-block rounded mb-2">
                  BEFORE
                </div>
                <img
                  src="/Benchmark/Void/before.png"
                  alt="Before Image"
                  className="rounded w-full cursor-pointer shadow-lg border border-red-600 hover:border-red-500 hover:shadow-red-500/40 transition duration-300"
                  onClick={() => setSelectedImage("/Benchmark/Void/before.png")}
                />
              </div>
              <div className="border-2 border-cyan-600 rounded-lg p-2">
                <div className="bg-cyan-600 text-white text-xs font-bold px-2 py-1 inline-block rounded mb-2">
                  AFTER
                </div>
                <img
                  src="/Benchmark/Void/after.png"
                  alt="After Image"
                  className="rounded w-full cursor-pointer shadow-lg border border-cyan-600 hover:border-cyan-500 hover:shadow-cyan-500/40 transition duration-300"
                  onClick={() => setSelectedImage("/Benchmark/Void/after.png")}
                />
              </div>
            </div>
            <div className="mt-6 text-center">
              <img
                src="/Benchmark/Void/discordMod.png"
                alt="Customer Discord Review"
                className="rounded-lg shadow-lg mx-auto cursor-pointer border border-gray-500 hover:border-green-500 hover:shadow-green-500/40 transition duration-300"
                onClick={() =>
                  setSelectedImage("/Benchmark/Void/discordMod.png")
                }
              />
            </div>
          </div>

          {/* ================== Kyorisk ================== */}
          <div className="mb-12">
            <h2 className="text-3xl font-bold text-center mb-4">Kyorisk</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="border-2 border-red-600 rounded-lg p-2">
                <div className="bg-red-600 text-white text-xs font-bold px-2 py-1 inline-block rounded mb-2">
                  BEFORE
                </div>
                <img
                  src="/Benchmark/Kyorisk/before.png"
                  alt="Before Image"
                  className="rounded w-full h-64 object-cover cursor-pointer shadow-lg border border-red-600 hover:border-red-500 hover:shadow-red-500/40 transition duration-300"
                  onClick={() =>
                    setSelectedImage("/Benchmark/Kyorisk/before.png")
                  }
                />
              </div>
              <div className="border-2 border-cyan-600 rounded-lg p-2">
                <div className="bg-cyan-600 text-white text-xs font-bold px-2 py-1 inline-block rounded mb-2">
                  AFTER
                </div>
                <img
                  src="/Benchmark/Kyorisk/afterMod.png"
                  alt="After Image"
                  className="rounded w-full h-64 object-cover cursor-pointer shadow-lg border border-cyan-600 hover:border-cyan-500 hover:shadow-cyan-500/40 transition duration-300"
                  onClick={() =>
                    setSelectedImage("/Benchmark/Kyorisk/afterMod.png")
                  }
                />
              </div>
            </div>
            <div className="mt-6 text-center">
              <img
                src="/Benchmark/Kyorisk/discordMod.png"
                alt="Customer Discord Review"
                className="rounded-lg shadow-lg mx-auto cursor-pointer border border-gray-500 hover:border-green-500 hover:shadow-green-500/40 transition duration-300"
                onClick={() =>
                  setSelectedImage("/Benchmark/Kyorisk/discordMod.png")
                }
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
