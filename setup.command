#!/bin/bash
#
#  Naifu — one-time developer setup (macOS). Mirrors setup.ps1.
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

BUNDLE_ID="com.naifu.panel"
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_ROOT="$HOME/Library/Application Support/Adobe/CEP/extensions"
LINK_PATH="$EXT_ROOT/$BUNDLE_ID"
BIN_DIR="$SOURCE_DIR/bin"
FFMPEG="$BIN_DIR/ffmpeg"
CSXS_VERSIONS="9 10 11 12"   # Premiere 2025 uses CEP 11/12; set a range for older too

# Match the build to the CPU. Apple Silicon needs a native arm64 ffmpeg —
# evermeet.cx is Intel-only and says it won't ship ARM, so an Intel build there
# would only run if Rosetta 2 happens to be installed. martin-riedl.de publishes
# both and keeps a stable "latest" redirect.
case "$(uname -m)" in
  arm64)  FF_ARCH="arm64" ;;
  *)      FF_ARCH="amd64" ;;
esac
FFMPEG_URL="https://ffmpeg.martin-riedl.de/redirect/latest/macos/$FF_ARCH/release/ffmpeg.zip"
FFPROBE_URL="https://ffmpeg.martin-riedl.de/redirect/latest/macos/$FF_ARCH/release/ffprobe.zip"

# macOS blocks unsigned/quarantined binaries — hard-kills them on Apple Silicon.
# Clearing the quarantine flag and ad-hoc signing makes a downloaded or
# hand-placed binary runnable. Safe to run on anything; failures are ignored.
unquarantine() {
  [ -e "$1" ] || return 0
  xattr -cr "$1" 2>/dev/null || true
  codesign -s - -f "$1" 2>/dev/null || true
}

set_debug() {
  for v in $CSXS_VERSIONS; do
    defaults write "com.adobe.CSXS.$v" PlayerDebugMode -string "$1" 2>/dev/null || true
    echo "  CSXS.$v PlayerDebugMode = $1"
  done
  killall cfprefsd 2>/dev/null || true   # force the preference cache to reload
}

if [ "$1" = "--uninstall" ]; then
  echo "Uninstalling Naifu developer setup..."
  if [ -L "$LINK_PATH" ]; then rm "$LINK_PATH"; echo "  Removed link: $LINK_PATH"; else echo "  No link found."; fi
  set_debug 0
  echo "Done. Restart Premiere Pro to apply."
  exit 0
fi

echo "Installing Naifu developer setup (macOS)..."

echo "Enabling CEP debug mode..."
set_debug 1

echo "Linking panel into Premiere's extensions folder..."
mkdir -p "$EXT_ROOT"
[ -L "$LINK_PATH" ] && rm "$LINK_PATH"
ln -s "$SOURCE_DIR" "$LINK_PATH"
echo "  Linked: $LINK_PATH -> $SOURCE_DIR"

echo "Setting up FFmpeg ($FF_ARCH)..."
if [ -x "$FFMPEG" ]; then
  echo "  FFmpeg already present, skipping."
else
  mkdir -p "$BIN_DIR"
  TMP="$(mktemp -d)"
  echo "  Downloading macOS FFmpeg for $FF_ARCH (~30 MB)..."
  curl -L --fail -o "$TMP/ffmpeg.zip" "$FFMPEG_URL"
  unzip -o -q "$TMP/ffmpeg.zip" -d "$TMP"
  FOUND="$(find "$TMP" -name ffmpeg -type f | head -1)"
  [ -n "$FOUND" ] || { echo "  Could not find ffmpeg in the archive."; exit 1; }
  cp "$FOUND" "$FFMPEG"; chmod +x "$FFMPEG"; unquarantine "$FFMPEG"
  if curl -L --fail -o "$TMP/ffprobe.zip" "$FFPROBE_URL" 2>/dev/null; then
    unzip -o -q "$TMP/ffprobe.zip" -d "$TMP" || true
    PROBE="$(find "$TMP" -name ffprobe -type f | head -1)"
    if [ -n "$PROBE" ]; then
      cp "$PROBE" "$BIN_DIR/ffprobe"; chmod +x "$BIN_DIR/ffprobe"; unquarantine "$BIN_DIR/ffprobe"
    fi
  fi
  rm -rf "$TMP"
  echo "  FFmpeg installed to bin/ffmpeg"
fi

# Any Whisper / Ollama binaries the user dropped in by hand carry the same
# Gatekeeper problem — clear them too so they aren't killed on first run.
for B in "$BIN_DIR/Faster-Whisper-XXL/whisper-faster" "$BIN_DIR/ollama/ollama"; do
  if [ -e "$B" ]; then chmod +x "$B" 2>/dev/null || true; unquarantine "$B"; echo "  Cleared Gatekeeper flags on $(basename "$B")"; fi
done

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
      Window menu -> Extensions -> Naifu.
NOTE

echo ""
echo "Done!"
