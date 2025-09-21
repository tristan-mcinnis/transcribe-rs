//! Audio processing utilities for transcription.
//!
//! This module provides functions for reading and processing audio files
//! to prepare them for transcription engines.

use std::path::Path;

/// Read WAV file samples and convert them to the required format.
///
/// This function reads a WAV file and converts it to the format expected by
/// transcription engines: 16kHz sample rate, 16-bit samples, mono channel.
///
/// # Arguments
///
/// * `wav_path` - Path to the WAV file to read
///
/// # Returns
///
/// Returns a vector of f32 samples normalized to the range [-1.0, 1.0].
///
/// # Errors
///
/// This function will return an error if:
/// - The file cannot be opened or read
/// - The WAV format is incorrect (not 16kHz, 16-bit, mono)
/// - The samples cannot be converted to the expected format
///
/// # Examples
///
/// ```rust,no_run
/// use transcribe_rs::audio::read_wav_samples;
/// use std::path::Path;
///
/// let samples = read_wav_samples(Path::new("audio.wav"))?;
/// println!("Loaded {} samples", samples.len());
/// # Ok::<(), Box<dyn std::error::Error>>(())
/// ```
///
/// # Audio Requirements
///
/// The input WAV file must have:
/// - Sample rate: 16,000 Hz
/// - Bit depth: 16 bits per sample
/// - Channels: 1 (mono)
/// - Format: PCM integer samples
pub fn read_wav_samples(wav_path: &Path) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
    let mut reader = hound::WavReader::open(wav_path)?;
    let spec = reader.spec();

    let expected_spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    if spec.channels != expected_spec.channels {
        return Err(format!(
            "Expected {} channels, found {}",
            expected_spec.channels, spec.channels
        )
        .into());
    }

    if spec.sample_rate != expected_spec.sample_rate {
        return Err(format!(
            "Expected {} Hz sample rate, found {} Hz",
            expected_spec.sample_rate, spec.sample_rate
        )
        .into());
    }

    if spec.bits_per_sample != expected_spec.bits_per_sample {
        return Err(format!(
            "Expected {} bits per sample, found {}",
            expected_spec.bits_per_sample, spec.bits_per_sample
        )
        .into());
    }

    if spec.sample_format != expected_spec.sample_format {
        return Err(format!("Expected Int sample format, found {:?}", spec.sample_format).into());
    }

    let scale = i16::MAX as f32;

    let samples: Result<Vec<f32>, _> = reader
        .samples::<i16>()
        .map(|sample| {
            sample.map(|s| {
                if s == i16::MIN {
                    -1.0
                } else {
                    s as f32 / scale
                }
            })
        })
        .collect();

    Ok(samples?)
}
