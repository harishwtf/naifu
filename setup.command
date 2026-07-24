#!/bin/bash
#
#  QuietCut — one-time developer setup (macOS). Mirrors setup.ps1.
#
#  It does three reversible things so Premiere loads our unsigned panel:
#    1. Turns on CEP "debug / unsigned extensions" mode.
#    2. Symlinks this project folder into Premiere's extensions folder.
#    3. Downloads a macOS FFmpeg build into bin/.
#
#  Run it:   bash setup.command          (or double-click in Finder)
#  Undo it:  bash setup.command --uninstall
#
set -e

BUNDLE_ID="com.quietcut.panel"
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_ROOT="$HOME/Library/Application Support/Adobe/CEP/extensions"
LINK_PATH="$EXT_ROOT/$BUNDLE_ID"
BIN_DIR="$SOURCE_DIR/bin"
FFMPEG="$BIN_DIR/ffmpeg"
FFMPEG_URL="https://evermeet.cx/ffmpeg/getrelease/zip"
FFPROBE_URL="https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip"
CSXS_VERSIONS="9 10 11 12"   # Premiere 2025 uses CEP 11/12; set a range for older too

set_debug() {
  for v in $CSXS_VERSIONS; do
    defaults write "com.adobe.CSXS.$v" PlayerDebugMode -string "$1" 2>/dev/null || true
    echo "  CSXS.$v PlayerDebugMode = $1"
  done
  killall cfprefsd 2>/dev/null || true   # force the preference cache to reload
}

if [ "$1" = "--uninstall" ]; then
  echo "Uninstalling QuietCut developer setup..."
  if [ -L "$LINK_PATH" ]; then rm "$LINK_PATH"; echo "  Removed link: $LINK_PATH"; else echo "  No link found."; fi
  set_debug 0
  echo "Done. Restart Premiere Pro to apply."
  exit 0
fi

echo "Installing QuietCut developer setup (macOS)..."

echo "Enabling CEP debug mode..."
set_debug 1

echo "Linking panel into Premiere's extensions folder..."
mkdir -p "$EXT_ROOT"
[ -L "$LINK_PATH" ] && rm "$LINK_PATH"
ln -s "$SOURCE_DIR" "$LINK_PATH"
echo "  Linked: $LINK_PATH -> $SOURCE_DIR"

echo "Setting up FFmpeg..."
if [ -x "$FFMPEG" ]; then
  echo "  FFmpeg already present, skipping."
else
  mkdir -p "$BIN_DIR"
  TMP="$(mktemp -d)"
  echo "  Downloading macOS FFmpeg (~40 MB)..."
  curl -L --fail -o "$TMP/ffmpeg.zip" "$FFMPEG_URL"
  unzip -o -q "$TMP/ffmpeg.zip" -d "$TMP"
  FOUND="$(find "$TMP" -name ffmpeg -type f | head -1)"
  [ -n "$FOUND" ] || { echo "  Could not find ffmpeg in the archive."; exit 1; }
  cp "$FOUND" "$FFMPEG"; chmod +x "$FFMPEG"
  if curl -L --fail -o "$TMP/ffprobe.zip" "$FFPROBE_URL" 2>/dev/null; then
    unzip -o -q "$TMP/ffprobe.zip" -d "$TMP" || true
    PROBE="$(find "$TMP" -name ffprobe -type f | head -1)"
    [ -n "$PROBE" ] && cp "$PROBE" "$BIN_DIR/ffprobe" && chmod +x "$BIN_DIR/ffprobe" || true
  fi
  rm -rf "$TMP"
  echo "  FFmpeg installed to bin/ffmpeg"
fi

cat <<NOTE

FFmpeg is ready. The AI features still need two engine BINARIES in bin/ (macOS builds);
the big model weights are NOT bundled — the panel downloads them on first use:
  * Whisper — a faster-whisper binary at:
        bin/Faster-Whisper-XXL/whisper-faster
      (or edit whisperPath() in js/main.js to point at your build; same CLI flags).
      Its speech model downloads itself the first time you transcribe.
  * Ollama  — just the macOS ollama binary at bin/ollama/ollama. The qwen language
      model (~4.7 GB) downloads automatically inside the panel the first time you run
      a local-AI feature — no manual pull needed.

Then: fully quit Premiere Pro, reopen a project with a sequence,
      Window menu -> Extensions -> QuietCut.
NOTE

echo ""
echo "Done!"
