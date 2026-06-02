#!/usr/bin/env bash
#
# regen-demo.sh — rebuild the README demo media from the source MP4.
#
# The README AUTOPLAYS the GIF (GitHub never autoplays MP4, and won't even
# render a relative-path <video>). The MP4 is only the "watch in HD" link.
# So after you replace docs/slidesmith-demo.mp4, you MUST regenerate the GIF
# for the autoplaying preview to change.
#
# Produces:
#   docs/slidesmith-demo.gif  — autoplaying README loop (keep it under ~10 MB
#                               or GitHub won't animate it)
#   docs/overview.png         — top hero still (editor in action)
#   docs/poster.png           — clean title still
#
# Requirements: ffmpeg. If it's not on PATH, this script falls back to the
# binary bundled with the Python `imageio-ffmpeg` package
# (pip install imageio-ffmpeg).
#
# Usage:
#   1) Replace docs/slidesmith-demo.mp4 with your new clip.
#   2) bash docs/regen-demo.sh           # uses defaults below
#      bash docs/regen-demo.sh 26 16     # custom highlight: start=26s len=16s
#   3) git add docs/slidesmith-demo.gif docs/slidesmith-demo.mp4 \
#             docs/overview.png docs/poster.png
#      git commit -m "docs: update demo" && git push
#
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

MP4="docs/slidesmith-demo.mp4"

# --- Tunables (override via args) -------------------------------------------
HL_START="${1:-26}"   # highlight start time (seconds) within the MP4
HL_LEN="${2:-16}"     # highlight duration (seconds)
GIF_W=800             # GIF width  (lower this if the GIF exceeds ~10 MB)
GIF_FPS=10            # GIF fps    (lower this too if needed)
OVERVIEW_AT=33        # timestamp for the top hero still
POSTER_AT=12          # timestamp for the clean title still
# ----------------------------------------------------------------------------

# Locate ffmpeg: prefer system, else the imageio-ffmpeg bundled binary.
if command -v ffmpeg >/dev/null 2>&1; then
  FF="ffmpeg"
else
  FF="$(python -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())' 2>/dev/null || true)"
  if [ -z "${FF:-}" ]; then
    echo "ERROR: ffmpeg not found. Install it, or: pip install imageio-ffmpeg" >&2
    exit 1
  fi
fi

if [ ! -f "$MP4" ]; then
  echo "ERROR: $MP4 not found. Put your source clip there first." >&2
  exit 1
fi

echo ">> Using ffmpeg: $FF"
echo ">> Highlight: start=${HL_START}s len=${HL_LEN}s  gif=${GIF_W}w@${GIF_FPS}fps"

# 1) Autoplaying GIF (palette-based for quality, single-pass via filtergraph).
"$FF" -hide_banner -loglevel error -y -ss "$HL_START" -t "$HL_LEN" -i "$MP4" \
  -vf "fps=${GIF_FPS},scale=${GIF_W}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5" \
  docs/slidesmith-demo.gif

# 2) Stills.
"$FF" -hide_banner -loglevel error -y -ss "$OVERVIEW_AT" -i "$MP4" \
  -frames:v 1 -vf "scale=1600:-2:flags=lanczos" docs/overview.png
"$FF" -hide_banner -loglevel error -y -ss "$POSTER_AT" -i "$MP4" \
  -frames:v 1 -vf "scale=1280:-2:flags=lanczos" docs/poster.png

# 3) Report sizes + the 10 MB guardrail.
gif_bytes=$(wc -c < docs/slidesmith-demo.gif)
gif_mb=$(awk "BEGIN{printf \"%.1f\", $gif_bytes/1048576}")
echo ">> docs/slidesmith-demo.gif = ${gif_mb} MB"
echo ">> docs/overview.png, docs/poster.png regenerated"
if [ "$gif_bytes" -gt 10485760 ]; then
  echo "!! WARNING: GIF is over 10 MB — GitHub may not animate it." >&2
  echo "!! Re-run with a shorter highlight or lower GIF_W/GIF_FPS, e.g.:" >&2
  echo "!!   bash docs/regen-demo.sh ${HL_START} 12   (and/or edit GIF_W/GIF_FPS)" >&2
fi
echo ">> Done."
