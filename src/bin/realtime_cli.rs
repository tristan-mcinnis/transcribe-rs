use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

use clap::{Parser, ValueEnum};
#[cfg(feature = "parakeet")]
use transcribe_rs::engines::parakeet::{ParakeetEngine, ParakeetInferenceParams};
use transcribe_rs::{
    engines::whisper::{WhisperEngine, WhisperInferenceParams},
    realtime::{InboundMessage, OutboundMessage, RealtimeSession, RealtimeTranscriber},
    TranscriptionEngine, TranscriptionResult,
};

#[derive(Parser, Debug)]
#[command(
    about = "Realtime transcription helper for the Electron notes app",
    version
)]
struct Args {
    /// Which engine to use for transcription
    #[arg(long, value_enum, default_value_t = EngineChoice::Whisper)]
    engine: EngineChoice,

    /// Path to the model file (Whisper) or directory (Parakeet)
    #[arg(long)]
    model_path: PathBuf,

    /// Optional forced language code passed to Whisper (e.g. "en")
    #[arg(long)]
    language: Option<String>,
}

#[derive(Copy, Clone, Debug, ValueEnum)]
enum EngineChoice {
    Whisper,
    #[cfg(feature = "parakeet")]
    Parakeet,
}

impl EngineChoice {
    fn create_engine(self) -> EngineWrapper {
        match self {
            EngineChoice::Whisper => EngineWrapper::Whisper(WhisperEngine::new()),
            #[cfg(feature = "parakeet")]
            EngineChoice::Parakeet => EngineWrapper::Parakeet(ParakeetEngine::new()),
        }
    }
}

enum EngineWrapper {
    Whisper(WhisperEngine),
    #[cfg(feature = "parakeet")]
    Parakeet(ParakeetEngine),
}

impl EngineWrapper {
    fn load_model(&mut self, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
        match self {
            EngineWrapper::Whisper(engine) => engine.load_model(path),
            #[cfg(feature = "parakeet")]
            EngineWrapper::Parakeet(engine) => engine.load_model(path),
        }
    }
}

impl RealtimeTranscriber for EngineWrapper {
    fn transcribe(
        &mut self,
        samples: Vec<f32>,
        language: Option<&str>,
    ) -> Result<TranscriptionResult, Box<dyn std::error::Error>> {
        match self {
            EngineWrapper::Whisper(engine) => {
                let mut params = WhisperInferenceParams::default();
                if let Some(code) = language {
                    params.language = Some(code.to_string());
                }
                engine.transcribe_samples(samples, Some(params))
            }
            #[cfg(feature = "parakeet")]
            EngineWrapper::Parakeet(engine) => {
                let params = ParakeetInferenceParams::default();
                engine.transcribe_samples(samples, Some(params))
            }
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    let mut engine = args.engine.create_engine();
    engine.load_model(&args.model_path)?;

    send_message(&OutboundMessage::Ready {
        engine: format!("{:?}", args.engine),
    })?;

    let mut session = RealtimeSession::new(engine, args.language.clone());
    let stdin = io::stdin();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        match serde_json::from_str::<InboundMessage>(&line) {
            Ok(message) => {
                let responses = session.handle_inbound(message)?;
                for outbound in responses {
                    send_message(&outbound)?;
                }
            }
            Err(err) => {
                send_message(&OutboundMessage::Error {
                    message: format!("failed to parse message: {err}"),
                })?;
            }
        }
    }

    Ok(())
}

fn send_message(message: &OutboundMessage) -> Result<(), Box<dyn std::error::Error>> {
    let mut stdout = io::stdout();
    serde_json::to_writer(&mut stdout, message)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
}
