use crate::{ModelInfo, TranscriptionEngine, TranscriptionResult, TranscriptionSegment};
use std::path::PathBuf;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

#[derive(Debug, Clone)]
pub struct WhisperParams {
    pub language: Option<String>,
    pub print_special: bool,
    pub print_progress: bool,
    pub print_realtime: bool,
    pub print_timestamps: bool,
    pub suppress_blank: bool,
    pub suppress_non_speech_tokens: bool,
    pub no_speech_thold: f32,
}

impl Default for WhisperParams {
    fn default() -> Self {
        Self {
            language: None,
            print_special: false,
            print_progress: false,
            print_realtime: false,
            print_timestamps: false,
            suppress_blank: true,
            suppress_non_speech_tokens: true,
            no_speech_thold: 0.2,
        }
    }
}

pub struct WhisperEngine {
    loaded_model_path: Option<PathBuf>,
    state: Option<whisper_rs::WhisperState>,
    context: Option<whisper_rs::WhisperContext>,
}

impl WhisperEngine {
    pub fn new() -> Self {
        Self {
            loaded_model_path: None,
            state: None,
            context: None,
        }
    }
}

impl TranscriptionEngine for WhisperEngine {
    type Params = WhisperParams;
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
        // Create new context and state following your working pattern
        let context = WhisperContext::new_with_params(
            model_path.to_str().unwrap(),
            WhisperContextParameters::default(),
        )?;

        let state = context.create_state()?;

        self.context = Some(context);
        self.state = Some(state);

        self.loaded_model_path = Some(model_path.clone());
        Ok(())
    }

    fn unload_model(&mut self) {
        self.loaded_model_path = None;
        self.state = None;
        self.context = None;
    }

    fn transcribe_samples(
        &mut self,
        samples: Vec<f32>,
        params: Option<Self::Params>,
    ) -> Result<TranscriptionResult, Box<dyn std::error::Error>> {
        let state = self
            .state
            .as_mut()
            .ok_or("Model not loaded. Call load_model() first.")?;

        let whisper_params = params.unwrap_or_default();

        let mut full_params = FullParams::new(SamplingStrategy::BeamSearch {
            beam_size: 3,
            patience: -1.0,
        });
        full_params.set_language(whisper_params.language.as_deref());
        full_params.set_print_special(whisper_params.print_special);
        full_params.set_print_progress(whisper_params.print_progress);
        full_params.set_print_realtime(whisper_params.print_realtime);
        full_params.set_print_timestamps(whisper_params.print_timestamps);
        full_params.set_suppress_blank(whisper_params.suppress_blank);
        full_params.set_suppress_nst(whisper_params.suppress_non_speech_tokens);
        full_params.set_no_speech_thold(whisper_params.no_speech_thold);

        state.full(full_params, &samples)?;

        let mut segments = Vec::new();
        let mut full_text = String::new();

        for segment in state.as_iter() {
            let text = segment.to_string();
            let start = segment.start_timestamp() as f32;
            let end = segment.end_timestamp() as f32;

            segments.push(TranscriptionSegment {
                start,
                end,
                text: text.clone(),
            });
            full_text.push_str(&text);
        }

        Ok(TranscriptionResult {
            text: full_text.trim().to_string(),
            segments,
        })
    }
}
