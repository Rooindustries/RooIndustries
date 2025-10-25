import React, { useState, useEffect } from "react";

export default function Reviews() {
  const [selectedImage, setSelectedImage] = useState(null);
  const [fadeIn, setFadeIn] = useState(false);
  const [isZoomed, setIsZoomed] = useState(false);
  const [zoomOrigin, setZoomOrigin] = useState({ x: "50%", y: "50%" });

  // fade in animation
  useEffect(() => {
    if (selectedImage) setFadeIn(true);
    else setFadeIn(false);
  }, [selectedImage]);

  // esc + scroll lock
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape") setSelectedImage(null);
    };

    if (selectedImage) {
      document.body.style.overflow = "hidden";
      document.body.classList.add("is-modal-open");
      window.addEventListener("keydown", handleKeyDown);
    } else {
      document.body.style.overflow = "auto";
      document.body.classList.remove("is-modal-open");
    }

    return () => {
      document.body.style.overflow = "auto";
      document.body.classList.remove("is-modal-open");
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedImage]);

  // handle zoom toggle
  const handleImageClick = (e) => {
    e.stopPropagation();
    const rect = e.target.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setZoomOrigin({ x: `${x}%`, y: `${y}%` });
    setIsZoomed((prev) => !prev);
  };

  const handleClose = () => {
    setIsZoomed(false);
    setSelectedImage(null);
  };

  return (
    <section className="px-4 mt-20 py-12 max-w-7xl mx-auto">
      <h1 className="text-3xl md:text-4xl font-bold mb-12 text-center text-white">
        Community Reviews
      </h1>

      <div className="columns-1 sm:columns-2 lg:columns-3 gap-4 space-y-4">
        {[
          "alexn",
          "aum",
          "bloomy",
          "borakan",
          "coerbii",
          "cosmiic",
          "cyerx",
          "dot",
          "easyclutch",
          "frost",
          "frost2",
          "fuga",
          "honf_mod",
          "jack",
          "jahamez",
          "jay4a1",
          "jayy",
          "junnsot",
          "justin",
          "jx",
          "ktag",
          "locked",
          "matthew",
          "mmrtzgr",
          "muzexx",
          "neuro",
          "prexys",
          "sexyboy",
          "steal",
          "stefan",
          "turkey",
          "ultimate",
          "yiwol",
          "zo_omless",
          "mfbuddy",
        ].map((name) => (
          <img
            key={name}
            src={`/All_reviews/${name}.png`}
            alt={`Review ${name}`}
            className="w-full mb-4 cursor-pointer rounded-xl shadow-lg break-inside hover:shadow-cyan-400/30 transition duration-300"
            onClick={() => setSelectedImage(`/All_reviews/${name}.png`)}
          />
        ))}
      </div>

      {/* modal */}
      {selectedImage && (
        <div
          className={`fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4 transition-opacity duration-300 ${
            fadeIn ? "opacity-100" : "opacity-0"
          }`}
          onClick={handleClose}
        >
          {/* wrapper prevents clicks near image from closing */}
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <img
              src={selectedImage}
              alt="Selected review"
              onClick={handleImageClick}
              className="rounded-lg shadow-lg object-contain transition-transform duration-300 
                         w-[95%] sm:max-w-[90%] sm:max-h-[90%] max-w-none max-h-none"
              style={{
                transformOrigin: `${zoomOrigin.x} ${zoomOrigin.y}`,
                transform: isZoomed ? "scale(1.6)" : "scale(1)",
                cursor: isZoomed ? "zoom-out" : "zoom-in",
              }}
            />
          </div>
        </div>
      )}
    </section>
  );
}
