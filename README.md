# LLM Icarus

A desktop app for running AI models on your own computer, with no Ollama or other extra app needed.
Everything except the models themselves is included or downloaded for you.

- **Chat** with local models, with saved conversations.
- **Code**: an agent that reads and edits files in a project folder, using the Claude Code CLI pointed at your local model.
- **Transcribe**: speech to text and captions with Whisper (faster-whisper).
- **Image**: image generation with SDXL (diffusers; NVIDIA GPU on Windows, Apple Silicon on Mac).
- Add models by link (Hugging Face or GitHub), file path, or import them from Ollama.
- An HTTP API so other programs, including Claude Code, can hand it prompts: see [API.md](API.md).

Chat and Code run on a bundled [llama.cpp](https://github.com/ggml-org/llama.cpp) engine that the app downloads on first use
(CUDA, Vulkan, CPU or Metal, chosen for your hardware).

## Status

Early (version 1.0). Developed and tested on Windows 11 with an NVIDIA GPU. The macOS package is
written but has **not yet been run on a Mac**; see [TESTING-MAC.md](TESTING-MAC.md) if you can help test it.

## Install

- **Windows:** run `LLM-Icarus-Setup-<version>.exe` (per-user, no administrator needed). The wizard offers to download
  the engine, Whisper, image tools and a starter model.
- **macOS:** unzip `LLM-Icarus-macOS-<version>.zip` and open `Install LLM Icarus.command` (see "READ ME FIRST.txt").

Installers are built from this source; see below.

## Run from source

Needs Node.js 20 or newer. There are no npm dependencies.

```
node server/index.js
```

then open http://127.0.0.1:3210. (`start.ps1` / `start.cmd` do the same in a window on Windows.)

## Build the installers

Windows installer (needs [Inno Setup 6](https://jrsoftware.org/isinfo.php) and the .NET Framework compiler that ships with Windows):

```
powershell -ExecutionPolicy Bypass -File installer\build-all.ps1
```

This also raises the version number and builds the macOS zip. Add `-Release` for a build that is being published.
Versions look like `MAJOR.BUILD.M-D-YY`; see [CHANGELOG.md](CHANGELOG.md).

## Privacy

The app's server listens only on `127.0.0.1` and checks the Host and Origin of every request. Models, chats and
generated files stay on your computer. It connects to the internet only to download engines, packages and models you ask for,
and to check for updates when you click "Check for updates".

## Licenses

LLM Icarus's code is released under the [MIT License](LICENSE). The logo's engraving (`assets/icarus-engraving.png`) was generated with Stable Diffusion XL, which is how this app generates images, and made into a badge for this project. It is not based on any existing logo, but AI-generated images may not be protected by copyright, so don't assume the logo is reserved for this project. Third-party components and the models you download have their own licenses: see [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
