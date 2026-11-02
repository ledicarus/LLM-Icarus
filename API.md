# Sending prompts to LLM Icarus from other programs

While LLM Icarus is open, other programs on the **same computer** can hand it prompts and
get the replies back. Nothing is exposed to the network, and the chats show up in the app's
sidebar like any other. If the app is closed, requests fail.

Address: `http://127.0.0.1:3210`

## Quick example

PowerShell:

```powershell
$body = @{ prompt = 'Say hello in five words.' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3210/api/tasks -ContentType 'application/json' -Body $body
```

curl (macOS, or `curl.exe` on Windows):

```
curl -s http://127.0.0.1:3210/api/tasks -H "Content-Type: application/json" -d '{"prompt":"Say hello in five words."}'
```

The reply is `{ "conversationId": "...", "reply": "..." }`. The request stays open until the
model has finished, which can take minutes for coding tasks.

## Options for POST /api/tasks

| Field | Meaning |
| --- | --- |
| `prompt` | Required. What to ask. |
| `modelId` | Which model. Ids come from `GET /api/models`. Defaults to the first model in the list. |
| `mode` | `"chat"` (default) or `"code"`. |
| `projectId` | Required for `"code"`: the project folder the agent works in. Ids come from `GET /api/projects`. |
| `conversationId` | Continue an earlier chat instead of starting a new one. |

In `code` mode the agent can read and edit files in that project (and run commands if
"Allow shell commands" is ticked in the app). Say "Do not change any files" when you only want
an answer.

## Microphone dictation

The Transcribe screen can listen to a microphone. A program can do the same by sending speech as raw audio (16 kHz,
mono, 16-bit signed little-endian, no header), one sentence at a time. Whisper stays loaded between sentences, so each
comes back in about a second.

1. `POST /api/dictate/start` with `{ "language": "auto" | "en" | ... }` loads Whisper and returns `{ "id" }`. Only one session can be open, and it is refused while a file is being transcribed.
2. `POST /api/dictate/<id>/chunk?seq=0&offset=12.5` with the audio as the request body (`Content-Type: application/octet-stream`) returns `{ "text", "segments": [{ "start", "end", "text" }] }`. `seq` counts up from 0 and `offset` is the number of seconds since the session began (used for the caption times). Send one sentence per request, no longer than about 25 seconds.
3. `POST /api/dictate/<id>/stop` ends the session and saves what was heard in the Transcribe list (text and .srt). Sessions that stop sending audio and pinging `GET /api/dictate` for three minutes are ended automatically.

The audio is deleted as soon as Whisper has read it; only the text is kept.

## Vector drawings (SVG and EPS)

`POST /api/vector` makes a drawing and saves it as both SVG and EPS. Add `"wait": true` to hold the request until it is
finished; the reply is `{ "id", "status", "svg", "eps" }`, where `svg` and `eps` are download paths on the same address
(for example `/api/vector/<id>/out.eps`). Without `wait` it answers right away with the job `id`, and `GET /api/vector`
lists the jobs and their status.

| Field | Meaning |
| --- | --- |
| `method` | `"llm"` the chat model writes the SVG from `prompt` (icons, simple shapes); `"sdxl"` SDXL paints a flat illustration from `prompt` and it is traced; `"trace"` trace `reference` exactly. |
| `prompt` | What to draw (for `llm` and `sdxl`). |
| `reference` | Path to a picture on this PC: the picture to trace, or a guide for `sdxl`. |
| `modelId` | Chat model for `llm` (ids from `GET /api/models`). |
| `imageModelId` | SDXL model for `sdxl`. |
| `baseJob` | With `llm`: the id of an earlier drawing to edit; `prompt` then says what to change. |
| `colormode`, `detail` | For `sdxl` and `trace`: `"color"` or `"binary"` (black and white), and detail from 1 (coarse) to 5 (fine). |
| `widthMm` | Optional: scale the EPS to this width in millimetres. |

The vector tools are a small download (about 40 MB): install them from the Vector screen or Settings > Engines.

## 3D solids (STL)

`POST /api/3d` makes an STL file. Add `"wait": true` to hold the request until it is finished; the reply is
`{ "id", "status", "stl", "scad", "picture", "size": [x, y, z], "triangles", "warning" }`, where `stl`, `scad` and `picture` are download paths
(for example `/api/3d/<id>/out.stl`) and `size` is the real size of the result in millimetres. `GET /api/3d` lists the jobs.

| Field | Meaning |
| --- | --- |
| `method` | `"scad"`: the chat model designs the part as an OpenSCAD script from `prompt`; `"photos"`: carve a solid from outlines in `views`; or `"sweep"`: for a long rounded thing (a banana, a carrot, a bone) named in `prompt`, the image model draws a side picture of it and a round solid is swept along that picture's outline. |
| `imageModelId` | For `sweep`: the SDXL model that draws the picture (the first image model if left out). |
| `sizeMm` (with `sweep`) | The object's length in mm, measured along its body (following its curve) from one end to the other; the largest of `x`, `y`, `z` is used. If none is given, `modelId` (a chat model) is asked how big one usually is. |
| `prompt`, `sizeMm`, `sizeText` | For `scad`: what to make, the overall size `{ "x": width, "y": depth, "z": height }` in mm, and other measurements as text ("wall 3 mm, hole 8 mm"). |
| `modelId`, `thinking` | The chat model and whether it should think first (slower, better). |
| `baseJob` | With `scad`: the id of an earlier design to change; `prompt` then says what to change. |
| `code` | With `scad`: an OpenSCAD script to build as it is (no model involved). |
| `views` | For `photos`: `{ "front": path, "side": path, "top": path }` to straight-on outlines on a plain background. `side` is the RIGHT side (front on the left); `top` has the front edge at the bottom. At least one picture; `sizeMm` gives the real size, and any size it leaves out is worked out from the outlines. |
| `quality` | For `photos`: 1 draft, 2 normal, 3 fine. |

The 3D tools (OpenSCAD and the carving tools, about 80 MB) install from the 3D screen or Settings > Engines. `sweep` needs only the image tools and an image model. It draws a few pictures, keeps the cleanest single object (and saves it as `picture`), and the result is round in cross-section, so it suits long, bent or straight shapes and not flat or branching ones. It takes a few minutes on a modest graphics card.

## The app's own version and updates

`GET /api/version` returns `{ "version", "canSelfUpdate" }`. `POST /api/app-update/check` (add `{ "auto": true }` to respect the "check at startup" setting) asks GitHub for the newest release and returns `{ current, latest, newer, notes, page, asset, canSelfUpdate }`. `POST /api/app-update/download` starts downloading the installer (installed Windows copies only; progress arrives as `app-update` events on `/api/events` and in `GET /api/app-update`), and `POST /api/app-update/cancel` stops it. Installing is done by the app window, not the API: it runs the downloaded installer when the user presses OK.

## PC readings

`GET /api/sysmon` returns live readings of this PC: `{ cpu, clockGHz, baseGHz, tempC, ramUsedGB, ramTotalGB, cores, gpu: { name, util, tempC, memUsedMB, memTotalMB, clockMHz, powerW } }` (any reading that is not available is `null`). On Windows it also has `me`: what LLM Icarus itself uses (`{ cpu, ramGB, gpu, vramMB, pids, names }`: its server, model engine, helpers and app window), which is part of the totals above; it is `null` elsewhere. On Windows `gpu.util` is measured like Task Manager (the busiest kind of engine, from the Windows graphics counters), and `cpu` is the average of the last three seconds. Measuring starts on the first request and stops about 20 seconds after the last one. The first reading after a pause can lack the clock and temperature for a couple of seconds.

## Using it from Claude Code

Windows: tick **Let Claude Code send prompts to LLM Icarus** during setup, or copy the
`claude-skill` folder (next to this file) to `%USERPROFILE%\.claude\skills\llm-icarus`.
macOS: see "READ ME FIRST.txt". After that, ask Claude Code to "send this to Icarus".

## Good to know

- One request runs at a time (one model, one GPU).
- Local models are far weaker than hosted ones and can invent details. Check what matters.
- If the app restarts mid-task the request fails; send it again.
