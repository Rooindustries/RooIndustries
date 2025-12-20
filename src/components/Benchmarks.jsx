import React, { useState, useEffect } from "react";
import { client, urlFor } from "../sanityClient";
import ImageZoomModal from "../components/ImageZoomModal";

export default function Benchmarks({ setIsModalOpen = () => {} }) {
  const [benchmarks, setBenchmarks] = useState([]);
  const [selectedImage, setSelectedImage] = useState(null);
  const [selectedAlt, setSelectedAlt] = useState("");

  // SEO/a11y: preserve the correct alt text when opening the zoom modal.
  const handleOpenZoom = (src, altText) => {
    setSelectedImage(src);
    setSelectedAlt(altText);
  };

  const handleCloseZoom = () => {
    setSelectedImage(null);
    setSelectedAlt("");
  };

  useEffect(() => {
    client
      .fetch(
        `*[_type == "benchmark"] 
          | order(coalesce(sortOrder, 9999) asc, _createdAt asc) {
            title,
            subtitle,
            beforeImage{
              ...,
              "dimensions": asset->metadata.dimensions
            },
            afterImage{
              ...,
              "dimensions": asset->metadata.dimensions
            },
            reviewImage{
              ...,
              "dimensions": asset->metadata.dimensions
            }
          }`
      )
      .then(setBenchmarks)
      .catch(console.error);
  }, []);

  return (
    <section className="relative py-28 px-4 max-w-7xl mx-auto text-white">
      {selectedImage && (
        <ImageZoomModal
          src={selectedImage}
          alt={selectedAlt || "Benchmark zoomed"}
          onClose={handleCloseZoom}
          setIsModalOpen={setIsModalOpen}
        />
      )}

      <h1 className="text-4xl sm:text-5xl font-extrabold text-center mb-2 text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Performance Benchmarks
      </h1>
      <p className="text-center text-gray-100 mb-12">
        Real results from real tuning.
      </p>

      <div className="py-5 px-4 max-w-7xl mx-auto text-white">
        {benchmarks.map((b, i) => {
          const beforeDims = b.beforeImage?.dimensions;
          const afterDims = b.afterImage?.dimensions;
          const reviewDims = b.reviewImage?.dimensions;
          const beforeAlt = b.title
            ? `${b.title} benchmark before optimization`
            : "Benchmark before optimization";
          const afterAlt = b.title
            ? `${b.title} benchmark after optimization`
            : "Benchmark after optimization";
          const reviewAlt = b.title
            ? `${b.title} client review`
            : "Client review screenshot";

          return (
            <div key={i} className="mb-12">
              <h2 className="text-3xl font-bold text-center mb-1">{b.title}</h2>
              {b.subtitle && (
                <p className="text-center text-slate-300 mb-4 text-sm">
                  {b.subtitle}
                </p>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Before */}
                <div className="border-2 border-red-600 rounded-lg p-2">
                  <div className="bg-red-600 text-white text-xs font-bold px-2 py-1 inline-block rounded mb-2">
                    BEFORE
                  </div>
                  {/* SEO/CLS: keep benchmark images in semantic figures with intrinsic sizing. */}
                  <figure className="m-0">
                    <img
                      src={urlFor(b.beforeImage).url()}
                      alt={beforeAlt}
                      width={beforeDims?.width}
                      height={beforeDims?.height}
                      loading="lazy"
                      decoding="async"
                      className="rounded w-full cursor-pointer shadow-lg border border-red-600 hover:border-red-500 hover:shadow-red-500/40 transition duration-300"
                      onClick={() =>
                        handleOpenZoom(urlFor(b.beforeImage).url(), beforeAlt)
                      }
                    />
                    <figcaption className="sr-only">{beforeAlt}</figcaption>
                  </figure>
                </div>

                {/* After */}
                <div className="border-2 border-cyan-600 rounded-lg p-2">
                  <div className="bg-cyan-600 text-white text-xs font-bold px-2 py-1 inline-block rounded mb-2">
                    AFTER
                  </div>
                  {/* SEO/CLS: keep benchmark images in semantic figures with intrinsic sizing. */}
                  <figure className="m-0">
                    <img
                      src={urlFor(b.afterImage).url()}
                      alt={afterAlt}
                      width={afterDims?.width}
                      height={afterDims?.height}
                      loading="lazy"
                      decoding="async"
                      className="rounded w-full cursor-pointer shadow-lg border border-cyan-600 hover:border-cyan-500 hover:shadow-cyan-500/40 transition duration-300"
                      onClick={() =>
                        handleOpenZoom(urlFor(b.afterImage).url(), afterAlt)
                      }
                    />
                    <figcaption className="sr-only">{afterAlt}</figcaption>
                  </figure>
                </div>
              </div>

              {/* Review */}
              {b.reviewImage && (
                <div className="mt-6 text-center">
                  {/* SEO/CLS: include review images in a semantic figure with intrinsic sizing. */}
                  <figure className="m-0">
                    <img
                      src={urlFor(b.reviewImage).url()}
                      alt={reviewAlt}
                      width={reviewDims?.width}
                      height={reviewDims?.height}
                      loading="lazy"
                      decoding="async"
                      className="rounded-lg shadow-lg mx-auto cursor-pointer border border-gray-500 hover:border-green-500 hover:shadow-green-500/40 transition duration-300"
                      onClick={() =>
                        handleOpenZoom(urlFor(b.reviewImage).url(), reviewAlt)
                      }
                    />
                    <figcaption className="sr-only">{reviewAlt}</figcaption>
                  </figure>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
