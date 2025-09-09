use crate::{
    engines::parakeet::model::ParakeetModel, ModelInfo, TranscriptionEngine, TranscriptionResult,
    TranscriptionSegment,
};
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct ParakeetParams {
    pub language: Option<String>,
    pub beam_size: usize,
    pub temperature: f32,
    pub max_tokens: usize,
    pub suppress_blank: bool,
    pub suppress_repetitions: bool,
}

impl Default for ParakeetParams {
    fn default() -> Self {
        Self {
            language: None,
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

        let _parakeet_params = params.unwrap_or_default();

        // Get the timestamped result from the model
        let timestamped_result = model.transcribe_samples(samples)?;

        // Convert timestamped tokens to segments by grouping tokens into phrases
        let mut segments = Vec::new();

        if !timestamped_result.tokens.is_empty() && !timestamped_result.timestamps.is_empty() {
            let mut current_segment_start = 0.0;
            let mut current_segment_text = String::new();
            let mut tokens_in_segment = 0;

            for i in 0..timestamped_result.tokens.len() {
                let timestamp = timestamped_result.timestamps.get(i).copied().unwrap_or(0.0);
                let token_text = &timestamped_result.tokens[i];

                // Skip empty tokens
                if token_text.trim().is_empty() {
                    continue;
                }

                // Start new segment
                if tokens_in_segment == 0 {
                    current_segment_start = timestamp;
                    current_segment_text.clear();
                }

                current_segment_text.push_str(token_text);
                tokens_in_segment += 1;

                // Determine if we should end the current segment
                let should_end_segment = {
                    // End on punctuation
                    let has_punctuation = token_text.contains('.')
                        || token_text.contains('?')
                        || token_text.contains('!')
                        || token_text.contains(',');

                    // End after reasonable number of tokens (roughly word-level grouping)
                    let max_tokens_reached = tokens_in_segment >= 8;

                    // End if we're at the last token
                    let is_last_token = i == timestamped_result.tokens.len() - 1;

                    has_punctuation || max_tokens_reached || is_last_token
                };

                if should_end_segment {
                    let segment_end = timestamped_result
                        .timestamps
                        .get(i + 1)
                        .copied()
                        .unwrap_or(timestamp + 0.1); // Small buffer if no next timestamp

                    segments.push(TranscriptionSegment {
                        start: current_segment_start,
                        end: segment_end,
                        text: current_segment_text.trim().to_string(),
                    });

                    tokens_in_segment = 0;
                }
            }
        }

        // If no segments were created, create one segment with the full text
        if segments.is_empty() && !timestamped_result.text.trim().is_empty() {
            segments.push(TranscriptionSegment {
                start: 0.0,
                end: 0.0, // We don't have duration info in this case
                text: timestamped_result.text.clone(),
            });
        }

        Ok(TranscriptionResult {
            text: timestamped_result.text,
            segments,
        })
    }
}
