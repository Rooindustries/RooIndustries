import React, { useState, useEffect, useRef } from "react";
import { Plus, Minus, X } from "lucide-react";

export default function ImageZoomModal({
  src,
  alt,
  onClose,
  setIsModalOpen = () => {},
}) {
  const [zoom, setZoom] = useState(1);
  const [targetOffset, setTargetOffset] = useState({ x: 0, y: 0 });
  const [currentOffset, setCurrentOffset] = useState({ x: 0, y: 0 });
  const [dragStart, setDragStart] = useState(null);
  const animationRef = useRef(null);

  useEffect(() => {
    const animate = () => {
      setCurrentOffset((prev) => ({
        x: prev.x + (targetOffset.x - prev.x) * 0.2,
        y: prev.y + (targetOffset.y - prev.y) * 0.2,
      }));
      animationRef.current = requestAnimationFrame(animate);
    };
    animationRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationRef.current);
  }, [targetOffset]);

  // Hide logo + disable scroll when open
  useEffect(() => {
    setIsModalOpen(true);
    document.body.classList.add("is-modal-open");
    document.body.style.overflow = "hidden";

    return () => {
      setIsModalOpen(false);
      document.body.classList.remove("is-modal-open");
      document.body.style.overflow = "auto";
    };
  }, [setIsModalOpen]);

  const handleZoomIn = (e) => {
    e.stopPropagation();
    setZoom((z) => Math.min(z + 0.12, 3));
  };

  const handleZoomOut = (e) => {
    e.stopPropagation();
    setZoom((z) => Math.max(z - 0.12, 1));
    if (zoom <= 1.12) {
      setTargetOffset({ x: 0, y: 0 });
      setCurrentOffset({ x: 0, y: 0 });
    }
  };

  const handleMouseDown = (e) => {
    if (zoom <= 1) return;
    e.preventDefault();
    e.stopPropagation();
    setDragStart({
      x: e.clientX - targetOffset.x,
      y: e.clientY - targetOffset.y,
    });
  };

  const handleMouseMove = (e) => {
    if (!dragStart || zoom <= 1) return;
    e.preventDefault();
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    setTargetOffset({ x: dx, y: dy });
  };

  // When mouse released
  const handleMouseUp = (e) => {
    e.preventDefault();
    setDragStart(null);
  };

  const handleClose = (e) => {
    e.stopPropagation();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-[9999]"
      onClick={handleClose}
    >
      {/* Close Button */}
      <button
        onClick={handleClose}
        className="fixed top-6 right-6 p-2 bg-slate-900/70 border border-sky-700/30 rounded-lg hover:bg-slate-800 transition z-[10001] flex items-center justify-center"
        title="Close"
      >
        <X className="w-4 h-4 text-cyan-300" />
      </button>

      {/* Image container */}
      <div
        className="relative flex items-center justify-center z-[10000] select-none"
        onClick={(e) => e.stopPropagation()}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <img
          src={src}
          alt={alt || "Zoomed image"}
          onMouseDown={handleMouseDown}
          className="rounded-lg shadow-lg select-none object-contain max-h-[85vh] w-auto transition-transform duration-75 ease-linear"
          style={{
            transform: `translate(${currentOffset.x / 1.2}px, ${
              currentOffset.y / 1.2
            }px) scale(${zoom})`,
            cursor: zoom > 1 ? (dragStart ? "grabbing" : "grab") : "default",
          }}
          draggable="false"
        />
      </div>

      <div
        className="fixed bottom-8 left-1/2 -translate-x-1/2 flex gap-4 z-[10002]"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={handleZoomOut}
          className="p-3 rounded-full bg-slate-900/90 border border-sky-600/40 hover:bg-slate-800 transition shadow-[0_0_10px_rgba(14,165,233,0.4)] flex items-center justify-center"
        >
          <Minus className="w-5 h-5 text-cyan-300" />
        </button>
        <button
          onClick={handleZoomIn}
          className="p-3 rounded-full bg-slate-900/90 border border-sky-600/40 hover:bg-slate-800 transition shadow-[0_0_10px_rgba(14,165,233,0.4)] flex items-center justify-center"
        >
          <Plus className="w-5 h-5 text-cyan-300" />
        </button>
      </div>
    </div>
  );
}
