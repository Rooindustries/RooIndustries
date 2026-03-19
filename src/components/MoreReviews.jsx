import React, { useState, useEffect } from "react";
import { client, urlFor } from "../sanityClient";
import ImageZoomModal from "./ImageZoomModal";

export default function Reviews() {
  const [selectedImage, setSelectedImage] = useState(null);
  const [selectedAlt, setSelectedAlt] = useState("");
  const [reviews, setReviews] = useState(null);
  const [visibleCount, setVisibleCount] = useState(9);

  useEffect(() => {
    client
      .fetch(
        `*[_type == "review"] | order(_createdAt desc){
          image{
            ...,
            "dimensions": asset->metadata.dimensions
          },
          alt
        }`
      )
      .then((data) => setReviews(Array.isArray(data) ? data : []))
      .catch((error) => {
        console.error(error);
        setReviews([]);
      });
  }, []);

  useEffect(() => {
    if (!Array.isArray(reviews)) return;
    const nextCount = Math.min(12, reviews.length);
    setVisibleCount(nextCount);
  }, [reviews]);

  const isLoading = reviews === null;
  const placeholderCount = 18;
  const visibleReviews = Array.isArray(reviews)
    ? reviews.slice(0, visibleCount)
    : reviews;
  const reviewItems = isLoading
    ? Array.from({ length: placeholderCount }, (_, index) => ({
        __placeholder: true,
        key: `placeholder-${index}`,
      }))
    : visibleReviews;

  // SEO/a11y: keep the alt text aligned with the zoomed review image.
  const handleOpenZoom = (src, altText) => {
    setSelectedImage(src);
    setSelectedAlt(altText);
  };

  const handleClose = () => {
    setSelectedImage(null);
    setSelectedAlt("");
  };

  return (
    <section className="px-4 mt-20 py-12 max-w-7xl mx-auto">
      <header className="mx-auto max-w-3xl py-10 sm:py-12 md:py-16 flex flex-col items-center justify-center text-center">
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
          Community Reviews
        </h1>
        <p className="mt-5 text-slate-200/90 text-base sm:text-lg leading-relaxed">
          Real feedback from clients who booked optimization sessions with Roo
          Industries, including FPS gains, frametime improvements, and
          day-to-day smoothness results.
        </p>
        <p className="mt-3 text-sky-300/90 text-sm sm:text-base font-semibold">
          Scroll down to view the full gallery.
        </p>
      </header>

      <div className="mt-8 columns-1 lg:columns-2 gap-4 space-y-4">
        {reviewItems.map((rev, i) => {
          if (rev.__placeholder) {
            return (
              <div
                key={rev.key}
                className="break-inside-avoid overflow-hidden rounded-xl"
                aria-hidden="true"
              >
                <div className="w-full rounded-xl border border-white/10 bg-slate-900/60 shadow-lg aspect-[4/5] animate-pulse" />
              </div>
            );
          }

          const reviewAlt = rev.alt || "Client review screenshot";
          const reviewDims = rev.image?.dimensions;
          const reviewSrc = rev.image
            ? urlFor(rev.image).format("webp").quality(95).url()
            : "";
          const reviewZoomSrc = rev.image ? urlFor(rev.image).url() : reviewSrc;

          return (
            <div
              key={i}
              className="break-inside-avoid overflow-hidden rounded-xl"
            >
              {/* SEO/CLS: wrap each review image with a semantic figure/caption and intrinsic size. */}
              <figure className="m-0">
                <img
                  src={reviewSrc}
                  alt={reviewAlt}
                  width={reviewDims?.width}
                  height={reviewDims?.height}
                  loading="lazy"
                  decoding="async"
                  fetchPriority="auto"
                  sizes="(max-width: 640px) 90vw, (max-width: 1024px) 40vw, 24vw"
                  className="w-full h-auto rounded-xl cursor-pointer shadow-lg hover:shadow-cyan-400/30 transition duration-300 object-contain"
                  onClick={() =>
                    handleOpenZoom(reviewZoomSrc, reviewAlt)
                  }
                />
                <figcaption className="sr-only">{reviewAlt}</figcaption>
              </figure>
            </div>
          );
        })}
      </div>

      {!isLoading && Array.isArray(reviews) && visibleCount < reviews.length && (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={() =>
              setVisibleCount((prev) => Math.min(prev + 9, reviews.length))
            }
            className="rounded-xl border border-white/30 bg-white/15 px-4 py-2 text-sm font-semibold text-white hover:bg-white/25 transition-colors"
          >
            Load more reviews
          </button>
        </div>
      )}

      {selectedImage && (
        <ImageZoomModal
          src={selectedImage}
          alt={selectedAlt || "Client review screenshot"}
          onClose={handleClose}
        />
      )}
    </section>
  );
}
