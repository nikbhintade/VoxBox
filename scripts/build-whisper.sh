#!/usr/bin/env bash
# Build CUDA-accelerated whisper-server from whisper.cpp and download large-v3-turbo-q8_0.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/voxbox/models"
MODEL_NAME="${VOXBOX_MODEL:-ggml-large-v3-turbo-q8_0.bin}"
CUDA_ARCH="${VOXBOX_CUDA_ARCH:-native}"

mkdir -p "$PROJECT_DIR/bin" "$MODEL_DIR"

if [ ! -d "$PROJECT_DIR/whisper.cpp" ]; then
    git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$PROJECT_DIR/whisper.cpp"
fi

CMAKE_ARGS=(-G Ninja -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF -DBUILD_SHARED_LIBS=OFF)
if [ -x /usr/local/cuda/bin/nvcc ]; then
    CMAKE_ARGS+=(-DGGML_CUDA=1 -DCMAKE_CUDA_COMPILER=/usr/local/cuda/bin/nvcc "-DCMAKE_CUDA_ARCHITECTURES=$CUDA_ARCH")
    echo "Building whisper-server with CUDA (/usr/local/cuda/bin/nvcc, arch=$CUDA_ARCH)..."
else
    echo "CUDA toolkit not found at /usr/local/cuda/bin/nvcc; building CPU whisper-server..."
fi

cmake -S "$PROJECT_DIR/whisper.cpp" -B "$PROJECT_DIR/whisper.cpp/build" "${CMAKE_ARGS[@]}"
cmake --build "$PROJECT_DIR/whisper.cpp/build" --target whisper-server -j"$(nproc)"
cp -f "$PROJECT_DIR/whisper.cpp/build/bin/whisper-server" "$PROJECT_DIR/bin/whisper-server"
chmod +x "$PROJECT_DIR/bin/whisper-server"

if [ ! -f "$MODEL_DIR/$MODEL_NAME" ]; then
    echo "Downloading Whisper model: $MODEL_NAME..."
    curl -fL -C - "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_NAME" -o "$MODEL_DIR/$MODEL_NAME"
fi

echo "Done! Binary: $PROJECT_DIR/bin/whisper-server | Model: $MODEL_DIR/$MODEL_NAME"
