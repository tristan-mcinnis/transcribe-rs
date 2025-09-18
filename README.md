# transcribe-rs

A Rust library for audio transcription supporting multiple engines including Whisper and Parakeet.

This repository now also ships with a barebones Electron desktop shell that turns the core library into a realtime note taking workstation. The Electron window streams microphone audio into the new `realtime_cli` helper binary, surfaces the running transcript, and asks OpenAI's `gpt-5-nano` model to maintain chronological bullet notes while you talk.

This library was extracted from the [Handy](https://github.com/cjpais/handy) project to help other developers integrate transcription capabilities into their applications. We hope to support additional ASR models in the future and may expand to include features like microphone input and real-time transcription.

## Realtime Note Taking App

### Prerequisites

- Rust toolchain (for compiling the transcription engines and realtime CLI helper)
- Node.js 20+ (Electron development runtime)
- A supported transcription model downloaded locally (see [Model Downloads](#model-downloads))
- Optional but recommended: `.env` file in the project root with `OPENAI_API_KEY=...` for note generation

### Build & Install

```bash
# Build the realtime CLI helper (required after updating Rust code)
cargo build --bin realtime_cli

# Install Electron dependencies
cd electron
npm install
cd ..
```

### Launching the Desktop App

```bash
cd electron
npm start
```

The Electron window provides:

- **Model configuration:** pick Whisper (GGML file) or Parakeet (model directory) and optional language hint.
- **Live transcript column:** incrementally updated transcript directly from the streaming CLI.
- **Realtime notes column:** bullet insights produced by OpenAI `gpt-5-nano` as the transcript grows.

### Session Storage & Long Meetings

- **Automatic archiving:** every capture writes JSON snapshots and append-only logs to
  `~/Documents/TranscribeRS Sessions/<timestamp>/` on macOS (matching the user documents folder on Windows and Linux).
  Each session folder includes `session.json`, `transcript.json`, `notes.json`, and rolling `.log.jsonl` histories so you can
  recover intermediate states even if the desktop app closes unexpectedly.
- **Finder shortcut:** the UI surfaces the active (or most recent) session folder and adds a _Reveal in Finder_ button for quick
  access to the saved material on macOS.
- **Bounded memory usage:** the realtime engine now maintains a five-minute rolling audio window while keeping the cumulative
  transcript on disk. This keeps RAM and CPU usage predictable even across multi-hour recordings without losing earlier
  conversation context.
- If the app cannot create the session directory (for example due to permissions) you'll see a warning in the status bar, but
  transcription and note taking continue in-memory so your meeting isn't interrupted.

On macOS the app automatically uses Metal acceleration when your Whisper build supports it. If no OpenAI API key is present the notes column will remain disabled while transcription continues to work.

### CLI-Only Streaming

You can also use the realtime helper directly from the terminal if you prefer wiring it into another UI:

```bash
cargo run --bin realtime_cli -- \
  --engine whisper \
  --model-path models/whisper-medium-q4_1.bin
```

Send newline-delimited JSON messages through stdin in the shape `{ "type": "chunk", "samples": [f32, ...] }` and receive structured transcript updates on stdout.

## Testing

The repository now ships with automated tests for both the Rust core and the Electron helper utilities.

```bash
# Run the Rust test suite without optional Parakeet dependencies
cargo test --no-default-features --features whisper

# Execute the Electron utility tests (requires `npm install` first)
cd electron
npm test
```

Running the Rust tests with Whisper-only features avoids the Parakeet ONNX runtime download, which isn't available in the sandboxed CI environment. On macOS or locally you can omit the feature flags to exercise both engines if you've already provisioned the Parakeet models.

## Features

- **Multiple Transcription Engines**: Support for both Whisper and Parakeet models
- **Cross-platform**: Works on macOS, Windows, and Linux with optimized backends
- **Hardware Acceleration**: Metal on macOS, Vulkan on Windows/Linux
- **Flexible API**: Common interface for different transcription engines

## Parakeet Performance

Using the int8 quantized Parakeet model, performance benchmarks:

- **30x real time** on MBP M4 Max
- **20x real time** on Zen 3 (5700X)
- **5x real time** on Skylake (i5-6500)
- **5x real time** on Jetson Nano CPU


### Required Model Files

**Parakeet Model Directory Structure:**
```
models/parakeet-v0.3/
├── encoder-model.onnx           # Encoder model (FP32)
├── encoder-model.int8.onnx      # Encoder model (For quantized)
├── decoder_joint-model.onnx    # Decoder/joint model (FP32)
├── decoder_joint-model.int8.onnx # Decoder/joint model (For quantized)
├── nemo128.onnx                 # Audio preprocessor
├── vocab.txt                    # Vocabulary file
```

**Whisper Model:**
- Single GGML file (e.g., `whisper-medium-q4_1.bin`)

**Audio Requirements:**
- Format: WAV
- Sample Rate: 16 kHz
- Channels: Mono (1 channel)
- Bit Depth: 16-bit
- Encoding: PCM

## Model Downloads

- **Parakeet**: https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/tree/main
- **Whisper**: https://huggingface.co/ggerganov/whisper.cpp/tree/main

## Usage

```rust
use transcribe_rs::{TranscriptionEngine, engines::parakeet::ParakeetEngine};
use std::path::PathBuf;

let mut engine = ParakeetEngine::new();
engine.load_model(&PathBuf::from("path/to/model"))?;
let result = engine.transcribe_file(&PathBuf::from("audio.wav"), None)?;
println!("{}", result.text);
```

## Running the Example

### Setup

1. **Create the models directory:**
   ```bash
   mkdir models
   ```

2. **Download Parakeet Model (recommended for performance):**
   ```bash
   # Download and extract Parakeet model
   cd models
   wget https://blob.handy.computer/parakeet-v3-int8.tar.gz
   tar -xzf parakeet-v3-int8.tar.gz
   rm parakeet-v3-int8.tar.gz
   cd ..
   ```

3. **Or Download Whisper Model (alternative):**
   ```bash
   # Download Whisper model
   cd models
   wget https://blob.handy.computer/whisper-medium-q4_1.bin
   cd ..
   ```

### Running the Example

```bash
cargo run --example transcribe
```

The example will:
- Load the Parakeet model (default) or Whisper model
- Transcribe `samples/dots.wav`
- Display timing information and transcription results
- Show real-time speedup factor

**To switch engines**, edit `examples/transcribe.rs` and change:
```rust
let engine_type = Engine::Parakeet; // or Engine::Whisper
```

## Acknowledgments

- Big thanks to [istupakov](https://github.com/istupakov/onnx-asr) for the excellent ONNX implementation of Parakeet
- Thanks to NVIDIA for releasing the Parakeet model
- Thanks to the [whisper.cpp](https://github.com/ggerganov/whisper.cpp) project for the Whisper implementation
