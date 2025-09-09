use ndarray::{Array, Array1, Array2, Array3, ArrayD, ArrayViewD, IxDyn};
use ort::execution_providers::CPUExecutionProvider;
use ort::inputs;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::TensorRef;
use regex::Regex;

use std::fs;
use std::path::Path;

pub type DecoderState = (Array3<f32>, Array3<f32>);

const SUBSAMPLING_FACTOR: usize = 8;
const WINDOW_SIZE: f32 = 0.01;

#[derive(Debug, Clone)]
pub struct TimestampedResult {
    pub text: String,
    pub timestamps: Vec<f32>,
    pub tokens: Vec<String>,
}

#[derive(thiserror::Error, Debug)]
pub enum ParakeetError {
    #[error("ORT error")]
    Ort(#[from] ort::Error),
    #[error("I/O error")]
    Io(#[from] std::io::Error),
    #[error("ndarray shape error")]
    Shape(#[from] ndarray::ShapeError),
}

pub struct ParakeetModel {
    encoder: Session,
    decoder_joint: Session,
    preprocessor: Session,
    vocab: Vec<String>,
    blank_idx: i32,
    vocab_size: usize,
    max_tokens_per_step: usize,
    decode_space_pattern: Regex,
}

impl ParakeetModel {
    pub fn new<P: AsRef<Path>>(model_dir: P) -> Result<Self, ParakeetError> {
        let encoder = Self::init_encoder_session(&model_dir)?;
        let decoder_joint = Self::init_decoder_joint_session(&model_dir)?;
        let preprocessor = Self::init_preprocessor_session(&model_dir)?;

        let (vocab, blank_idx) = Self::load_vocab(&model_dir)?;
        let vocab_size = vocab.len();

        log::info!(
            "Loaded vocabulary with {} tokens, blank_idx={}",
            vocab_size,
            blank_idx
        );

        Ok(Self {
            encoder,
            decoder_joint,
            preprocessor,
            vocab,
            blank_idx,
            vocab_size,
            max_tokens_per_step: 10,
            decode_space_pattern: Regex::new(r"\A\s|\s\B|(\s)\b").unwrap(),
        })
    }

    fn load_vocab<P: AsRef<Path>>(model_dir: P) -> Result<(Vec<String>, i32), ParakeetError> {
        let vocab_path = model_dir.as_ref().join("vocab.txt");
        let content = fs::read_to_string(vocab_path)?;

        let mut max_id = 0;
        let mut tokens_with_ids: Vec<(String, usize)> = Vec::new();
        let mut blank_idx: Option<usize> = None;

        for line in content.lines() {
            let parts: Vec<&str> = line.strip_suffix('\n').unwrap_or(line).split(' ').collect();
            if parts.len() >= 2 {
                let token = parts[0].to_string();
                if let Ok(id) = parts[1].parse::<usize>() {
                    if token == "<blk>" {
                        blank_idx = Some(id);
                    }
                    tokens_with_ids.push((token, id));
                    max_id = max_id.max(id);
                }
            }
        }

        // Create vocab vector with \u2581 replaced with space
        let mut vocab = vec![String::new(); max_id + 1];
        for (token, id) in tokens_with_ids {
            vocab[id] = token.replace('\u{2581}', " ");
        }

        let blank_idx = blank_idx.ok_or_else(|| {
            ParakeetError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Missing <blk> token in vocabulary",
            ))
        })? as i32;

        Ok((vocab, blank_idx))
    }

    fn init_encoder_session<P: AsRef<Path>>(model_dir: P) -> Result<Session, ParakeetError> {
        let encoder_model_name = "encoder-model.int8.onnx";
        let providers = vec![CPUExecutionProvider::default().build()];

        log::info!("Loading encoder model from {}...", encoder_model_name);
        let encoder = Session::builder()
            .unwrap()
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_execution_providers(providers)?
            .with_parallel_execution(true)?
            .with_intra_threads(4)?
            .with_inter_threads(4)?
            .commit_from_file(model_dir.as_ref().join(encoder_model_name))?;

        for input in &encoder.inputs {
            log::info!(
                "Encoder input: name={}, type={:?}",
                input.name,
                input.input_type
            );
        }

        Ok(encoder)
    }

    fn init_decoder_joint_session<P: AsRef<Path>>(model_dir: P) -> Result<Session, ParakeetError> {
        let decoder_joint_model_name = "decoder_joint-model.int8.onnx";
        let providers = vec![CPUExecutionProvider::default().build()];

        log::info!(
            "Loading decoder joint model from {}...",
            decoder_joint_model_name
        );
        let decoder_joint = Session::builder()
            .unwrap()
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_execution_providers(providers)?
            .with_parallel_execution(true)?
            // .with_intra_threads(4)?
            // .with_inter_threads(4)?
            .commit_from_file(model_dir.as_ref().join(decoder_joint_model_name))?;

        for input in &decoder_joint.inputs {
            log::info!(
                "Decoder joint input: name={}, type={:?}",
                input.name,
                input.input_type
            );
        }

        Ok(decoder_joint)
    }

    fn init_preprocessor_session<P: AsRef<Path>>(model_dir: P) -> Result<Session, ParakeetError> {
        let preprocessor_model_name = "nemo128.onnx";
        let providers = vec![CPUExecutionProvider::default().build()];

        log::info!(
            "Loading preprocessor model from {}...",
            preprocessor_model_name
        );
        let preprocessor = Session::builder()
            .unwrap()
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_execution_providers(providers)?
            .with_parallel_execution(true)?
            // .with_intra_threads(4)?
            // .with_inter_threads(4)?
            .commit_from_file(model_dir.as_ref().join(preprocessor_model_name))?;

        for input in &preprocessor.inputs {
            log::info!(
                "Preprocessor input: name={}, type={:?}",
                input.name,
                input.input_type
            );
        }

        Ok(preprocessor)
    }

    pub fn preprocess(
        &mut self,
        waveforms: &ArrayViewD<f32>,
        waveforms_lens: &ArrayViewD<i64>,
    ) -> Result<(ArrayD<f32>, ArrayD<i64>), ParakeetError> {
        log::trace!("Running preprocessor inference...");
        let inputs = inputs![
            "waveforms" => TensorRef::from_array_view(waveforms.view())?,
            "waveforms_lens" => TensorRef::from_array_view(waveforms_lens.view())?,
        ];
        let outputs = self.preprocessor.run(inputs)?;

        let features = outputs.get("features").unwrap().try_extract_array()?;
        let features_lens = outputs.get("features_lens").unwrap().try_extract_array()?;

        Ok((features.to_owned(), features_lens.to_owned()))
    }

    pub fn encode(
        &mut self,
        audio_signal: &ArrayViewD<f32>,
        length: &ArrayViewD<i64>,
    ) -> Result<(ArrayD<f32>, ArrayD<i64>), ParakeetError> {
        log::trace!("Running encoder inference...");
        let inputs = inputs![
            "audio_signal" => TensorRef::from_array_view(audio_signal.view())?,
            "length" => TensorRef::from_array_view(length.view())?,
        ];
        let outputs = self.encoder.run(inputs)?;

        let encoder_output = outputs.get("outputs").unwrap().try_extract_array()?;
        let encoded_lengths = outputs
            .get("encoded_lengths")
            .unwrap()
            .try_extract_array()?;

        let encoder_output = encoder_output.permuted_axes(IxDyn(&[0, 2, 1]));

        Ok((encoder_output.to_owned(), encoded_lengths.to_owned()))
    }

    pub fn create_decoder_state(&self) -> DecoderState {
        // Get input shapes from decoder model
        let inputs = &self.decoder_joint.inputs;

        let state1_shape = inputs
            .iter()
            .find(|input| input.name == "input_states_1")
            .expect("input_states_1 not found")
            .input_type
            .tensor_shape()
            .expect("Failed to get tensor shape for input_states_2");

        let state2_shape = inputs
            .iter()
            .find(|input| input.name == "input_states_2")
            .expect("input_states_2 not found")
            .input_type
            .tensor_shape()
            .expect("Failed to get tensor shape for input_states_2");

        // Create zero states with batch_size=1
        // Shape is [2, -1, 640] so we use [2, 1, 640] for batch_size=1
        let state1 = Array::zeros((
            state1_shape[0] as usize,
            1, // batch_size = 1
            state1_shape[2] as usize,
        ));

        let state2 = Array::zeros((
            state2_shape[0] as usize,
            1, // batch_size = 1
            state2_shape[2] as usize,
        ));

        (state1, state2)
    }

    pub fn decode_step(
        &mut self,
        prev_tokens: &[i32],
        prev_state: DecoderState,
        encoder_out: &ArrayViewD<f32>, // [time_steps, 1024]
        blank_idx: i32,
    ) -> Result<(ArrayD<f32>, DecoderState), ParakeetError> {
        log::trace!("Running decoder inference...");

        // Get last token or blank_idx if empty
        let target_token = prev_tokens.last().copied().unwrap_or(blank_idx);

        // Prepare inputs matching Python: encoder_out[None, :, None] -> [1, time_steps, 1]
        let encoder_outputs = encoder_out
            .to_owned()
            .insert_axis(ndarray::Axis(0))
            .insert_axis(ndarray::Axis(2));
        let targets = Array2::from_shape_vec((1, 1), vec![target_token])?;
        let target_length = Array1::from_vec(vec![1]);

        let inputs = inputs![
            "encoder_outputs" => TensorRef::from_array_view(encoder_outputs.view())?,
            "targets" => TensorRef::from_array_view(targets.view())?,
            "target_length" => TensorRef::from_array_view(target_length.view())?,
            "input_states_1" => TensorRef::from_array_view(prev_state.0.view())?,
            "input_states_2" => TensorRef::from_array_view(prev_state.1.view())?,
        ];

        let outputs = self.decoder_joint.run(inputs)?;

        let logits = outputs.get("outputs").unwrap().try_extract_array()?;
        log::trace!(
            "Logits shape: {:?}, vocab_size: {}",
            logits.shape(),
            self.vocab_size
        );
        let state1 = outputs
            .get("output_states_1")
            .unwrap()
            .try_extract_array()?;
        let state2 = outputs
            .get("output_states_2")
            .unwrap()
            .try_extract_array()?;

        // Squeeze outputs like Python (remove batch dimension)
        let logits = logits.remove_axis(ndarray::Axis(0));

        // Convert ArrayD back to Array3 to match expected return type
        let state1_3d = state1.to_owned().into_dimensionality::<ndarray::Ix3>()?;
        let state2_3d = state2.to_owned().into_dimensionality::<ndarray::Ix3>()?;

        Ok((logits.to_owned(), (state1_3d, state2_3d)))
    }

    pub fn recognize_batch(
        &mut self,
        waveforms: &ArrayViewD<f32>,
        waveforms_len: &ArrayViewD<i64>,
    ) -> Result<Vec<TimestampedResult>, ParakeetError> {
        // Preprocess and encode
        let (features, features_lens) = self.preprocess(waveforms, waveforms_len)?;
        let (encoder_out, encoder_out_lens) =
            self.encode(&features.view(), &features_lens.view())?;

        // Decode for each batch item
        let mut results = Vec::new();
        for (encodings, &encodings_len) in encoder_out.outer_iter().zip(encoder_out_lens.iter()) {
            let (tokens, timestamps) =
                self.decode_sequence(&encodings.view(), encodings_len as usize)?;
            let result = self.decode_tokens(tokens, timestamps);
            results.push(result);
        }

        Ok(results)
    }

    fn decode_sequence(
        &mut self,
        encodings: &ArrayViewD<f32>, // [time_steps, 1024]
        encodings_len: usize,
    ) -> Result<(Vec<i32>, Vec<usize>), ParakeetError> {
        let mut prev_state = self.create_decoder_state();
        let mut tokens = Vec::new();
        let mut timestamps = Vec::new();

        let mut t = 0;
        let mut emitted_tokens = 0;

        while t < encodings_len {
            let encoder_step = encodings.slice(ndarray::s![t, ..]);
            // Convert to dynamic dimension to match decode_step parameter type
            let encoder_step_dyn = encoder_step.to_owned().into_dyn();
            let (probs, new_state) = self.decode_step(
                &tokens,
                prev_state.clone(),
                &encoder_step_dyn.view(),
                self.blank_idx,
            )?;

            // For TDT models, split output into vocab logits and duration logits
            // output[:vocab_size] = vocabulary logits
            // output[vocab_size:] = duration logits
            let vocab_logits = if probs.len() > self.vocab_size {
                // TDT model - extract only vocabulary logits
                log::trace!(
                    "TDT model detected: splitting {} logits into vocab({}) + duration",
                    probs.len(),
                    self.vocab_size
                );
                &probs.as_slice().unwrap()[..self.vocab_size]
            } else {
                // Regular RNN-T model
                probs.as_slice().unwrap()
            };

            // Get argmax token from vocabulary logits only
            let token = vocab_logits
                .iter()
                .enumerate()
                .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
                .map(|(idx, _)| idx as i32)
                .unwrap_or(self.blank_idx);

            if token != self.blank_idx {
                prev_state = new_state;
                tokens.push(token);
                timestamps.push(t);
                emitted_tokens += 1;
            }

            // Step logic from Python - simplified since step is always -1
            if token == self.blank_idx || emitted_tokens == self.max_tokens_per_step {
                t += 1;
                emitted_tokens = 0;
            }
        }

        Ok((tokens, timestamps))
    }

    fn decode_tokens(&self, ids: Vec<i32>, timestamps: Vec<usize>) -> TimestampedResult {
        let tokens: Vec<String> = ids
            .iter()
            .filter_map(|&id| {
                let idx = id as usize;
                if idx < self.vocab.len() {
                    Some(self.vocab[idx].clone())
                } else {
                    None
                }
            })
            .collect();

        let text = self
            .decode_space_pattern
            .replace_all(&tokens.join(""), |caps: &regex::Captures| {
                if caps.get(1).is_some() {
                    " "
                } else {
                    ""
                }
            })
            .to_string();

        let float_timestamps: Vec<f32> = timestamps
            .iter()
            .map(|&t| WINDOW_SIZE * SUBSAMPLING_FACTOR as f32 * t as f32)
            .collect();

        TimestampedResult {
            text,
            timestamps: float_timestamps,
            tokens,
        }
    }

    pub fn transcribe_samples(&mut self, samples: Vec<f32>) -> Result<String, ParakeetError> {
        let batch_size = 1;
        let samples_len = samples.len();

        // Create waveforms array [batch_size, samples_len]
        let waveforms = Array2::from_shape_vec((batch_size, samples_len), samples)?.into_dyn();

        // Create waveforms_lens array [batch_size] with the actual length
        let waveforms_lens = Array1::from_vec(vec![samples_len as i64]).into_dyn();

        // Run recognition
        let results = self.recognize_batch(&waveforms.view(), &waveforms_lens.view())?;

        for (i, result) in results.iter().enumerate() {
            println!("Segment {}:", i);
            for (j, (token, &timestamp)) in result
                .tokens
                .iter()
                .zip(result.timestamps.iter())
                .enumerate()
            {
                let next_timestamp = result.timestamps.get(j + 1).unwrap_or(&timestamp);
                println!(
                    "  {:.2}s - {:.2}s: \"{}\"",
                    timestamp, next_timestamp, token
                );
            }
            println!();
        }

        // Return the transcribed text from the first (and only) result
        Ok(results
            .into_iter()
            .next()
            .map(|r| r.text)
            .unwrap_or_default())
    }
}
