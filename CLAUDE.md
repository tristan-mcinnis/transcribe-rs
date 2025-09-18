# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Building
```bash
# Build the library
cargo build

# Build with release optimizations
cargo build --release

# Build the realtime CLI helper (required for Electron app)
cargo build --bin realtime_cli

# Build with only Whisper support (no Parakeet/ONNX dependencies)
cargo build --no-default-features --features whisper
```

### Testing
```bash
# Run Rust tests (Whisper-only, avoids ONNX runtime in CI)
cargo test --no-default-features --features whisper

# Run all tests with both engines (requires Parakeet models)
cargo test

# Run a specific test
cargo test test_name

# Run Electron/JavaScript tests
cd electron && npm test
```

### Running Examples
```bash
# Run the transcription example
cargo run --example transcribe

# Run the realtime CLI directly
cargo run --bin realtime_cli -- --engine whisper --model-path models/whisper-medium-q4_1.bin
```

### Electron App Development
```bash
# Install dependencies (first time setup)
cd electron && npm install

# Start the Electron app
cd electron && npm start
```

## Architecture Overview

### Core Library Structure

The library provides a unified `TranscriptionEngine` trait that abstracts over different speech recognition backends:

- **`src/lib.rs`**: Defines the core `TranscriptionEngine` trait and common types (`TranscriptionResult`, `TranscriptionSegment`)
- **`src/engines/`**: Contains implementations for different transcription engines
  - `whisper.rs`: OpenAI Whisper implementation using whisper-rs
  - `parakeet/`: NVIDIA Parakeet implementation using ONNX Runtime
- **`src/audio.rs`**: WAV file reading and validation (16kHz, mono, 16-bit PCM required)
- **`src/realtime.rs`**: Message types for streaming transcription sessions

### Engine Architecture

Each engine implements the `TranscriptionEngine` trait with engine-specific parameters:
- `ModelParams`: Configuration for model loading (e.g., quantization settings)
- `InferenceParams`: Runtime transcription settings (e.g., language hints)

The Parakeet engine has a modular design:
- `model.rs`: ONNX model loading and management
- `timestamps.rs`: Greedy CTC decoding with timestamp extraction
- `engine.rs`: Main transcription logic

### Realtime Streaming Architecture

The realtime transcription system consists of:
1. **`realtime_cli` binary** (`src/bin/realtime_cli.rs`): Accepts audio chunks via stdin JSON messages, maintains a sliding window buffer, and outputs transcript updates
2. **Electron Shell** (`electron/`): Captures microphone audio, spawns the CLI helper, and displays live transcript + AI-generated notes
3. **Message Protocol**: JSON messages defined in `src/realtime.rs` for bidirectional communication

## Model Requirements

### Whisper Models
- Single GGML file format (e.g., `whisper-medium-q4_1.bin`)
- Hardware acceleration: Metal (macOS), Vulkan (Windows/Linux)

### Parakeet Models
Directory structure with ONNX models:
- `encoder-model.onnx` or `encoder-model.int8.onnx` (Int8 recommended for performance)
- `decoder_joint-model.onnx` or `decoder_joint-model.int8.onnx`
- `nemo128.onnx` (audio preprocessor)
- `vocab.txt` (vocabulary file)

## Key Implementation Details

- **Audio Buffer Management**: The realtime CLI maintains a 30-second sliding window of audio samples, transcribing every 3 seconds of new audio
- **Timestamp Extraction**: Parakeet uses a custom greedy CTC decoder to extract character-level timestamps from the model's probability outputs
- **Cross-Platform Support**: Conditional compilation for platform-specific optimizations (Metal on macOS, Vulkan on Windows)
- **Error Handling**: All engines use `Box<dyn std::error::Error>` for unified error propagation