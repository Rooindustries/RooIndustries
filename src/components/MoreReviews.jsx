import React, { useState, useEffect } from "react";
import { client, urlFor } from "../sanityClient";
import ImageZoomModal from "./ImageZoomModal";

export default function Reviews() {
  const [selectedImage, setSelectedImage] = useState(null);
  const [reviews, setReviews] = useState([]);

  useEffect(() => {
    client
      .fetch(`*[_type == "review"] | order(_createdAt asc){ image, alt }`)
      .then(setReviews)
      .catch(console.error);
  }, []);

  const handleClose = () => setSelectedImage(null);

  return (
    <section className="px-4 mt-20 py-12 max-w-7xl mx-auto">
      <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-center text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)] mb-12">
        Community Reviews
      </h1>

      <div className="columns-1 sm:columns-2 lg:columns-3 gap-4 space-y-4">
        {reviews.map((rev, i) => (
          <div
            key={i}
            className="break-inside-avoid overflow-hidden rounded-xl"
          >
            <img
              src={urlFor(rev.image).url()}
              alt={rev.alt || "Client Review"}
              className="w-full h-auto rounded-xl cursor-pointer shadow-lg hover:shadow-cyan-400/30 transition duration-300 object-contain"
              onClick={() => setSelectedImage(urlFor(rev.image).url())}
            />
          </div>
        ))}
      </div>

      {selectedImage && (
        <ImageZoomModal src={selectedImage} onClose={handleClose} />
      )}
    </section>
  );
}
