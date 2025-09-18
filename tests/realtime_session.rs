use std::{cell::RefCell, io, rc::Rc};

use transcribe_rs::{
    realtime::{
        InboundMessage, OutboundMessage, RealtimeSession, RealtimeTranscriber, SerializableSegment,
    },
    TranscriptionResult, TranscriptionSegment,
};

struct MockTranscriber {
    responses: Vec<Result<TranscriptionResult, io::Error>>,
    calls: Rc<RefCell<Vec<Option<String>>>>,
}

impl MockTranscriber {
    fn with_responses(
        responses: Vec<Result<TranscriptionResult, io::Error>>,
    ) -> (Self, Rc<RefCell<Vec<Option<String>>>>) {
        let calls = Rc::new(RefCell::new(Vec::new()));
        (
            Self {
                responses,
                calls: Rc::clone(&calls),
            },
            calls,
        )
    }
}

impl RealtimeTranscriber for MockTranscriber {
    fn transcribe(
        &mut self,
        _samples: Vec<f32>,
        language: Option<&str>,
    ) -> Result<TranscriptionResult, Box<dyn std::error::Error>> {
        self.calls
            .borrow_mut()
            .push(language.map(|value| value.to_string()));
        if self.responses.is_empty() {
            return Err(Box::new(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "no mock response configured",
            )));
        }

        match self.responses.remove(0) {
            Ok(result) => Ok(result),
            Err(err) => Err(Box::new(io::Error::new(err.kind(), err.to_string()))),
        }
    }
}

fn make_result(text: &str, segments: &[(&str, f32, f32)]) -> TranscriptionResult {
    let segments = segments
        .iter()
        .map(|(content, start, end)| TranscriptionSegment {
            start: *start,
            end: *end,
            text: content.to_string(),
        })
        .collect();

    TranscriptionResult {
        text: text.to_string(),
        segments,
    }
}

#[test]
fn chunk_emits_transcript_when_text_changes() {
    let responses = vec![Ok(make_result("hello world", &[("hello world", 0.0, 1.5)]))];
    let (transcriber, _) = MockTranscriber::with_responses(responses);
    let mut session = RealtimeSession::new(transcriber, None);

    let messages = session
        .handle_inbound(InboundMessage::Chunk {
            samples: vec![0.0, 0.1, 0.2],
        })
        .expect("chunk handling should succeed");

    assert_eq!(messages.len(), 1);
    assert_eq!(
        messages[0],
        OutboundMessage::Transcript {
            text: "hello world".to_string(),
            segments: vec![SerializableSegment {
                start: 0.0,
                end: 1.5,
                text: "hello world".to_string(),
            }],
        }
    );
}

#[test]
fn identical_transcripts_do_not_emit_new_message() {
    let responses = vec![
        Ok(make_result("state", &[("state", 0.0, 0.5)])),
        Ok(make_result("state", &[("state", 0.0, 0.5)])),
    ];
    let (transcriber, _) = MockTranscriber::with_responses(responses);

    let mut session = RealtimeSession::new(transcriber, None);

    let first = session
        .handle_inbound(InboundMessage::Chunk {
            samples: vec![0.2, 0.4],
        })
        .unwrap();
    assert_eq!(first.len(), 1);

    let second = session
        .handle_inbound(InboundMessage::Chunk {
            samples: vec![0.6, 0.8],
        })
        .unwrap();
    assert!(second.is_empty(), "unchanged transcript should not emit");
}

#[test]
fn reset_clears_state_and_emits_status() {
    let responses = vec![Ok(make_result("first", &[("first", 0.0, 0.5)]))];
    let (transcriber, _) = MockTranscriber::with_responses(responses);
    let mut session = RealtimeSession::new(transcriber, None);

    session
        .handle_inbound(InboundMessage::Chunk {
            samples: vec![0.1, 0.2],
        })
        .unwrap();

    let reset_messages = session
        .handle_inbound(InboundMessage::Reset)
        .expect("reset should succeed");
    assert_eq!(
        reset_messages,
        vec![OutboundMessage::Status {
            message: "session_reset".to_string(),
        }]
    );
    assert!(session.buffered_samples().is_empty());
}

#[test]
fn flush_replays_last_transcript() {
    let (transcriber, call_log) =
        MockTranscriber::with_responses(vec![Ok(make_result("note", &[("note", 0.0, 1.0)]))]);
    let mut session = RealtimeSession::new(transcriber, Some("en".to_string()));

    let first = session
        .handle_inbound(InboundMessage::Chunk {
            samples: vec![0.1, 0.4, 0.6],
        })
        .unwrap();
    assert_eq!(first.len(), 1);

    let flush_messages = session
        .handle_inbound(InboundMessage::Flush)
        .expect("flush should succeed");

    assert_eq!(flush_messages.len(), 1);
    assert_eq!(flush_messages[0], first[0]);

    assert_eq!(session.buffered_samples().len(), 3);

    // Language flag is propagated to the transcriber.
    let calls = call_log.borrow();
    assert_eq!(calls.as_slice(), [Some("en".to_string())]);
}

#[test]
fn errors_are_wrapped_into_error_messages() {
    let responses = vec![Err(io::Error::new(io::ErrorKind::Other, "mock failure"))];
    let (transcriber, _) = MockTranscriber::with_responses(responses);
    let mut session = RealtimeSession::new(transcriber, None);

    let messages = session
        .handle_inbound(InboundMessage::Chunk {
            samples: vec![0.1, 0.2, 0.3],
        })
        .unwrap();

    assert_eq!(messages.len(), 1);
    match &messages[0] {
        OutboundMessage::Error { message } => {
            assert!(message.contains("mock failure"));
        }
        other => panic!("expected error message, got {other:?}"),
    }
}
