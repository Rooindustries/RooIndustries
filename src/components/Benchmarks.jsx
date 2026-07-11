import React, { useState, useEffect } from "react";
import { urlFor } from "../sanityClient";
import { getPublicContent } from "../lib/publicContentClient";
import ImageZoomModal from "../components/ImageZoomModal";

const BENCHMARK_IMAGE_WIDTHS = [480, 768, 960, 1280];
const REVIEW_IMAGE_WIDTHS = [480, 768, 960];

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

  const buildImageSrc = (image, width) =>
    image
      ? urlFor(image).width(width).format("webp").quality(60).url()
      : "";

  const buildImageSrcSet = (image, widths) =>
    image
      ? widths
          .map((width) => `${buildImageSrc(image, width)} ${width}w`)
          .join(", ")
      : undefined;

  useEffect(() => {
    getPublicContent("benchmarks")
      .then(setBenchmarks)
      .catch(console.error);
  }, []);

  return (
    <section className="relative py-28 px-4 max-w-7xl mx-auto text-ink">
      {selectedImage && (
        <ImageZoomModal
          src={selectedImage}
          alt={selectedAlt || "Benchmark zoomed"}
          onClose={handleCloseZoom}
          setIsModalOpen={setIsModalOpen}
        />
      )}

      <h1 className="text-4xl sm:text-5xl font-extrabold text-center mb-2 text-info-text drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Performance Benchmarks
      </h1>
      <p className="text-center text-ink-secondary mb-12">
        Real results from real tuning.
      </p>

      <div className="py-5 px-4 max-w-7xl mx-auto text-ink">
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
                <p className="text-center text-ink-secondary mb-4 text-sm">
                  {b.subtitle}
                </p>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Before */}
                <div className="border-2 border-danger-border rounded-lg p-2">
                  <div className="bg-danger text-white text-xs font-bold px-2 py-1 inline-block rounded mb-2">
                    BEFORE
                  </div>
                  {/* SEO/CLS: keep benchmark images in semantic figures with intrinsic sizing. */}
                  <figure className="m-0">
                    <img
                      src={buildImageSrc(b.beforeImage, 1280)}
                      srcSet={buildImageSrcSet(
                        b.beforeImage,
                        BENCHMARK_IMAGE_WIDTHS
                      )}
                      alt={beforeAlt}
                      width={beforeDims?.width}
                      height={beforeDims?.height}
                      loading="lazy"
                      decoding="async"
                      sizes="(max-width: 768px) 94vw, 46vw"
                      className="rounded w-full cursor-pointer shadow-lg border border-danger-border hover:border-danger hover:shadow-danger-soft transition duration-300"
                      onClick={() =>
                        handleOpenZoom(urlFor(b.beforeImage).url(), beforeAlt)
                      }
                    />
                    <figcaption className="sr-only">{beforeAlt}</figcaption>
                  </figure>
                </div>

                {/* After */}
                <div className="border-2 border-success-border rounded-lg p-2">
                  <div className="bg-success text-black text-xs font-bold px-2 py-1 inline-block rounded mb-2">
                    AFTER
                  </div>
                  {/* SEO/CLS: keep benchmark images in semantic figures with intrinsic sizing. */}
                  <figure className="m-0">
                    <img
                      src={buildImageSrc(b.afterImage, 1280)}
                      srcSet={buildImageSrcSet(
                        b.afterImage,
                        BENCHMARK_IMAGE_WIDTHS
                      )}
                      alt={afterAlt}
                      width={afterDims?.width}
                      height={afterDims?.height}
                      loading="lazy"
                      decoding="async"
                      sizes="(max-width: 768px) 94vw, 46vw"
                      className="rounded w-full cursor-pointer shadow-lg border border-success-border hover:border-success hover:shadow-success-soft transition duration-300"
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
                      src={buildImageSrc(b.reviewImage, 960)}
                      srcSet={buildImageSrcSet(
                        b.reviewImage,
                        REVIEW_IMAGE_WIDTHS
                      )}
                      alt={reviewAlt}
                      width={reviewDims?.width}
                      height={reviewDims?.height}
                      loading="lazy"
                      decoding="async"
                      sizes="(max-width: 768px) 94vw, 62vw"
                      className="rounded-lg shadow-lg mx-auto cursor-pointer border border-line-strong hover:border-success hover:shadow-success-soft transition duration-300"
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
