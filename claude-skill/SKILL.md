---
name: llm-icarus
description: Send a prompt or coding task to the user's local LLM Icarus app (models running on their own PC) and get the reply back. Use when the user says to ask, send, or hand something to "Icarus", their local model, or LLM Icarus.
---

# LLM Icarus

LLM Icarus is a desktop app on this computer that runs local models. It listens on `http://127.0.0.1:3210` (this computer only, no password). Prompts you send appear as normal chats in its sidebar, so the user can open and read them.

The app must be open. If it is not, tell the user to open "LLM Icarus" and try again.

## Run the helper

Use `icarus.mjs`, which sits next to this file. Run it with Node. If `node` is not on the PATH, use the copy the app ships:

- Windows: `%LOCALAPPDATA%\Programs\LLM Icarus\runtime\node.exe`
- macOS: `~/Library/Application Support/LLM Icarus/app/runtime/bin/node`

```
node icarus.mjs status                      # is it running, which model is loaded
node icarus.mjs models                      # id, name, size of each chat/code model
node icarus.mjs projects                    # id, name, path of each project
node icarus.mjs ask "question" [--model NAME]                 # plain chat
node icarus.mjs ask "task" --project NAME [--model NAME]      # Code mode: an agent works in that project's folder
node icarus.mjs ask "follow-up" --conversation ID             # continue an earlier chat (id is printed after each reply)
```

`--model` and `--project` accept the id, the exact name, or a unique part of the name. Without `--model` the model that is already loaded is used, so nothing has to be swapped.

## How it behaves

- The command waits until the model has finished, then prints the reply. Run it in the background when the task may take a while, and you will be told when it ends. The default wait limit is 30 minutes (`--timeout MINUTES`).
- Only one request runs at a time (one model, one GPU). Do not start several at once.
- If the app is closed or restarted while a task runs, the command fails with a message saying so. Run it again.
- Code mode can read, edit and (if the user ticked "Allow shell commands" in the app) run commands in the project folder. Say in the prompt when it must not change files, for example "Do not change any files."

## Judging the answers

Local models are much weaker than you. They sometimes invent details, claim a file does not exist without looking, or answer from guesses. For anything that matters, check the reply against the real files before relying on it or repeating it to the user. Keep tasks small and specific, and name the files to read.

## Calling the API directly

If you cannot run Node, `POST http://127.0.0.1:3210/api/tasks` with JSON `{"prompt": "...", "modelId": "...", "projectId": "...", "mode": "chat" | "code", "conversationId": "..."}` (`modelId`, `projectId`, `mode`, `conversationId` optional; Code mode needs `projectId`). The response is `{"conversationId": "...", "reply": "..."}`. `GET /api/models` and `GET /api/projects` list the ids.
