# transcribe-rs

A realtime note-taking desktop app powered by AI transcription, featuring a Rust library for audio transcription with support for multiple engines including Whisper and Parakeet.

The Electron desktop app streams microphone audio through a Rust-based transcription engine, displays live transcripts, and uses OpenAI's `gpt-5-nano` model to generate chronological bullet notes while you speak. The underlying Rust library can also be used independently for integrating transcription capabilities into other applications.

This library was extracted from the [Handy](https://github.com/cjpais/handy) project to help other developers integrate transcription capabilities into their applications. We hope to support additional ASR models in the future and may expand to include features like microphone input and real-time transcription.

## Realtime Note Taking App

### Prerequisites

- Rust toolchain (for compiling the transcription engines and realtime CLI helper)
- Node.js 20+ (for the Electron desktop app)
- A supported transcription model downloaded locally (see [Quick Start](#quick-start) below)
- Optional: OpenAI API key for AI-generated notes (transcription works without it)

### Quick Start

1. **Clone and build the project:**
```bash
# Build the realtime CLI helper (required for Electron app)
cargo build --bin realtime_cli

# Install Electron dependencies
cd electron
npm install
cd ..
```

2. **Download a transcription model:**
```bash
# Create models directory
mkdir models

# Option A: Download Parakeet model (recommended for performance)
cd models
wget https://blob.handy.computer/parakeet-v3-int8.tar.gz
tar -xzf parakeet-v3-int8.tar.gz
rm parakeet-v3-int8.tar.gz
cd ..

# Option B: Download Whisper model (alternative)
cd models
wget https://blob.handy.computer/whisper-medium-q4_1.bin
cd ..
```

3. **Optional: Add OpenAI API key for note generation:**
```bash
# Create .env file in project root
echo "OPENAI_API_KEY=your-api-key-here" > .env
```

4. **Launch the desktop app:**
```bash
cd electron
npm start
```

### Using the Desktop App

The Electron app provides:

- **Model configuration:** Select either:
  - Parakeet: Choose the directory `models/parakeet-tdt-0.6b-v3-int8`
  - Whisper: Choose the file `models/whisper-medium-q4_1.bin`
- **Live transcript:** Real-time transcription of your speech
- **AI-generated notes:** Bullet-point summaries created by OpenAI (requires API key)
- **Language selection:** Optional language hint for better accuracy

Notes:
- On macOS, Metal acceleration is used automatically when available
- Without an OpenAI API key, transcription still works but notes won't be generated
- The app maintains a 30-second audio buffer for optimal transcription

For a deeper dive into turning the app into a full realtime meeting copilot with floating AI panes (notes, follow-ups, decisions, and more), see [`docs/realtime-pane-architecture.md`](docs/realtime-pane-architecture.md).

### CLI-Only Streaming

You can also use the realtime helper directly from the terminal if you prefer wiring it into another UI:

```bash
cargo run --bin realtime_cli -- \
  --engine whisper \
  --model-path models/whisper-medium-q4_1.bin
```

Send newline-delimited JSON messages through stdin in the shape `{ "type": "chunk", "samples": [f32, ...] }` and receive structured transcript updates on stdout.

### Testing

```bash
# Run Rust tests (Whisper-only to avoid ONNX dependencies in CI)
cargo test --no-default-features --features whisper

# Run Electron/JavaScript tests
cd electron
npm test

# Run all tests with both engines (requires Parakeet models)
cargo test
```

### Performance

**Parakeet int8 model benchmarks:**
- **30x real time** on MBP M4 Max
- **20x real time** on Zen 3 (5700X)
- **5x real time** on Skylake (i5-6500)
- **5x real time** on Jetson Nano CPU


## Rust Library Documentation

### Features

- **Multiple Transcription Engines**: Support for both Whisper and Parakeet models
- **Cross-platform**: Works on macOS, Windows, and Linux with optimized backends
- **Hardware Acceleration**: Metal on macOS, Vulkan on Windows/Linux
- **Flexible API**: Common interface for different transcription engines

### Model Requirements

**Parakeet Model Directory Structure:**
```
models/parakeet-tdt-0.6b-v3-int8/
├── encoder-model.int8.onnx      # Encoder model (quantized)
├── decoder_joint-model.int8.onnx # Decoder/joint model (quantized)
├── nemo128.onnx                 # Audio preprocessor
├── vocab.txt                    # Vocabulary file
```

**Whisper Model:**
- Single GGML file (e.g., `whisper-medium-q4_1.bin`)

**Audio Requirements:**
- Format: WAV, 16 kHz, Mono, 16-bit PCM

### Model Downloads

- **Parakeet**: https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/tree/main
- **Whisper**: https://huggingface.co/ggerganov/whisper.cpp/tree/main

### Library Usage

```rust
use transcribe_rs::{TranscriptionEngine, engines::parakeet::ParakeetEngine};
use std::path::PathBuf;

let mut engine = ParakeetEngine::new();
engine.load_model(&PathBuf::from("path/to/model"))?;
let result = engine.transcribe_file(&PathBuf::from("audio.wav"), None)?;
println!("{}", result.text);
```

### Running the Example

```bash
# Run with Parakeet (default)
cargo run --example transcribe

# The example will transcribe samples/dots.wav and show timing information
```

To switch between Parakeet and Whisper, edit `examples/transcribe.rs`:
```rust
let engine_type = Engine::Parakeet; // or Engine::Whisper
```

## Acknowledgments

- Big thanks to [istupakov](https://github.com/istupakov/onnx-asr) for the excellent ONNX implementation of Parakeet
- Thanks to NVIDIA for releasing the Parakeet model
- Thanks to the [whisper.cpp](https://github.com/ggerganov/whisper.cpp) project for the Whisper implementation
