use serde::{Deserialize, Serialize};
use std::error::Error;

use crate::{TranscriptionResult, TranscriptionSegment};

const TARGET_SAMPLE_RATE: usize = 16_000;
const DEFAULT_MAX_BUFFER_SECONDS: usize = 300;
const MERGE_BACKTRACK_SECONDS: f32 = 1.5;

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
    sample_rate: usize,
    max_buffer_samples: usize,
    timeline_offset: f32,
    published_segments: Vec<SerializableSegment>,
    published_text: String,
    last_sent_segments: Vec<SerializableSegment>,
    last_sent_text: String,
}

impl<T: RealtimeTranscriber> RealtimeSession<T> {
    /// Create a new session around the provided transcriber implementation using default limits.
    pub fn new(transcriber: T, language: Option<String>) -> Self {
        Self::with_sample_rate(
            transcriber,
            language,
            TARGET_SAMPLE_RATE,
            DEFAULT_MAX_BUFFER_SECONDS,
        )
    }

    /// Construct a session with a specific sample rate and buffer duration limit.
    pub fn with_sample_rate(
        transcriber: T,
        language: Option<String>,
        sample_rate: usize,
        max_buffer_duration_secs: usize,
    ) -> Self {
        let sr = sample_rate.max(1);
        let max_duration = max_buffer_duration_secs.max(1);
        let max_samples = sr.saturating_mul(max_duration);

        Self {
            transcriber,
            language,
            samples: Vec::new(),
            sample_rate: sr,
            max_buffer_samples: max_samples,
            timeline_offset: 0.0,
            published_segments: Vec::new(),
            published_text: String::new(),
            last_sent_segments: Vec::new(),
            last_sent_text: String::new(),
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
                self.push_samples(samples);
                let language = self.language.clone();
                match self
                    .transcriber
                    .transcribe(self.samples.clone(), language.as_deref())
                {
                    Ok(result) => {
                        let adjusted_segments: Vec<SerializableSegment> = result
                            .segments
                            .iter()
                            .map(|segment| {
                                let mut serializable = SerializableSegment::from(segment);
                                serializable.start += self.timeline_offset;
                                serializable.end += self.timeline_offset;
                                serializable
                            })
                            .collect();

                        let mut changed = self.merge_segments(adjusted_segments);
                        let aggregate_text = Self::segments_to_text(&self.published_segments);
                        if aggregate_text != self.published_text {
                            self.published_text = aggregate_text;
                            changed = true;
                        }

                        if changed
                            || self.published_segments != self.last_sent_segments
                            || self.published_text != self.last_sent_text
                        {
                            self.last_sent_segments = self.published_segments.clone();
                            self.last_sent_text = self.published_text.clone();
                            Ok(vec![OutboundMessage::Transcript {
                                text: self.published_text.clone(),
                                segments: self.published_segments.clone(),
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
                self.timeline_offset = 0.0;
                self.published_segments.clear();
                self.published_text.clear();
                self.last_sent_segments.clear();
                self.last_sent_text.clear();
                Ok(vec![OutboundMessage::Status {
                    message: "session_reset".to_string(),
                }])
            }
            InboundMessage::Flush => {
                if self.published_segments.is_empty() && self.published_text.is_empty() {
                    Ok(Vec::new())
                } else {
                    Ok(vec![OutboundMessage::Transcript {
                        text: self.published_text.clone(),
                        segments: self.published_segments.clone(),
                    }])
                }
            }
        }
    }

    fn push_samples(&mut self, incoming: Vec<f32>) {
        self.samples.extend(incoming);
        if self.samples.len() > self.max_buffer_samples {
            let excess = self.samples.len() - self.max_buffer_samples;
            self.samples.drain(0..excess);
            let offset = excess as f32 / self.sample_rate as f32;
            self.timeline_offset += offset;
        }
    }

    fn merge_segments(&mut self, new_segments: Vec<SerializableSegment>) -> bool {
        if new_segments.is_empty() {
            return false;
        }

        let mut replace_from = new_segments
            .first()
            .map(|segment| segment.start - MERGE_BACKTRACK_SECONDS)
            .unwrap_or(0.0);
        replace_from = replace_from.max(self.timeline_offset);

        let original = self.published_segments.clone();

        let retain_len = self
            .published_segments
            .iter()
            .position(|segment| segment.start >= replace_from)
            .unwrap_or(self.published_segments.len());

        if retain_len < self.published_segments.len() {
            self.published_segments.truncate(retain_len);
        }

        for segment in new_segments {
            if let Some(last) = self.published_segments.last_mut() {
                if (last.start - segment.start).abs() < 0.25
                    && (last.end - segment.end).abs() < 0.25
                {
                    if last.text != segment.text
                        || (last.start - segment.start).abs() >= f32::EPSILON
                        || (last.end - segment.end).abs() >= f32::EPSILON
                    {
                        last.start = segment.start;
                        last.end = segment.end;
                        last.text = segment.text;
                    }
                    continue;
                }
            }

            self.published_segments.push(segment);
        }

        self.published_segments != original
    }

    fn segments_to_text(segments: &[SerializableSegment]) -> String {
        let mut pieces: Vec<&str> = Vec::with_capacity(segments.len());
        for segment in segments {
            let trimmed = segment.text.trim();
            if !trimmed.is_empty() {
                pieces.push(trimmed);
            }
        }
        pieces.join(" ")
    }

    /// Returns the currently buffered samples, primarily for inspection in tests.
    pub fn buffered_samples(&self) -> &[f32] {
        &self.samples
    }
}
