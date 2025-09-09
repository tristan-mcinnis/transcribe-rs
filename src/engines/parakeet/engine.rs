use crate::{
    engines::parakeet::{model::ParakeetModel, timestamps::convert_timestamps},
    ModelInfo, TranscriptionEngine, TranscriptionResult,
};
use std::path::PathBuf;

#[derive(Debug, Clone, Default, PartialEq)]
pub enum TimestampGranularity {
    #[default]
    Token,
    Word,
    Segment,
}

#[derive(Debug, Clone)]
pub struct ParakeetParams {
    pub timestamp_granularity: TimestampGranularity,
    pub beam_size: usize,
    pub temperature: f32,
    pub max_tokens: usize,
    pub suppress_blank: bool,
    pub suppress_repetitions: bool,
}

impl Default for ParakeetParams {
    fn default() -> Self {
        Self {
            timestamp_granularity: TimestampGranularity::Token,
            beam_size: 5,
            temperature: 0.0,
            max_tokens: 512,
            suppress_blank: true,
            suppress_repetitions: true,
        }
    }
}

pub struct ParakeetEngine {
    loaded_model_path: Option<PathBuf>,
    model: Option<ParakeetModel>,
}

impl ParakeetEngine {
    pub fn new() -> Self {
        Self {
            loaded_model_path: None,
            model: None,
        }
    }
}

impl TranscriptionEngine for ParakeetEngine {
    type Params = ParakeetParams;

    fn list_models(&self) -> Vec<ModelInfo> {
        vec![]
    }

    fn download_model(
        &self,
        model_name: &str,
        path: Option<PathBuf>,
    ) -> Result<PathBuf, Box<dyn std::error::Error>> {
        todo!("Download {} to {:?}", model_name, path)
    }

    fn validate_model(&self, model_path: &PathBuf) -> bool {
        todo!("Validate model at {:?}", model_path)
    }

    fn get_model_details(&self, model_name: &str) -> Option<ModelInfo> {
        self.list_models()
            .into_iter()
            .find(|m| m.name == model_name)
    }

    fn load_model(&mut self, model_path: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
        let model = ParakeetModel::new(model_path)?;

        self.model = Some(model);
        self.loaded_model_path = Some(model_path.clone());
        Ok(())
    }

    fn unload_model(&mut self) {
        self.loaded_model_path = None;
        self.model = None;
    }

    fn transcribe_samples(
        &mut self,
        samples: Vec<f32>,
        params: Option<Self::Params>,
    ) -> Result<TranscriptionResult, Box<dyn std::error::Error>> {
        let model: &mut ParakeetModel = self
            .model
            .as_mut()
            .ok_or("Model not loaded. Call load_model() first.")?;

        let parakeet_params = params.unwrap_or_default();

        // Get the timestamped result from the model
        let timestamped_result = model.transcribe_samples(samples)?;

        // Convert timestamps based on requested granularity
        let segments =
            convert_timestamps(&timestamped_result, parakeet_params.timestamp_granularity);

        Ok(TranscriptionResult {
            text: timestamped_result.text,
            segments,
        })
    }
}
