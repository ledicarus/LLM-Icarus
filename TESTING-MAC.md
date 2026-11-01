# Testing LLM Icarus on macOS

The Mac version was written on a Windows PC and **has never been run on a Mac**. Expect some things
to need fixing. This page tells the tester what to try and what to send back.

**You need:** a Mac (Apple Silicon M1 or newer is best; 16 GB memory or more is best), an internet
connection, and ideally Google Chrome installed (the app opens in a Chrome app-style window).
Plan for 10 to 20 GB of free disk space for a full install.

## 1. Install

1. Unzip `LLM-Icarus-macOS-<version>.zip`.
2. Right-click **Install LLM Icarus.command**, choose **Open**, then **Open** again (it is unsigned,
   so macOS warns about an unidentified developer). Or in Terminal: `bash "Install LLM Icarus.command"`.
3. Accept the suggested choices (press Enter). Note anything that looks wrong or fails.

Installed files:
- Program: `~/Library/Application Support/LLM Icarus/app`
- Data (models, chats, logs): `~/Library/Application Support/LLM Icarus/data`
- Launcher: `~/Applications/LLM Icarus.app`

## 2. Environment check

Paste the output into your report:

```bash
"$HOME/Library/Application Support/LLM Icarus/app/runtime/bin/node" "$HOME/Library/Application Support/LLM Icarus/app/server/selftest.js"
```

It should show your chip (`darwin / arm64`), engine build `metal`, a llama.cpp `...macos-arm64.tar.gz`
download and a Python `...apple-darwin-install_only.tar.gz` download. Any "NONE FOUND" is a bug.

## 3. Checklist

Mark each as works / broken / not tried, and write what happened.

| # | Test | Expected |
|---|------|----------|
| 1 | Open **LLM Icarus** from `~/Applications` | A window titled "LLM Icarus" with the logo, no tabs or address bar |
| 2 | Sidebar button (the three-line button, top left) | Hides and shows the sidebar; narrow the window and it floats over the chat |
| 3 | **Chat** mode: pick the starter model, send "Say hello in five words" | Streams a reply; the logo animates while it thinks, then stops |
| 4 | **Settings** (bottom of the sidebar) | A window with tabs: Project folders, Models, Engines. Models lists models and "Add a model" accepts a Hugging Face link; Engines shows the engine version |
| 4a | Settings > Project folders: click **Browse...** | A Finder-style "choose a folder" window opens; the chosen path appears in the box; **Add** lists it and its subfolders appear as projects |
| 4b | The **+** next to "All projects" | Same folder window; the chosen folder becomes a project |
| 4c | Right-click a project > **Browse** | Opens that folder in Finder |
| 4d | Drag the right edge of the sidebar | The sidebar resizes (double-click the edge to reset) |
| 5 | **Transcribe** mode: drag a short voice recording (.m4a/.mp3/.wav) onto the window (or click the paperclip), type "in English" and press Send | A chip shows the file, then progress, then text and downloadable .srt/.txt. Note how long it took |
| 5a | **Transcribe** mode, the microphone button, then "Start listening": allow the microphone when the browser asks, say two sentences with a pause between | Each sentence appears about a second after you stop; "Stop" saves it in the list. If the browser blocks the microphone, note the message shown |
| 5b | **Vector** mode: drag any photo or drawing onto the window and press Send | A drawing appears with Save SVG and Save EPS buttons. If the vector tools are missing, the screen offers to install them (about 40 MB) |
| 5c | **3D** mode: install the 3D tools if asked (OpenSCAD 2021.01 is an Intel build; on Apple Silicon it needs Rosetta), then type "a cube with a round hole through it, 40 x 40 x 40 mm" and press Send | A solid appears; "View in 3D" opens a viewer you can turn. If OpenSCAD will not start, note the message |
| 6 | **Image** mode (Apple Silicon only; needs the SDXL model, 7 GB, from the Models dialog or `Download components.command`) | A picture appears. Try 768x768 first. Note the time and any memory warnings |
| 7 | **Code** mode | Needs the Claude Code CLI at `~/.local/bin/claude`; skip if you do not have it |
| 8 | Close the window | The server stops (check: `curl http://127.0.0.1:3210/api/settings` should fail) |
| 9 | Open the app again | Starts quickly; your chats are still there |
| 10 | Run `Download components.command` (in the Support folder) | Menu asks about each part |
| 11 | Run `Uninstall LLM Icarus.command` (in the Support folder) | Removes the app; asks before deleting data |

## 4. What to send back

- The `selftest.js` output (section 2)
- Mac model, chip, memory, macOS version
- For anything broken: what you did, what you expected, what happened, and a screenshot
- These log files if they exist (attach them):
  - `~/Library/Application Support/LLM Icarus/data/server.log`
  - `~/Library/Application Support/LLM Icarus/data/crash.log`
  - `~/Library/Application Support/LLM Icarus/data/engine/llama-server.log`

## 5. Known risks (where problems are most likely)

- The downloaded llama.cpp binaries are unsigned; macOS may block them the first time. If the engine
  will not start, try: `xattr -dr com.apple.quarantine "$HOME/Library/Application Support/LLM Icarus/data/engine"`.
- Chrome's app-window launch (`open -n -W -a "Google Chrome" --args --app=...`) is untested on a real Mac.
- Image generation on the Apple GPU (fp16 SDXL) is untested; it may need a smaller size or different settings.
- Whisper runs on the CPU (the "turbo" model); long videos will be slow.
- Without Chrome, Edge or Brave the app opens in your default browser as a normal tab and keeps running
  until you run `stop.sh` (in the `app` folder).
