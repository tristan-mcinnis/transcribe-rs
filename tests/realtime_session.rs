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
    sample_lengths: Rc<RefCell<Vec<usize>>>,
}

impl MockTranscriber {
    fn with_responses(
        responses: Vec<Result<TranscriptionResult, io::Error>>,
    ) -> (
        Self,
        Rc<RefCell<Vec<Option<String>>>>,
        Rc<RefCell<Vec<usize>>>,
    ) {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let lengths = Rc::new(RefCell::new(Vec::new()));
        (
            Self {
                responses,
                calls: Rc::clone(&calls),
                sample_lengths: Rc::clone(&lengths),
            },
            calls,
            lengths,
        )
    }
}

impl RealtimeTranscriber for MockTranscriber {
    fn transcribe(
        &mut self,
        samples: Vec<f32>,
        language: Option<&str>,
    ) -> Result<TranscriptionResult, Box<dyn std::error::Error>> {
        self.calls
            .borrow_mut()
            .push(language.map(|value| value.to_string()));
        self.sample_lengths.borrow_mut().push(samples.len());
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
    let (transcriber, _, _) = MockTranscriber::with_responses(responses);
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
    let (transcriber, _, _) = MockTranscriber::with_responses(responses);

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
    let (transcriber, _, _) = MockTranscriber::with_responses(responses);
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
    let (transcriber, call_log, _) =
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
    let (transcriber, _, _) = MockTranscriber::with_responses(responses);

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

#[test]
fn buffers_trim_and_offset_segments() {
    let responses = vec![
        Ok(make_result("a", &[("a", 0.0, 0.5)])),
        Ok(make_result("b", &[("b", 0.0, 1.0)])),
    ];
    let (transcriber, _, sample_lengths) = MockTranscriber::with_responses(responses);
    let mut session = RealtimeSession::with_sample_rate(transcriber, None, 10, 1);

    let first = session
        .handle_inbound(InboundMessage::Chunk {
            samples: vec![0.0; 5],
        })
        .expect("first chunk should succeed");
    assert_eq!(first.len(), 1);
    match &first[0] {
        OutboundMessage::Transcript { text, segments } => {
            assert_eq!(text, "a");
            assert_eq!(segments.len(), 1);
            assert!((segments[0].start - 0.0).abs() < f32::EPSILON);
            assert!((segments[0].end - 0.5).abs() < f32::EPSILON);
        }
        other => panic!("unexpected first outbound message: {other:?}"),
    }

    let second = session
        .handle_inbound(InboundMessage::Chunk {
            samples: vec![0.0; 10],
        })
        .expect("second chunk should succeed");
    assert_eq!(second.len(), 1);
    match &second[0] {
        OutboundMessage::Transcript { text, segments } => {
            assert_eq!(text, "a b");
            assert_eq!(segments.len(), 2);
            let last = segments.last().expect("two segments expected");
            assert!((last.start - 0.5).abs() < f32::EPSILON);
            assert!((last.end - 1.5).abs() < f32::EPSILON);
        }
        other => panic!("unexpected second outbound message: {other:?}"),
    }

    assert_eq!(session.buffered_samples().len(), 10);
    let lengths = sample_lengths.borrow();
    assert_eq!(lengths.as_slice(), &[5, 10]);
}
