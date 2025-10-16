import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";

export default function Benchmarks() {
  const [selectedImage, setSelectedImage] = useState(null);
  const [fadeIn, setFadeIn] = useState(false);

  useEffect(() => {
    if (selectedImage) setFadeIn(true);
    else setFadeIn(false);
  }, [selectedImage]);

  return (
    <div className="relative py-12 px-4 max-w-7xl mx-auto text-white">
      {/* Image Modal */}
      {selectedImage && (
        <div
          className={`fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 transition-opacity duration-300 ${
            fadeIn ? "opacity-100" : "opacity-0"
          }`}
          onClick={() => setSelectedImage(null)}
        >
          <img
            src={selectedImage}
            alt="Enlarged"
            className="max-w-[90%] max-h-[90%] rounded-lg shadow-lg object-contain transition-transform duration-300 scale-95 hover:scale-100"
          />
        </div>
      )}

      {/* Back to Home button */}
      {!selectedImage && (
        <Link
          to="/"
          className="fixed top-11 left-11 bg-transparent border border-cyan-500 text-cyan-500 hover:bg-cyan-500 hover:text-black font-semibold py-2 px-4 rounded z-50 transition duration-300 hidden sm:block"
        >
          ← Back to Home
        </Link>
      )}

      {/* Title */}
      <h1 className="text-4xl font-extrabold text-center mb-2">
        Performance Benchmarks
      </h1>
      <p className="text-center text-gray-300 mb-12">
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
              src="/Benchmark/Bul/discord.png"
              alt="Customer Discord Review"
              className="rounded-lg shadow-lg mx-auto cursor-pointer border border-gray-500 hover:border-green-500 hover:shadow-green-500/40 transition duration-300"
              onClick={() => setSelectedImage("/Benchmark/Bul/discord.png")}
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
                onClick={() => setSelectedImage("/Benchmark/Cata/before1.png")}
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
              src="/Benchmark/Rsk/discord.png"
              alt="Customer Discord Review"
              className="rounded-lg shadow-lg mx-auto cursor-pointer border border-gray-500 hover:border-green-500 hover:shadow-green-500/40 transition duration-300"
              onClick={() => setSelectedImage("/Benchmark/Rsk/discord.png")}
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
                onClick={() => setSelectedImage("/Benchmark/Benzah/before.png")}
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
                onClick={() => setSelectedImage("/Benchmark/Benzah/after.png")}
              />
            </div>
          </div>
          <div className="mt-6 text-center">
            <img
              src="/Benchmark/Benzah/discord.png"
              alt="Customer Discord Review"
              className="rounded-lg shadow-lg mx-auto cursor-pointer border border-gray-500 hover:border-green-500 hover:shadow-green-500/40 transition duration-300"
              onClick={() => setSelectedImage("/Benchmark/Benzah/discord.png")}
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
              src="/Benchmark/Aum/discord.png"
              alt="Customer Discord Review"
              className="rounded-lg shadow-lg mx-auto cursor-pointer border border-gray-500 hover:border-green-500 hover:shadow-green-500/40 transition duration-300"
              onClick={() => setSelectedImage("/Benchmark/Aum/discord.png")}
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
              src="/Benchmark/Jx/discord.png"
              alt="Customer Discord Review"
              className="rounded-lg shadow-lg mx-auto cursor-pointer border border-gray-500 hover:border-green-500 hover:shadow-green-500/40 transition duration-300"
              onClick={() => setSelectedImage("/Benchmark/Jx/discord.png")}
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
              src="/Benchmark/Void/discord.png"
              alt="Customer Discord Review"
              className="rounded-lg shadow-lg mx-auto cursor-pointer border border-gray-500 hover:border-green-500 hover:shadow-green-500/40 transition duration-300"
              onClick={() => setSelectedImage("/Benchmark/Void/discord.png")}
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
              src="/Benchmark/Kyorisk/discord.png"
              alt="Customer Discord Review"
              className="rounded-lg shadow-lg mx-auto cursor-pointer border border-gray-500 hover:border-green-500 hover:shadow-green-500/40 transition duration-300"
              onClick={() => setSelectedImage("/Benchmark/Kyorisk/discord.png")}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
