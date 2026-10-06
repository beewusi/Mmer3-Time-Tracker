#!/bin/sh
# Builds the Mac Wi-Fi check into mac-helper/Mmer3Wifi.app (needs a Mac with
# the developer command line tools). Works on both Apple and Intel Macs.
set -e
cd "$(dirname "$0")"
APP=Mmer3Wifi.app
rm -rf "$APP" arm64 x86_64
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"
for ARCH in arm64 x86_64; do
  swiftc -O -target "$ARCH-apple-macos11" -o "$ARCH" main.swift \
    -framework AppKit -framework CoreLocation -framework CoreWLAN
done
lipo -create -output "$APP/Contents/MacOS/mmer3-wifi" arm64 x86_64
rm -f arm64 x86_64
codesign --force --sign - "$APP"
echo "Built $APP"
