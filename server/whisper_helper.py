"""Transcribe one audio/video file with faster-whisper.

Usage: python whisper_helper.py <input> <outdir> [--model large-v3] [--language auto|en|...]

Prints one JSON object per line on stdout so the Node server can follow progress:
  {"type": "loading"}
  {"type": "info", "language": "en", "probability": 0.99, "duration": 123.4, "device": "cuda"}
  {"type": "segment", "start": 0.0, "end": 3.2, "text": "...", "percent": 2.6}
  {"type": "done", "segments": 42}
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


def ts(t):
    h = int(t // 3600)
    m = int(t % 3600 // 60)
    s = t % 60
    ms = min(int(round((s - int(s)) * 1000)), 999)
    return f"{h:02d}:{m:02d}:{int(s):02d},{ms:03d}"


def wrap(text, width=42):
    lines, cur = [], ""
    for word in text.split():
        if len(cur) + len(word) + 1 > width and cur:
            lines.append(cur)
            cur = word
        else:
            cur = (cur + " " + word).strip()
    lines.append(cur)
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("outdir")
    ap.add_argument("--model", default="large-v3")
    ap.add_argument("--language", default="auto")
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    base = os.path.splitext(os.path.basename(args.src))[0]

    emit({"type": "loading"})
    import ctranslate2

    model = None
    device = "cpu"
    if ctranslate2.get_cuda_device_count() > 0:  # NVIDIA GPU (Windows/Linux)
        try:
            model = WhisperModel(args.model, device="cuda", compute_type="float16")
            device = "cuda"
        except Exception as e:  # missing CUDA libs: fall back to CPU
            emit({"type": "warning", "message": f"GPU unavailable ({e}); using the CPU, which is slower"})
    if model is None:
        model = WhisperModel(args.model, device="cpu", compute_type="int8")

    language = None if args.language == "auto" else args.language
    segments, info = model.transcribe(
        args.src,
        language=language,
        vad_filter=True,
        condition_on_previous_text=False,
        no_speech_threshold=0.6,
        beam_size=5,
    )
    emit({"type": "info", "language": info.language, "probability": round(info.language_probability, 3),
          "duration": info.duration, "device": device})

    srt_path = os.path.join(args.outdir, base + ".srt")
    txt_path = os.path.join(args.outdir, base + ".txt")
    n = 0
    with open(srt_path, "w", encoding="utf-8") as srt, open(txt_path, "w", encoding="utf-8") as txt:
        for seg in segments:
            text = seg.text.strip()
            if not text:
                continue
            n += 1
            srt.write(f"{n}\n{ts(seg.start)} --> {ts(seg.end)}\n{wrap(text)}\n\n")
            txt.write(text + "\n")
            pct = round(min(100.0, seg.end / info.duration * 100), 1) if info.duration else 0
            emit({"type": "segment", "start": seg.start, "end": seg.end, "text": text, "percent": pct})
    emit({"type": "done", "segments": n, "base": base})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        emit({"type": "error", "message": str(e)})
        sys.exit(1)
