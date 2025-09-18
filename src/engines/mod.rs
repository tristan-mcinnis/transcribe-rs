//! Speech recognition engines for transcription.
//!
//! This module contains implementations of different speech recognition engines
//! that can be used for audio transcription. Each engine has its own requirements
//! for model formats and provides different capabilities.
//!
//! # Available Engines
//!
//! ## Whisper Engine
//!
//! OpenAI's Whisper model implementation:
//! - **Model Format**: Single GGML format file (`.bin`)
//! - **Models**: tiny, base, small, medium, large variants
//! - **Features**: Multi-language support, robust performance
//! - **Example**: `whisper-medium-q4_1.bin`
//!
//! ## Parakeet Engine
//!
//! NVIDIA NeMo Parakeet model implementation:
//! - **Model Format**: Directory containing model files
//! - **Features**: Flexible timestamp granularity, quantization support
//! - **Performance**: Optimized for speed with Int8 quantization
//! - **Example**: `parakeet-v0.3/` directory
//!
//! # Usage Comparison
//!
//! ```rust,no_run
//! use std::path::PathBuf;
//! use transcribe_rs::{TranscriptionEngine, engines::whisper::WhisperEngine};
//! #[cfg(feature = "parakeet")]
//! use transcribe_rs::engines::parakeet::ParakeetEngine;
//!
//! // Whisper: Single file model
//! let mut whisper = WhisperEngine::new();
//! whisper.load_model(&PathBuf::from("models/whisper-medium-q4_1.bin"))?;
//! let whisper_result = whisper.transcribe_file(&PathBuf::from("audio.wav"), None)?;
//! # let _ = whisper_result;
//!
//! #[cfg(feature = "parakeet")]
//! {
//!     // Parakeet: Directory model
//!     let mut parakeet = ParakeetEngine::new();
//!     parakeet.load_model(&PathBuf::from("models/parakeet-v0.3"))?;
//!     let parakeet_result = parakeet.transcribe_file(&PathBuf::from("audio.wav"), None)?;
//!     # let _ = parakeet_result;
//! }
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

#[cfg(feature = "parakeet")]
pub mod parakeet;
pub mod whisper;
