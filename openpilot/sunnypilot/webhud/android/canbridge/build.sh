#!/bin/sh
# Build the receive-only CAN helper for Pulse (arm64 Android). Needs the Go toolchain only.
# The output is shipped as a .so so Android installs it into the app's nativeLibraryDir, the one
# directory an app may exec from; it is a plain executable, not a shared library.
set -e
cd "$(dirname "$0")"
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-s -w" \
  -o ../app/src/main/jniLibs/arm64-v8a/libcanbridge.so main.go
echo "built app/src/main/jniLibs/arm64-v8a/libcanbridge.so"
