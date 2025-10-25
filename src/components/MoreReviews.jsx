import React, { useState, useEffect } from "react";

export default function Reviews() {
  const [selectedImage, setSelectedImage] = useState(null);
  const [fadeIn, setFadeIn] = useState(false);
  const [isZoomed, setIsZoomed] = useState(false);
  const [zoomOrigin, setZoomOrigin] = useState({ x: "50%", y: "50%" });
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragStart, setDragStart] = useState(null);

  useEffect(() => setFadeIn(Boolean(selectedImage)), [selectedImage]);

  useEffect(() => {
    const handleKeyDown = (e) => e.key === "Escape" && setSelectedImage(null);
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

  const handleImageClick = (e) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setZoomOrigin({ x: `${x}%`, y: `${y}%` });
    setIsZoomed((z) => !z);
    if (!isZoomed) setOffset({ x: 0, y: 0 });
  };

  const handleMouseDown = (e) => {
    if (!isZoomed) return;
    e.preventDefault();
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const handleMouseMove = (e) => {
    if (!isZoomed || !dragStart) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    setOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const handleMouseUp = () => setDragStart(null);
  const handleClose = () => {
    setIsZoomed(false);
    setSelectedImage(null);
    setOffset({ x: 0, y: 0 });
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
            alt={name}
            className="w-full mb-4 cursor-pointer rounded-xl shadow-lg break-inside hover:shadow-cyan-400/30 transition duration-300"
            onClick={() => setSelectedImage(`/All_reviews/${name}.png`)}
          />
        ))}
      </div>

      {selectedImage && (
        <div
          className={`fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4 transition-opacity duration-300 ${
            fadeIn ? "opacity-100" : "opacity-0"
          }`}
          onClick={handleClose}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <img
            src={selectedImage}
            alt="Selected review"
            onClick={handleImageClick}
            onMouseDown={handleMouseDown}
            className={`rounded-lg shadow-lg select-none ${
              dragStart ? "" : "transition-transform duration-300"
            } w-[50%] sm:max-w-[90%] sm:max-h-[90%] max-w-none max-h-none`}
            style={{
              transformOrigin: `${zoomOrigin.x} ${zoomOrigin.y}`,
              transform: isZoomed
                ? `translate(${offset.x / 1.6}px, ${
                    offset.y / 1.6
                  }px) scale(1.6)`
                : "scale(1)",
              cursor: isZoomed ? (dragStart ? "grabbing" : "grab") : "zoom-in",
            }}
            draggable="false"
          />
        </div>
      )}
    </section>
  );
}
