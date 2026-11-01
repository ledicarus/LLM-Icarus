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

## Using it from Claude Code

Windows: tick **Let Claude Code send prompts to LLM Icarus** during setup, or copy the
`claude-skill` folder (next to this file) to `%USERPROFILE%\.claude\skills\llm-icarus`.
macOS: see "READ ME FIRST.txt". After that, ask Claude Code to "send this to Icarus".

## Good to know

- One request runs at a time (one model, one GPU).
- Local models are far weaker than hosted ones and can invent details. Check what matters.
- If the app restarts mid-task the request fails; send it again.
