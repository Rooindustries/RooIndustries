import React, { useState } from "react";
import { Plus, Minus, X } from "lucide-react";

export default function ZoomableImage({ src, alt }) {
  const [isOpen, setIsOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragStart, setDragStart] = useState(null);

  const handleZoomIn = () => setZoom((z) => Math.min(z + 0.2, 3));
  const handleZoomOut = () => setZoom((z) => Math.max(z - 0.2, 1));

  const handleMouseDown = (e) => {
    if (zoom === 1) return;
    e.preventDefault();
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const handleMouseMove = (e) => {
    if (!dragStart || zoom === 1) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    setOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const handleMouseUp = () => setDragStart(null);
  const close = () => {
    setIsOpen(false);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  };

  return (
    <>
      {/* Thumbnail */}
      <img
        src={src}
        alt={alt || "Zoomable image"}
        className="cursor-pointer rounded-xl shadow-lg hover:shadow-cyan-400/30 transition duration-300"
        onClick={() => setIsOpen(true)}
      />

      {/* Modal */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50"
          onClick={close}
        >
          <div
            className="relative max-w-[70%] sm:max-w-[60%] max-h-[85vh] flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            {/* Controls */}
            <div className="absolute top-4 right-4 flex gap-2">
              <button
                onClick={handleZoomOut}
                className="p-2 rounded-full bg-slate-900/80 border border-sky-600/40 hover:bg-slate-800 transition"
              >
                <Minus className="w-5 h-5 text-cyan-300" />
              </button>
              <button
                onClick={handleZoomIn}
                className="p-2 rounded-full bg-slate-900/80 border border-sky-600/40 hover:bg-slate-800 transition"
              >
                <Plus className="w-5 h-5 text-cyan-300" />
              </button>
              <button
                onClick={close}
                className="p-2 rounded-full bg-slate-900/80 border border-sky-600/40 hover:bg-red-800 transition"
              >
                <X className="w-5 h-5 text-red-400" />
              </button>
            </div>

            {/* Image */}
            <img
              src={src}
              alt={alt || "Zoomed image"}
              onMouseDown={handleMouseDown}
              className="rounded-lg select-none object-contain max-h-[85vh] transition-transform duration-200"
              style={{
                transform: `translate(${offset.x / 1.5}px, ${
                  offset.y / 1.5
                }px) scale(${zoom})`,
                cursor:
                  zoom > 1 ? (dragStart ? "grabbing" : "grab") : "default",
              }}
              draggable="false"
            />
          </div>
        </div>
      )}
    </>
  );
}
