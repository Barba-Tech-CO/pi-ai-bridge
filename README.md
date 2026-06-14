# pi-ai-bridge

A [Pi](https://github.com/earendil-works/pi) extension that lets the Pi agent —
and you — delegate work to other AI CLIs (**claude**, **codex**, **gemini**) as
**background, full-autonomy agents**. The Pi model can call them on its own when
useful, or you can trigger them with slash commands.

## ⚠️ Safety warning

Calls run with **full autonomy (yolo)** and **in the background**, and the
external agent **can read and edit files / run commands** in the working
directory:

- `claude -p … --dangerously-skip-permissions`
- `codex exec … --dangerously-bypass-approvals-and-sandbox -C <cwd>`
- `gemini -p … --yolo`

Use it only in repositories you trust. The working directory is always explicit
(defaults to the session cwd), so the blast radius is that directory.

## Install

```bash
pi install npm:pi-ai-bridge
```

This adds `"npm:pi-ai-bridge"` to `~/.pi/agent/settings.json` `packages`.
Restart Pi to load it.

## Tools (the model calls these)

| Tool | Purpose |
|---|---|
| `ask_ai({ provider, prompt, wait?, timeoutMs?, cwd?, model? })` | Start an agent. Background by default (returns a `jobId`); pass `wait: true` to block and return the output inline. |
| `check_ai({ jobId, tailLines? })` | Status + output tail of a job. |
| `list_ai()` | Recent / running jobs. |
| `cancel_ai({ jobId })` | Kill a running job. |

## Slash commands (you trigger these)

```text
/ask <claude|codex|gemini> <prompt>        start a background agent
/ask-wait <claude|codex|gemini> <prompt>   run and show the output here (blocks)
/ai-jobs                                   list jobs
/ai-result [id] [lines]                    show status + output (no id = latest job)
/ai-cancel <id>                            cancel a job
/ai-help                                   list commands and providers
```

## Providers

| Provider | Binary | Invocation |
|---|---|---|
| claude | `claude` | `claude -p <prompt> --dangerously-skip-permissions [--model <m>]` |
| codex | `codex` | `codex exec <prompt> --dangerously-bypass-approvals-and-sandbox -C <cwd> [-m <m>]` |
| gemini | `gemini` | `gemini -p <prompt> --yolo [-m <m>]` |

The matching CLI must be installed and on your `PATH`.

## Job state

Background jobs are tracked in `~/.pi/agent/ai-bridge/jobs/` as `<id>.json`
(metadata) and `<id>.log` (combined stdout+stderr). Because jobs are spawned
detached with state on disk, they survive a Pi restart.

## Local development

```bash
npm install
npm run check   # type-check
npm test        # unit tests (providers + jobs)
pi -e ./src/index.ts   # load the extension from this checkout
```

## License

MIT
