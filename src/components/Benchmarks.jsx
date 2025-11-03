import React, { useState, useEffect } from "react";
import { client, urlFor } from "../sanityClient";
import ImageZoomModal from "../components/ImageZoomModal";

export default function Benchmarks({ setIsModalOpen = () => {} }) {
  const [benchmarks, setBenchmarks] = useState([]);
  const [selectedImage, setSelectedImage] = useState(null);

  useEffect(() => {
    client
      .fetch(
        `*[_type == "benchmark"]{title, beforeImage, afterImage, reviewImage}`
      )
      .then(setBenchmarks)
      .catch(console.error);
  }, []);

  return (
    <section className="relative py-28 px-4 max-w-7xl mx-auto text-white">
      {selectedImage && (
        <ImageZoomModal
          src={selectedImage}
          alt="Benchmark zoomed"
          onClose={() => setSelectedImage(null)}
          setIsModalOpen={setIsModalOpen}
        />
      )}

      <h1 className="text-4xl font-extrabold text-center mb-2">
        Performance Benchmarks
      </h1>
      <p className="text-center text-gray-100 mb-12">
        Real results from real tuning.
      </p>

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
