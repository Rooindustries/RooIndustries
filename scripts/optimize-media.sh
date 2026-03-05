#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VIDEOS_DIR="$ROOT_DIR/public/videos"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required to optimize media files."
  exit 1
fi

optimize_video() {
  local input="$1"
  local output="$2"
  local bitrate="$3"

  ffmpeg -y -i "$input" \
    -c:v libx264 -profile:v high -preset medium -b:v "$bitrate" -maxrate "$bitrate" -bufsize "$bitrate" \
    -movflags +faststart -pix_fmt yuv420p \
    -c:a aac -b:a 128k \
    "$output"
}

optimize_video "$VIDEOS_DIR/discordvideo.mp4" "$VIDEOS_DIR/discordvideo.optimized.mp4" "2200k"
optimize_video "$VIDEOS_DIR/instructions.mp4" "$VIDEOS_DIR/instructions.optimized.mp4" "1800k"
optimize_video "$VIDEOS_DIR/tuning.mp4" "$VIDEOS_DIR/tuning.optimized.mp4" "2200k"
optimize_video "$VIDEOS_DIR/bios.mp4" "$VIDEOS_DIR/bios.optimized.mp4" "1800k"

echo "Optimized media files generated in $VIDEOS_DIR"
