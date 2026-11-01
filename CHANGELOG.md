# Changelog

Newest first. Version numbers are MAJOR.BUILD.M-D-YY: the first number goes up with each published release, the second counts installer builds since then, the third is the build date. Notes for the next installer go
under "Unreleased"; `installer\build-all.ps1` moves them under the new version when it builds.

## Unreleased

## 1.9.11-1-26 (November 1, 2026)

- Files can be dropped into Chat and Code too: text and code files (up to 150 KB each) are read and sent inside your message, each under its file name. Audio, video and pictures point you to the mode that handles them.

## 1.8.11-1-26 (November 1, 2026)

- Transcribe, Image, Vector and 3D now work like Chat: there are no forms to fill in. Drag files into the window (or click the paperclip, or paste a picture), type what you want, and press Send. The app reads your sentence for the details: "in Spanish" for a transcript; "portrait", "1216x832" or "4 images" for pictures; "black and white", "80 mm wide" or "remove the background" for a vector drawing; "40 x 20 x 10 mm" or "80 mm tall" for a 3D part. Several audio files can be dropped at once. Results appear below as before, newest at the bottom, and "Edit this", "Edit with the model" and "Trace this picture again" now fill the box instead of a form. The old screens with every setting are still there under "Advanced options" (and "Back to the simple view" returns), and the microphone button opens the dictation screen.

## 1.7.11-1-26 (November 1, 2026)

- Transcribe can now listen to your microphone. Click "Start listening", pick a microphone if you have several, and speak: Whisper stays loaded and each sentence appears about a second after you pause. A level meter shows the microphone is working, and "Stop" saves the text in the list with .srt and .txt downloads (and a Copy text button). Only the text is kept; the sound is never saved. File transcriptions wait while you are listening, and dictation is refused while a file is being transcribed. Added to the API (`/api/dictate`).

## 1.6.11-1-26 (November 1, 2026)

- New **3D** mode: makes STL files for 3D printing and CAD. Two ways: describe the part (with its overall size and other measurements) and the chat model designs it in OpenSCAD, with a button to open the script, edit it and rebuild; or give outlines from the front, right side and top plus the real dimensions, and a solid is carved at exactly those sizes. A built-in viewer lets you turn the result around, and each result shows its real size, with a warning if a designed part ignores the size you asked for. The 3D tools (OpenSCAD plus carving tools, about 80 MB) are a checkbox in the installers, a button on the 3D screen, and an entry in Settings > Engines. The API gets `POST /api/3d`, and Claude Code gets a `3d` command.

## 1.5.11-1-26 (November 1, 2026)

- New **Vector** mode: makes drawings as SVG and EPS files, for Illustrator, Inkscape, cutters and print shops. Three ways to start: the chat model writes the drawing from a description (and can edit its own earlier drawing), SDXL paints an illustration that is then traced, or you give it a picture to trace exactly. Options for black and white or color, level of detail, removing a white background, and the EPS width in millimetres. The new "vector tools" download is small (about 40 MB) and is a checkbox in the installers, a button on the Vector screen, and an entry in Settings > Engines. The API gets `POST /api/vector` (see API.md).

## 1.4.11-1-26 (November 1, 2026)

- New logo: a realistic engraved-style portrait of Icarus (face, anatomy, long flowing hair, wings) generated with Stable Diffusion XL and made into a badge. It replaces the drawn figure. The busy animation bobs and tilts him gently.

## 1.3.11-1-26 (November 1, 2026)

- Logo: Icarus now has long flowing hair streaming up behind him as he falls, and a more detailed body (shaded muscles, shoulder blades and spine, hands with fingers, feet with toes).

## 1.2.11-1-26 (November 1, 2026)

- Logo redrawn: Icarus himself, plunging toward the sea with his wings swept up behind him, replacing the wing-and-sun emblem. Drawn from scratch for this project. The busy animation flutters the wings and moves the waves.

## 1.1.11-1-26 (November 1, 2026)

- New logo: an original winged-feather-and-sun emblem drawn for this project, replacing the earlier artwork. The animation shown while the app is busy is now an animated PNG that moves the wing and turns the sun's rays.
- Version 1.0.11-1-26 was built but never published; it still contained the earlier logo, so it should not be shared.

## 1.0.11-1-26 (November 1, 2026)

- Built for the first public release but never published. Added a README, removed personal example folder paths from the app, and stopped the source repository from including private working notes.

## 0.2.11-1-26 (November 1, 2026)

Added
- Claude Code skill: lets Claude Code send prompts and coding tasks to LLM Icarus and read the replies. The Windows installer has an optional "Let Claude Code send prompts to LLM Icarus" checkbox (off by default); the Mac zip includes the same files with copy steps in "READ ME FIRST.txt".
- `API.md`: a plain guide to sending prompts to the app from other programs.
- Chats started from outside the window now appear in the sidebar right away, already named after the prompt.
- The sidebar logo animates while a prompt sent from outside the window is running.

Changed
- New version numbering (this file, `build-all.ps1`). The Mac app now shows its real version number.

## 0.1.0 (October 31 to November 1, 2026)

First working build.

- Chat, Code, Transcribe and Image modes in a desktop window (Windows, WebView2), with its own taskbar icon and a single running copy.
- Bundled llama.cpp engine (CUDA, Vulkan or CPU) downloaded on first use; no Ollama needed.
- Code mode runs the Claude Code agent against the local model, with guidance that reduces made-up answers.
- Transcribe with Whisper (faster-whisper) and Image generation with SDXL (diffusers), each in a private Python that does not touch the rest of the system.
- Add models by dropdown, file path, Hugging Face or GitHub link, or by importing from Ollama.
- Projects and chats in separate sidebar lists; right-click to browse a project folder or remove a project or chat; "+" to add a project folder; the sidebar can be collapsed and resized.
- Settings dialog with Project folders, Models and Engines tabs, each with "Check for updates".
- Reopens the chat and project you had open at the last start.
- HTTP API (`/api/tasks`) so other programs can hand the app a prompt.
- Windows installer with optional downloaded components, and a macOS package (written on Windows, never run on a Mac).
- LLM Icarus logo and blue theme.
