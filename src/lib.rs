pub mod parakeet;
pub mod parakeet_engine;
pub mod whisper;

use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct ModelInfo {
    pub name: String,
    pub parameters: u64,
    pub size_gb: f32,
    pub quantization: String,
    pub languages: Vec<String>,
}

#[derive(Debug)]
pub struct TranscriptionResult {
    pub text: String,
    pub segments: Vec<TranscriptionSegment>,
}

#[derive(Debug)]
pub struct TranscriptionSegment {
    pub start: f32,
    pub end: f32,
    pub text: String,
}

pub fn read_wav_samples(wav_path: &PathBuf) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
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

    let samples: Result<Vec<f32>, _> = reader
        .samples::<i16>()
        .map(|sample| sample.map(|s| s as f32 / i16::MAX as f32))
        .collect();

    Ok(samples?)
}

pub trait TranscriptionEngine {
    type Params;

    fn list_models(&self) -> Vec<ModelInfo>;
    fn download_model(
        &self,
        model_name: &str,
        path: Option<PathBuf>,
    ) -> Result<PathBuf, Box<dyn std::error::Error>>;
    fn validate_model(&self, model_path: &PathBuf) -> bool;
    fn get_model_details(&self, model_name: &str) -> Option<ModelInfo>;
    fn load_model(&mut self, model_path: &PathBuf) -> Result<(), Box<dyn std::error::Error>>;
    fn unload_model(&mut self);
    fn transcribe_samples(
        &mut self,
        samples: Vec<f32>,
        params: Option<Self::Params>,
    ) -> Result<TranscriptionResult, Box<dyn std::error::Error>>;

    fn transcribe_file(
        &mut self,
        wav_path: &PathBuf,
        params: Option<Self::Params>,
    ) -> Result<TranscriptionResult, Box<dyn std::error::Error>> {
        let samples = read_wav_samples(wav_path)?;
        self.transcribe_samples(samples, params)
    }
}
