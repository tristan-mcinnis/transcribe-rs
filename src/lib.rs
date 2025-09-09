pub mod audio;
pub mod engines;

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
        let samples = audio::read_wav_samples(wav_path)?;
        self.transcribe_samples(samples, params)
    }
}
