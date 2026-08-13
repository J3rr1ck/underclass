#!/usr/bin/env bash
set -e

NDK_DIR="/opt/android-sdk/ndk/28.2.13676358/toolchains/llvm/prebuilt/linux-x86_64/bin"
if [ ! -d "$NDK_DIR" ]; then
  echo "Android NDK directory not found at $NDK_DIR"
  exit 1
fi

export CC_aarch64_linux_android="$NDK_DIR/aarch64-linux-android24-clang"
export AR_aarch64_linux_android="$NDK_DIR/llvm-ar"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$NDK_DIR/aarch64-linux-android24-clang"

export CC_x86_64_linux_android="$NDK_DIR/x86_64-linux-android24-clang"
export AR_x86_64_linux_android="$NDK_DIR/llvm-ar"
export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER="$NDK_DIR/x86_64-linux-android24-clang"

echo "=== 1. Building Native Android ARM64 Executables ==="
cargo build --target aarch64-linux-android --release

echo "=== 2. Building Native Android x86_64 Executables ==="
cargo build --target x86_64-linux-android --release

echo "=== 3. Packaging Native Android Binaries into dist/android ==="
mkdir -p dist/android/arm64 dist/android/x86_64
cp target/aarch64-linux-android/release/under dist/android/arm64/under
cp target/aarch64-linux-android/release/danger dist/android/arm64/danger
cp target/x86_64-linux-android/release/under dist/android/x86_64/under
cp target/x86_64-linux-android/release/danger dist/android/x86_64/danger

chmod +x dist/android/arm64/* dist/android/x86_64/*
echo "Native Android Binaries successfully packaged:"
file dist/android/arm64/* dist/android/x86_64/*
