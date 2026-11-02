# Changelog

Newest first. Version numbers are MAJOR.BUILD.M-D-YY: the first number goes up with each published release, the second counts installer builds since then, the third is the build date. Notes for the next installer go
under "Unreleased"; `installer\build-all.ps1` moves them under the new version when it builds.

## Unreleased

## 2.1.11-1-26 (November 1, 2026)

- The version number is shown in small grey text under the app name in the sidebar.
- LLM Icarus can now update itself (Windows installed copy). A couple of seconds after it starts it asks github.com for the newest release and, if there is one, offers it ("Install now" / "Not now") with the release notes. "Install now" downloads the installer in a small window with a progress bar and a Cancel button, checks it against the checksum GitHub publishes, then says the app will restart; pressing OK closes the app, runs the installer quietly (no component downloads, your chats, models and settings are kept) and opens the new version. Anywhere else (the Mac, a source folder, a browser tab) it only points to the release page. Settings > App has "Check for a new version" and a switch to turn the startup check off.

- Closing the window now asks what you want: **Run in background**, **Quit** or **Cancel**. In the background the window closes to an icon in the notification area next to the clock (on Windows 11 it may be under the ^ arrow) and the server keeps running, so Claude Code and other programs can still send prompts. Click the icon to open the window again, or right-click it for Open and Quit. Starting LLM Icarus again while it is in the background also brings the window back. Quit stops the server, as before. Windows only; on the Mac the app still stops when its window closes.

- 3D: long rounded things such as a banana, a carrot, a cucumber or a bone can now be made just by naming them ("a banana", or "a carrot 180 mm long"). The image model draws a few side pictures, the cleanest single object is kept, and a smooth round solid is built along its outline as an STL. With no size given, the chat model says how big one usually is. The picture it used is shown beside the result, with a "Try another picture" button, because image models sometimes draw two objects or an odd pose (several candidates are drawn and the cleanest is kept). The size is the length along the object's own curve. The solid is round in cross-section, so it does not suit flat or branching things, and a carrot's green stem comes out as a thin tail. Also an option on the advanced 3D screen and `3d "a banana" --method sweep` for Claude Code.
- Long jobs no longer fail after 5 minutes: a chat model designing a 3D part or a drawing now streams its answer instead of the app waiting for it in one go (a slow model could take longer than that and the job died with "fetch failed"), and the Claude Code command waits as long as the app does.

## 2.0.11-1-26 (November 1, 2026)

- Published release. Every mode now works like Chat: drag files into the window (or click the paperclip, or paste), type what you want, and press Send. Includes the simple view for Transcribe, Image, Vector and 3D (1.8.11-1-26) and file drop for Chat and Code (1.9.11-1-26).

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
