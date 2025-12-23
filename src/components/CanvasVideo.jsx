import React, { useRef, useEffect } from 'react';

const CanvasVideo = ({ src, poster, className, onError, alt }) => {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;
    let animationFrameId;
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

    const render = () => {
      // Check if video is ready to play
      if (video.readyState >= 2) {
        // Sync canvas size to video size once
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }
        
        // Draw the frame
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      } else {
        drawPoster();
      }
      
      animationFrameId = requestAnimationFrame(render);
    };

    // Ensure video plays even if browser tries to pause background videos
    const startPlay = () => {
      video.play().catch((e) => console.log("Autoplay prevented:", e));
    };

    video.addEventListener('loadeddata', startPlay);
    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
      video.removeEventListener('loadeddata', startPlay);
      if (posterImage) {
        posterImage.onload = null;
      }
    };
  }, [poster]);

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      {/* SEO: mirror the canvas-rendered video with a crawlable img fallback. */}
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
          position: 'absolute', 
          opacity: 0, 
          pointerEvents: 'none',
          zIndex: -1,
          width: '1px', 
          height: '1px',
          overflow: 'hidden'
        }} 
      />
      
      {/* The Visible Canvas */}
      <canvas
        ref={canvasRef}
        className={className}
        aria-hidden="true"
      />
    </div>
  );
};

export default CanvasVideo;