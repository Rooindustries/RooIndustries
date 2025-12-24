import React, { useState, useEffect } from "react";
import { client, urlFor } from "../sanityClient";
import ImageZoomModal from "./ImageZoomModal";
import {
  getPreloadedState,
  isReactSnap,
  setSnapState,
} from "../utils/prerenderState";

export default function Reviews() {
  const [selectedImage, setSelectedImage] = useState(null);
  const [selectedAlt, setSelectedAlt] = useState("");
  const [preloaded] = useState(() => getPreloadedState("reviews.list"));
  const hasPreloaded = typeof preloaded !== "undefined";
  const [reviews, setReviews] = useState(() => preloaded ?? []);

  useEffect(() => {
    if (hasPreloaded) return; // react-snap preloaded this content.
    client
      .fetch(
        `*[_type == "review"] | order(_createdAt asc){
          image{
            ...,
            "dimensions": asset->metadata.dimensions
          },
          alt
        }`
      )
      .then((data) => {
        setReviews(data);
        if (isReactSnap()) {
          setSnapState("reviews.list", data);
        }
      })
      .catch(console.error);
  }, [hasPreloaded]);

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
      <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-center text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)] mb-12">
        Community Reviews
      </h1>

      <div className="columns-1 sm:columns-2 lg:columns-3 gap-4 space-y-4">
        {reviews.map((rev, i) => {
          const reviewAlt = rev.alt || "Client review screenshot";
          const reviewDims = rev.image?.dimensions;

          return (
            <div
              key={i}
              className="break-inside-avoid overflow-hidden rounded-xl"
            >
              {/* SEO/CLS: wrap each review image with a semantic figure/caption and intrinsic size. */}
              <figure className="m-0">
                <img
                  src={urlFor(rev.image).url()}
                  alt={reviewAlt}
                  width={reviewDims?.width}
                  height={reviewDims?.height}
                  loading="lazy"
                  decoding="async"
                  className="w-full h-auto rounded-xl cursor-pointer shadow-lg hover:shadow-cyan-400/30 transition duration-300 object-contain"
                  onClick={() =>
                    handleOpenZoom(urlFor(rev.image).url(), reviewAlt)
                  }
                />
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
