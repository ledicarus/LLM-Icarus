"""Generate images with an SDXL checkpoint (.safetensors) using diffusers.

Usage: python image_helper.py <spec.json>

spec.json: {checkpoint, outdir, prompt, negative, width, height, steps, guidance, seed, count,
            init_image (optional path -> image-to-image), strength}

Prints one JSON object per line on stdout:
  {"type": "loading"}  {"type": "ready", "device": "cuda"}
  {"type": "step", "image": 0, "step": 5, "total": 25}
  {"type": "image", "index": 0, "file": "0.png", "seed": 1234}
  {"type": "done"}   or   {"type": "error", "message": "..."}
"""
import json
import os
import random
import sys


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def main():
    with open(sys.argv[1], encoding="utf-8") as f:
        spec = json.load(f)

    emit({"type": "loading"})
    import torch
    from PIL import Image
    from PIL.PngImagePlugin import PngInfo
    from diffusers import StableDiffusionXLImg2ImgPipeline, StableDiffusionXLPipeline

    if torch.cuda.is_available():
        device = "cuda"  # NVIDIA GPU
    elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        device = "mps"  # Apple Silicon GPU
    else:
        raise RuntimeError("No NVIDIA or Apple GPU is available to PyTorch, so images can't be generated")

    pipe = StableDiffusionXLPipeline.from_single_file(spec["checkpoint"], torch_dtype=torch.float16, use_safetensors=True)
    pipe.to(device)
    if device == "mps":
        pipe.enable_attention_slicing()  # keeps unified-memory use down
    emit({"type": "ready", "device": device})

    init = None
    if spec.get("init_image"):
        pipe = StableDiffusionXLImg2ImgPipeline(**pipe.components)
        init = Image.open(spec["init_image"]).convert("RGB").resize((spec["width"], spec["height"]), Image.LANCZOS)

    os.makedirs(spec["outdir"], exist_ok=True)
    base_seed = spec["seed"] if spec["seed"] >= 0 else random.randint(0, 2**31 - 1)

    for i in range(spec["count"]):
        seed = base_seed + i
        gen = torch.Generator("cpu" if device == "mps" else device).manual_seed(seed)

        def on_step(p, step, _t, kw, i=i):
            emit({"type": "step", "image": i, "step": step + 1, "total": getattr(p, "num_timesteps", spec["steps"])})
            return kw

        kwargs = dict(
            prompt=spec["prompt"],
            negative_prompt=spec.get("negative") or None,
            num_inference_steps=spec["steps"],
            guidance_scale=spec["guidance"],
            generator=gen,
            callback_on_step_end=on_step,
        )
        if init is not None:
            kwargs.update(image=init, strength=spec.get("strength", 0.6))
        else:
            kwargs.update(width=spec["width"], height=spec["height"])

        image = pipe(**kwargs).images[0]
        info = PngInfo()
        info.add_text("prompt", spec["prompt"])
        info.add_text("seed", str(seed))
        name = f"{i}.png"
        image.save(os.path.join(spec["outdir"], name), pnginfo=info)
        emit({"type": "image", "index": i, "file": name, "seed": seed})

    emit({"type": "done"})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        emit({"type": "error", "message": f"{type(e).__name__}: {e}"})
        sys.exit(1)
