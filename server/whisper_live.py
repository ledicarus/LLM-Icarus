"""Keeps Whisper loaded and transcribes short utterances as they arrive (microphone dictation).

Usage: python whisper_live.py --model large-v3

Reads one JSON object per line on stdin:
  {"seq": 1, "file": "<raw 16 kHz mono int16 audio>", "offset": 12.5, "language": "auto" | "en" | ...}
  {"quit": true}
Prints one JSON object per line on stdout:
  {"type": "loading"}  {"type": "ready", "device": "cuda"}
  {"type": "result", "seq": 1, "language": "en", "segments": [{"start": 12.7, "end": 14.0, "text": "..."}]}
  {"type": "error", "seq": 1, "message": "..."}   (seq is missing for errors that stop the whole helper)

The audio files are deleted after they have been read, so no recording is ever kept.
"""
import argparse
import glob
import json
import os
import site
import sys

# On Windows, faster-whisper needs the cuBLAS/cuDNN DLLs that pip installs under site-packages/nvidia
if sys.platform == "win32":
    for sp in site.getsitepackages():
        for d in glob.glob(os.path.join(sp, "nvidia", "*", "bin")):
            os.add_dll_directory(d)
            os.environ["PATH"] = d + os.pathsep + os.environ["PATH"]

from faster_whisper import WhisperModel  # noqa: E402


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def load(name):
    import ctranslate2

    if ctranslate2.get_cuda_device_count() > 0:  # NVIDIA GPU (Windows/Linux)
        try:
            return WhisperModel(name, device="cuda", compute_type="float16"), "cuda"
        except Exception as e:  # missing CUDA libs: fall back to the CPU
            emit({"type": "warning", "message": f"GPU unavailable ({e}); using the CPU, which is slower"})
    return WhisperModel(name, device="cpu", compute_type="int8"), "cpu"


def main():
    import numpy as np

    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="large-v3")
    args = ap.parse_args()

    emit({"type": "loading"})
    model, device = load(args.model)
    # The first transcription is slow (the GPU sets itself up on first use). Do one now on two seconds of silence, so the
    # first thing you say is not the one that waits.
    list(model.transcribe(np.zeros(32000, dtype=np.float32), language="en", beam_size=1, vad_filter=False, without_timestamps=True)[0])
    emit({"type": "ready", "device": device})

    session_language = None  # once the language is known it is kept: short clips are unreliable to detect
    history = ""  # the last few words, to give Whisper context for the next utterance
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        if req.get("quit"):
            break
        seq = req.get("seq")
        try:
            raw = np.fromfile(req["file"], dtype=np.int16)
            try:
                os.remove(req["file"])
            except OSError:
                pass
            audio = raw.astype(np.float32) / 32768.0
            wanted = req.get("language")
            language = None if wanted in (None, "", "auto") else wanted
            if language is None:
                language = session_language
            segments, info = model.transcribe(
                audio,
                language=language,
                beam_size=5,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 500},
                condition_on_previous_text=False,
                initial_prompt=history[-200:] or None,
                no_speech_threshold=0.6,
            )
            out = []
            for seg in segments:
                text = seg.text.strip()
                if text:
                    out.append({"start": round(req.get("offset", 0) + seg.start, 2), "end": round(req.get("offset", 0) + seg.end, 2), "text": text})
            if session_language is None and (wanted in (None, "", "auto")) and out and info.language_probability >= 0.7:
                session_language = info.language
            if out:
                history = (history + " " + " ".join(s["text"] for s in out)).strip()
            emit({"type": "result", "seq": seq, "language": info.language, "segments": out})
        except Exception as e:
            emit({"type": "error", "seq": seq, "message": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        emit({"type": "error", "message": f"{type(e).__name__}: {e}"})
        sys.exit(1)
