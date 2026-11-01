#!/bin/bash
# LLM Icarus installer for macOS.
#
# Double-click this file (or run `bash "Install LLM Icarus.command"` in Terminal).
# It installs for your user only (no admin password), assembles the app on this Mac, and offers to
# download the parts that make it work. Nothing is installed outside your home folder.
#
# Options (for scripting/testing):
#   --yes             accept the recommended parts without asking
#   --minimal         install the app only, download nothing
#   --parts a,b,c     choose parts: engine,whisper,whispermodel,image,starter,starter-small,sdxl
#   --no-open         don't offer to open the app at the end

# (bash 3.2 compatible: this is the version macOS ships)
set -u
cd "$(dirname "$0")" || exit 1
HERE="$(pwd)"
NODE_VERSION="v24.19.0"

SUPPORT="$HOME/Library/Application Support/LLM Icarus"
APP_DIR="$SUPPORT/app"
DATA_DIR="$SUPPORT/data"
BUNDLE="$HOME/Applications/LLM Icarus.app"

MODE=ask   # ask | yes | minimal | parts
PARTS=""
OPEN=1
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) MODE=yes ;;
    --minimal) MODE=minimal ;;
    --parts) MODE=parts; PARTS="${2:-}"; shift ;;
    --no-open) OPEN=0 ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
  shift
done

say() { printf '\n== %s\n' "$1"; }
die() { printf '\nERROR: %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS."
[ -d "$HERE/app/server" ] || die "The 'app' folder next to this installer is missing. Unzip the whole download first."

MACHINE="$(uname -m)"           # arm64 (Apple Silicon) or x86_64 (Intel)
case "$MACHINE" in
  arm64) NODE_ARCH="arm64" ;;
  x86_64) NODE_ARCH="x64" ;;
  *) die "Unsupported processor: $MACHINE" ;;
esac
MEM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
MACOS="$(sw_vers -productVersion 2>/dev/null)"

cat <<EOF

  LLM Icarus - installer for macOS
  ---------------------------------
  This Mac: macOS $MACOS, $MACHINE, ${MEM_GB} GB memory
  Installs to: $SUPPORT
  App:         $BUNDLE
EOF

# ---- choose parts ----------------------------------------------------------

yn() { # yn "question" default(Y|N)  -> returns 0 for yes
  local q="$1" def="$2" hint ans
  if [ "$def" = "Y" ]; then hint="Y/n"; else hint="y/N"; fi
  if [ -r /dev/tty ]; then
    read -r -p "  $q [$hint] " ans </dev/tty
  else
    ans=""
  fi
  ans="$(printf '%s' "$ans" | tr '[:upper:]' '[:lower:]')"
  [ -z "$ans" ] && ans="$(printf '%s' "$def" | tr '[:upper:]' '[:lower:]')"
  [ "$ans" = "y" ] || [ "$ans" = "yes" ]
}

want_engine=0; want_whisper=0; want_whispermodel=0; want_image=0; want_starter=0; want_small=0; want_sdxl=0

# recommended defaults depend on the Mac
rec_image=0; [ "$MACHINE" = "arm64" ] && [ "$MEM_GB" -ge 16 ] && rec_image=1
rec_starter=0; rec_small=0
if [ "$MEM_GB" -ge 16 ]; then rec_starter=1; else rec_small=1; fi

case "$MODE" in
  yes)
    want_engine=1; want_whisper=1; want_image=$rec_image; want_starter=$rec_starter; want_small=$rec_small ;;
  minimal) ;;
  parts)
    for p in $(printf '%s' "$PARTS" | tr ',' ' '); do
      case "$p" in
        engine) want_engine=1 ;; whisper) want_whisper=1 ;; whispermodel) want_whispermodel=1 ;;
        image) want_image=1 ;; starter) want_starter=1 ;; starter-small) want_small=1 ;; sdxl) want_sdxl=1 ;;
        *) die "Unknown part: $p" ;;
      esac
    done ;;
  ask)
    echo
    echo "  Choose what to download now. (Press Enter to accept the suggestion in brackets.)"
    echo "  You can skip any of these and add them later with 'Download components.command'."
    echo
    yn "Chat and Code engine (llama.cpp, with Apple GPU support), about 20 MB?" Y && want_engine=1
    yn "Transcribe: private Python + Whisper (runs on the CPU), about 0.5 GB?" Y && want_whisper=1
    yn "   Also download the Whisper speech model now (about 1.6 GB)?" N && want_whispermodel=1
    if [ "$MACHINE" = "arm64" ]; then
      if [ "$MEM_GB" -lt 16 ]; then echo "  (Image generation works best with 16 GB or more memory; this Mac has $MEM_GB GB.)"; fi
      if [ "$rec_image" = 1 ]; then d=Y; else d=N; fi
      yn "Image generation: PyTorch + diffusers (Apple GPU), about 2 GB?" $d && want_image=1
    else
      echo "  (Image generation needs an Apple Silicon Mac; skipped on this Intel Mac.)"
    fi
    if [ "$MEM_GB" -ge 16 ]; then
      yn "Starter chat/code model: Qwen3-8B, about 5 GB?" Y && want_starter=1
    else
      yn "Starter chat/code model: Qwen3-4B (fits 8 GB Macs), about 2.5 GB?" Y && want_small=1
    fi
    if [ "$want_image" = 1 ]; then yn "   Also download the SDXL base image model (about 7 GB)?" N && want_sdxl=1; fi
    ;;
esac

SETUP_ARGS=""
[ "$want_engine" = 1 ] && SETUP_ARGS="$SETUP_ARGS --engine"
[ "$want_whisper" = 1 ] && SETUP_ARGS="$SETUP_ARGS --whisper"
[ "$want_whispermodel" = 1 ] && SETUP_ARGS="$SETUP_ARGS --whisper-model"
[ "$want_image" = 1 ] && SETUP_ARGS="$SETUP_ARGS --image"
[ "$want_starter" = 1 ] && SETUP_ARGS="$SETUP_ARGS --starter-model"
[ "$want_small" = 1 ] && SETUP_ARGS="$SETUP_ARGS --starter-small"
[ "$want_sdxl" = 1 ] && SETUP_ARGS="$SETUP_ARGS --sdxl-model"

# ---- install the app files -------------------------------------------------

say "Copying LLM Icarus to $APP_DIR"
mkdir -p "$SUPPORT" "$DATA_DIR" || die "Could not create $SUPPORT"
# keep the bundled Node between updates; replace everything else
if [ -d "$APP_DIR/runtime" ]; then mv "$APP_DIR/runtime" "$SUPPORT/.runtime-keep"; fi
rm -rf "$APP_DIR"
cp -R "$HERE/app" "$APP_DIR" || die "Copy failed"
if [ -d "$SUPPORT/.runtime-keep" ]; then mv "$SUPPORT/.runtime-keep" "$APP_DIR/runtime"; fi
chmod +x "$APP_DIR/start.sh" "$APP_DIR/stop.sh" 2>/dev/null

# ---- Node.js (private copy, checked against nodejs.org's published checksum) --

if [ ! -x "$APP_DIR/runtime/bin/node" ] || [ "$("$APP_DIR/runtime/bin/node" -v 2>/dev/null)" != "$NODE_VERSION" ]; then
  say "Downloading Node.js $NODE_VERSION ($NODE_ARCH)"
  TMP="$(mktemp -d)"
  TARBALL="node-$NODE_VERSION-darwin-$NODE_ARCH.tar.gz"
  curl -fL --progress-bar -o "$TMP/$TARBALL" "https://nodejs.org/dist/$NODE_VERSION/$TARBALL" || die "Could not download Node.js. Check your internet connection and try again."
  curl -fsSL -o "$TMP/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" || die "Could not download the Node.js checksum file."
  EXPECTED="$(grep " $TARBALL\$" "$TMP/SHASUMS256.txt" | awk '{print $1}')"
  ACTUAL="$(shasum -a 256 "$TMP/$TARBALL" | awk '{print $1}')"
  [ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || die "Node.js download failed its checksum check; not installing it."
  rm -rf "$APP_DIR/runtime"; mkdir -p "$APP_DIR/runtime"
  tar -xzf "$TMP/$TARBALL" -C "$APP_DIR/runtime" --strip-components=1 || die "Could not unpack Node.js"
  rm -rf "$TMP"
fi
echo "  Node $("$APP_DIR/runtime/bin/node" -v) ready."

# ---- the app bundle (Dock icon + launcher) ---------------------------------

say "Creating $BUNDLE"
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
cat >"$BUNDLE/Contents/MacOS/launcher" <<'LAUNCH'
#!/bin/bash
exec "$HOME/Library/Application Support/LLM Icarus/app/start.sh" "$@"
LAUNCH
chmod +x "$BUNDLE/Contents/MacOS/launcher"

cat >"$BUNDLE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>LLM Icarus</string>
  <key>CFBundleDisplayName</key><string>LLM Icarus</string>
  <key>CFBundleIdentifier</key><string>app.llmicarus.launcher</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>icarus</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
# show the real version (from package.json) instead of the placeholder above
APP_VERSION="$("$APP_DIR/runtime/bin/node" -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version" "$APP_DIR/package.json" 2>/dev/null)" || APP_VERSION=""
[ -n "$APP_VERSION" ] && sed -i '' "s|<string>0.1.0</string>|<string>$APP_VERSION</string>|" "$BUNDLE/Contents/Info.plist"

# icon: build an .icns from the logo with the tools macOS ships (sips + iconutil)
ICONSET="$(mktemp -d)/icarus.iconset"
mkdir -p "$ICONSET"
LOGO="$APP_DIR/web/logo.png"
if [ -f "$LOGO" ]; then
  for s in 16 32 64 128 256 512; do sips -z $s $s "$LOGO" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null 2>&1; done
  cp "$ICONSET/icon_32x32.png"   "$ICONSET/icon_16x16@2x.png"
  cp "$ICONSET/icon_64x64.png"   "$ICONSET/icon_32x32@2x.png"
  cp "$ICONSET/icon_256x256.png" "$ICONSET/icon_128x128@2x.png"
  cp "$ICONSET/icon_512x512.png" "$ICONSET/icon_256x256@2x.png"
  rm -f "$ICONSET/icon_64x64.png"
  iconutil -c icns "$ICONSET" -o "$BUNDLE/Contents/Resources/icarus.icns" 2>/dev/null || echo "  (could not build the icon; the app will use a plain one)"
fi
rm -rf "$(dirname "$ICONSET")"

# files copied from a downloaded zip carry a "downloaded from the internet" flag; clear it
xattr -cr "$APP_DIR" "$BUNDLE" 2>/dev/null
touch "$BUNDLE"

# ---- helper scripts --------------------------------------------------------

cat >"$SUPPORT/Download components.command" <<'DL'
#!/bin/bash
# Asks about each downloadable part (engine, Whisper, image tools, models) and downloads what you pick.
SUPPORT="$HOME/Library/Application Support/LLM Icarus"
CLUI_DATA_DIR="$SUPPORT/data" "$SUPPORT/app/runtime/bin/node" "$SUPPORT/app/server/setup.js" --interactive
echo; read -r -p "Press Enter to close. " _
DL
chmod +x "$SUPPORT/Download components.command"
cp "$HERE/Uninstall LLM Icarus.command" "$SUPPORT/Uninstall LLM Icarus.command" 2>/dev/null && chmod +x "$SUPPORT/Uninstall LLM Icarus.command"

# ---- downloads -------------------------------------------------------------

if [ -n "$SETUP_ARGS" ]; then
  say "Downloading the parts you chose"
  CLUI_DATA_DIR="$DATA_DIR" "$APP_DIR/runtime/bin/node" "$APP_DIR/server/setup.js" $SETUP_ARGS
  SETUP_RC=$?
else
  echo; echo "  No downloads selected. Use 'Download components.command' in:"; echo "  $SUPPORT"
  SETUP_RC=0
fi

say "Done"
echo "  Open LLM Icarus from: $BUNDLE"
echo "  (Tip: drag it into the Dock. More helpers are in: $SUPPORT)"
[ "$SETUP_RC" = 0 ] || echo "  Some downloads failed; run 'Download components.command' to retry."
if [ "$OPEN" = 1 ] && [ "$MODE" = ask ]; then
  yn "Open LLM Icarus now?" Y && open "$BUNDLE"
fi
exit 0
