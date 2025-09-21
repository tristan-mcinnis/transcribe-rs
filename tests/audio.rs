use std::error::Error;

use transcribe_rs::audio::read_wav_samples;

#[test]
fn read_wav_samples_normalizes_full_range() -> Result<(), Box<dyn Error>> {
    let temp_dir = tempfile::tempdir()?;
    let wav_path = temp_dir.path().join("extreme.wav");

    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    {
        let mut writer = hound::WavWriter::create(&wav_path, spec)?;
        writer.write_sample(i16::MAX)?;
        writer.write_sample(i16::MIN)?;
        writer.finalize()?;
    }

    let samples = read_wav_samples(&wav_path)?;
    assert_eq!(samples.len(), 2);

    assert_eq!(samples[0], 1.0);
    assert_eq!(samples[1], -1.0);

    Ok(())
}
