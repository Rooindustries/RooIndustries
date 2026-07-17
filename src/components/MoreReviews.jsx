import React, { useState, useEffect } from "react";
import { urlFor } from "../sanityClient";
import { getPublicContent } from "../lib/publicContentClient";
import ImageZoomModal from "./ImageZoomModal";

const localDiscordReviews = [];
const REVIEW_IMAGE_WIDTHS = [320, 480, 640, 800];

const buildReviewImageUrl = (image, width) =>
  urlFor(image).width(width).format("webp").quality(85).url();

const buildReviewImageSrcSet = (image) => {
  const sources = REVIEW_IMAGE_WIDTHS.map((width) => ({
    url: buildReviewImageUrl(image, width),
    width,
  }));
  if (new Set(sources.map(({ url }) => url)).size < 2) return undefined;
  return sources.map(({ url, width }) => `${url} ${width}w`).join(", ");
};

export default function Reviews() {
  const [selectedImage, setSelectedImage] = useState(null);
  const [selectedAlt, setSelectedAlt] = useState("");
  const [reviews, setReviews] = useState(null);

  useEffect(() => {
    getPublicContent("reviews-gallery")
      .then((data) => setReviews(Array.isArray(data) ? data : []))
      .catch((error) => {
        console.error(error);
        setReviews([]);
      });
  }, []);

  const isLoading = reviews === null;
  const placeholderCount = 18;
  const reviewItems = isLoading
    ? Array.from({ length: placeholderCount }, (_, index) => ({
        __placeholder: true,
        key: `placeholder-${index}`,
      }))
    : Array.isArray(reviews)
    ? [...localDiscordReviews, ...reviews]
    : [];

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
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-info-text drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
          Community Reviews
        </h1>
        <p className="mt-5 text-ink-secondary text-base sm:text-lg leading-relaxed">
          Real feedback from clients who booked optimization sessions with Roo
          Industries, including FPS gains, frametime improvements, and
          day-to-day smoothness results.
        </p>
        <p className="mt-3 text-accent text-sm sm:text-base font-semibold">
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
                <div className="w-full rounded-xl border border-line-soft bg-skeleton shadow-lg aspect-[4/5] animate-pulse" />
              </div>
            );
          }

          const reviewAlt = rev.alt || "Client review screenshot";
          const reviewDims = rev.image?.dimensions || {
            width: rev.width,
            height: rev.height,
          };
          const reviewSrc = rev.src
            ? rev.src
            : rev.image
            ? buildReviewImageUrl(rev.image, 800)
            : "";
          const reviewSrcSet =
            !rev.src && rev.image
              ? buildReviewImageSrcSet(rev.image)
              : undefined;
          const reviewZoomSrc = rev.src
            ? rev.src
            : rev.image
            ? urlFor(rev.image).url()
            : reviewSrc;

          return (
            <div
              key={i}
              className="break-inside-avoid overflow-hidden rounded-xl"
            >
              {/* SEO/CLS: wrap each review image with a semantic figure/caption and intrinsic size. */}
              <figure className="m-0">
                <button
                  type="button"
                  aria-label={`Open ${reviewAlt}`}
                  className="group block w-full rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--color-canvas-deep)]"
                  onClick={() =>
                    handleOpenZoom(reviewZoomSrc, reviewAlt)
                  }
                >
                  <img
                    src={reviewSrc}
                    srcSet={reviewSrcSet}
                    alt={reviewAlt}
                    width={reviewDims?.width}
                    height={reviewDims?.height}
                    loading="lazy"
                    decoding="async"
                    fetchPriority="auto"
                    sizes="(max-width: 1023px) 90vw, 46vw"
                    className="w-full h-auto rounded-xl cursor-pointer shadow-lg group-hover:shadow-cyan-400/30 transition duration-300 object-contain"
                  />
                </button>
                <figcaption className="sr-only">{reviewAlt}</figcaption>
              </figure>
            </div>
          );
        })}
      </div>


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
