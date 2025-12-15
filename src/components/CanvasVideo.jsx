import React, { useRef, useEffect } from 'react';

const CanvasVideo = ({ src, poster, className, onError }) => {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { alpha: true });
    let animationFrameId;

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
    };
  }, []);

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      {/* THE FIX: We cannot use display: none. 
         Instead, we use opacity: 0 and z-index: -1.
         This forces the browser to keep rendering the frames.
      */}
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        autoPlay
        loop
        muted
        playsInline
        onError={onError}
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
      />
    </div>
  );
};

export default CanvasVideo;