#!/usr/bin/env bash
# Build whisper-server from whisper.cpp (native CUDA if nvcc is installed, otherwise Vulkan + CPU).
# Speech models are chosen and downloaded by the user inside VoxBox (Settings -> Speech Models).
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CUDA_ARCH="${VOXBOX_CUDA_ARCH:-native}"

mkdir -p "$PROJECT_DIR/bin"

if [ ! -d "$PROJECT_DIR/whisper.cpp" ]; then
    git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$PROJECT_DIR/whisper.cpp"
fi

CMAKE_ARGS=(-G Ninja -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF -DBUILD_SHARED_LIBS=OFF)
if [ -x /usr/local/cuda/bin/nvcc ] && [ "${VOXBOX_BACKEND:-auto}" != "vulkan" ]; then
    CMAKE_ARGS+=(-DGGML_CUDA=1 -DCMAKE_CUDA_COMPILER=/usr/local/cuda/bin/nvcc "-DCMAKE_CUDA_ARCHITECTURES=$CUDA_ARCH")
    echo "Building whisper-server with CUDA (/usr/local/cuda/bin/nvcc, arch=$CUDA_ARCH)..."
elif command -v glslc >/dev/null 2>&1; then
    CMAKE_ARGS+=(-DGGML_VULKAN=1 -DGGML_NATIVE=OFF)
    echo "Building portable whisper-server with Vulkan + CPU..."
else
    CMAKE_ARGS+=(-DGGML_NATIVE=OFF)
    echo "Building CPU whisper-server..."
fi

cmake -S "$PROJECT_DIR/whisper.cpp" -B "$PROJECT_DIR/whisper.cpp/build" "${CMAKE_ARGS[@]}"
cmake --build "$PROJECT_DIR/whisper.cpp/build" --target whisper-server -j"$(nproc)"
cp -f "$PROJECT_DIR/whisper.cpp/build/bin/whisper-server" "$PROJECT_DIR/bin/whisper-server"
chmod +x "$PROJECT_DIR/bin/whisper-server"

echo "Done! Binary: $PROJECT_DIR/bin/whisper-server"
echo "Launch VoxBox and choose your preferred Whisper model in Settings -> Speech Models."
