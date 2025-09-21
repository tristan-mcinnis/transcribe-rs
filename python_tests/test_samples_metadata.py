from pathlib import Path
import wave


def test_samples_dots_wav_metadata():
    project_root = Path(__file__).resolve().parents[1]
    wav_path = project_root / "samples" / "dots.wav"
    assert wav_path.exists(), "Expected samples/dots.wav to be present"

    with wave.open(str(wav_path), "rb") as wav_file:
        assert wav_file.getnchannels() == 1
        assert wav_file.getframerate() == 16_000
        assert wav_file.getsampwidth() == 2

