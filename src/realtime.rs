use serde::{Deserialize, Serialize};
use std::error::Error;

use crate::{TranscriptionResult, TranscriptionSegment};

/// Message format accepted by the realtime CLI helper.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InboundMessage {
    /// Append a new chunk of audio samples to the active session buffer.
    Chunk { samples: Vec<f32> },
    /// Reset the session and clear accumulated samples/state.
    Reset,
    /// Emit the most recent transcript even if it hasn't changed.
    Flush,
}

/// Serializable transcript segment forwarded to the renderer.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct SerializableSegment {
    pub start: f32,
    pub end: f32,
    pub text: String,
}

impl From<&TranscriptionSegment> for SerializableSegment {
    fn from(value: &TranscriptionSegment) -> Self {
        Self {
            start: value.start,
            end: value.end,
            text: value.text.clone(),
        }
    }
}

/// Outbound message format produced by the realtime session.
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutboundMessage {
    Ready {
        engine: String,
    },
    Status {
        message: String,
    },
    Transcript {
        text: String,
        segments: Vec<SerializableSegment>,
    },
    Error {
        message: String,
    },
}

/// Minimal interface used by the realtime session to request transcripts.
pub trait RealtimeTranscriber {
    /// Generate a transcript for the provided audio samples.
    fn transcribe(
        &mut self,
        samples: Vec<f32>,
        language: Option<&str>,
    ) -> Result<TranscriptionResult, Box<dyn Error>>;
}

/// Stateful helper that aggregates audio chunks and produces outbound updates.
pub struct RealtimeSession<T: RealtimeTranscriber> {
    transcriber: T,
    language: Option<String>,
    samples: Vec<f32>,
    last_text: String,
    last_segments: Vec<SerializableSegment>,
}

impl<T: RealtimeTranscriber> RealtimeSession<T> {
    /// Create a new session around the provided transcriber implementation.
    pub fn new(transcriber: T, language: Option<String>) -> Self {
        Self {
            transcriber,
            language,
            samples: Vec::new(),
            last_text: String::new(),
            last_segments: Vec::new(),
        }
    }

    /// Handle an inbound message and return any resulting outbound messages.
    pub fn handle_inbound(
        &mut self,
        message: InboundMessage,
    ) -> Result<Vec<OutboundMessage>, Box<dyn Error>> {
        match message {
            InboundMessage::Chunk { samples } => {
                if samples.is_empty() {
                    return Ok(Vec::new());
                }
                self.samples.extend(samples);
                let language = self.language.clone();
                match self
                    .transcriber
                    .transcribe(self.samples.clone(), language.as_deref())
                {
                    Ok(result) => {
                        let segments: Vec<SerializableSegment> = result
                            .segments
                            .iter()
                            .map(SerializableSegment::from)
                            .collect();

                        if result.text != self.last_text || segments != self.last_segments {
                            self.last_text = result.text.clone();
                            self.last_segments = segments.clone();
                            Ok(vec![OutboundMessage::Transcript {
                                text: result.text,
                                segments,
                            }])
                        } else {
                            Ok(Vec::new())
                        }
                    }
                    Err(err) => Ok(vec![OutboundMessage::Error {
                        message: format!("transcription failed: {err}"),
                    }]),
                }
            }
            InboundMessage::Reset => {
                self.samples.clear();
                self.last_text.clear();
                self.last_segments.clear();
                Ok(vec![OutboundMessage::Status {
                    message: "session_reset".to_string(),
                }])
            }
            InboundMessage::Flush => {
                if self.last_text.is_empty() && self.last_segments.is_empty() {
                    Ok(Vec::new())
                } else {
                    Ok(vec![OutboundMessage::Transcript {
                        text: self.last_text.clone(),
                        segments: self.last_segments.clone(),
                    }])
                }
            }
        }
    }
}

impl<T: RealtimeTranscriber> RealtimeSession<T> {
    /// Returns the currently buffered samples, primarily for inspection in tests.
    pub fn buffered_samples(&self) -> &[f32] {
        &self.samples
    }
}
