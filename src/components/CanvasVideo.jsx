import React, { useRef, useEffect } from "react";

const CanvasVideo = ({ src, poster, className, onError, alt }) => {
  const wrapperRef = useRef(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;
    let animationFrameId;
    let isVisible = true;
    let posterImage = null;
    let posterReady = false;
    let posterDrawn = false;

    const drawPoster = () => {
      if (!posterImage || !posterReady || posterDrawn) return;
      const width = posterImage.naturalWidth || canvas.width;
      const height = posterImage.naturalHeight || canvas.height;
      if (width && height) {
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(posterImage, 0, 0, canvas.width, canvas.height);
        posterDrawn = true;
      }
    };

    if (poster) {
      posterImage = new Image();
      posterImage.decoding = "async";
      posterImage.src = poster;
      posterImage.onload = () => {
        posterReady = true;
        if (video.readyState < 2) {
          drawPoster();
        }
      };
    }

    const stopLoop = () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
    };

    const render = () => {
      if (document.hidden || !isVisible) {
        stopLoop();
        return;
      }

      if (video.readyState >= 2) {
        if (
          canvas.width !== video.videoWidth ||
          canvas.height !== video.videoHeight
        ) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      } else {
        drawPoster();
      }

      animationFrameId = requestAnimationFrame(render);
    };

    const startLoop = () => {
      if (animationFrameId || document.hidden || !isVisible) return;
      animationFrameId = requestAnimationFrame(render);
    };

    const startPlay = () => {
      video.play().catch(() => {});
      startLoop();
    };

    const handleVisibility = () => {
      if (document.hidden) {
        stopLoop();
        return;
      }
      startLoop();
    };

    let observer = null;
    if (typeof IntersectionObserver === "function" && wrapperRef.current) {
      observer = new IntersectionObserver(
        (entries) => {
          isVisible = entries[0]?.isIntersecting ?? true;
          if (isVisible) {
            startLoop();
          } else {
            stopLoop();
          }
        },
        { rootMargin: "180px 0px" }
      );
      observer.observe(wrapperRef.current);
    }

    video.addEventListener("loadeddata", startPlay);
    document.addEventListener("visibilitychange", handleVisibility);
    startLoop();

    return () => {
      stopLoop();
      video.removeEventListener("loadeddata", startPlay);
      document.removeEventListener("visibilitychange", handleVisibility);
      if (posterImage) {
        posterImage.onload = null;
      }
      if (observer) observer.disconnect();
    };
  }, [poster]);

  return (
    <div ref={wrapperRef} style={{ position: "relative", display: "inline-block" }}>
      {poster && alt ? (
        <img
          src={poster}
          alt={alt}
          className="sr-only"
          decoding="async"
          loading="eager"
        />
      ) : null}

      {/* HIDDEN VIDEO SOURCE */}
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        autoPlay
        loop
        muted
        playsInline
        onError={onError}
        aria-hidden="true"
        style={{
          position: "absolute",
          opacity: 0,
          pointerEvents: "none",
          zIndex: -1,
          width: "1px",
          height: "1px",
          overflow: "hidden",
        }}
      />

      {/* The Visible Canvas */}
      <canvas ref={canvasRef} className={className} aria-hidden="true" />
    </div>
  );
};

export default CanvasVideo;
