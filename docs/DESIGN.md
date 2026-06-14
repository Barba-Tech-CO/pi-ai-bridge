# pi-ai-bridge — Design Spec

**Date:** 2026-06-14
**Status:** Approved (design), pending implementation
**Author:** barbadz

## Goal

A publishable Pi extension that lets the Pi agent delegate work to other AI
CLIs — **claude**, **codex**, **gemini** — when it decides it's useful, and that
the user can also trigger manually. Calls run as **full agents** (the external
CLI may read and edit files / run commands), in **background** (non-blocking),
with **full autonomy (yolo)** by default. Distributed via the Pi package catalog
(`pi install npm:pi-ai-bridge`) and usable internally from the same package.

## Non-goals

- No streaming of external output into the Pi TUI (background model returns a
  job id; output is fetched on demand).
- No multi-turn conversation state with the external CLI (each call is a fresh
  agent run).
- No provider beyond claude/codex/gemini in v1 (architecture stays open for more).

## Terminology

In Pi, the correct term is **extension** (TypeScript module that registers
tools/commands and subscribes to lifecycle events). "Addon/plugin" is informal.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Trigger | Both an LLM-callable **tool** and a **slash command** |
| Scope | **Full agent** — external CLI can read & edit files / run commands |
| Execution | **Background** (non-blocking); returns a job id, output fetched later |
| Autonomy | **Yolo** by default (auto-approve everything) |
| Distribution | Publishable npm package for the Pi catalog **and** internal use |

## CLI invocation (confirmed against installed binaries)

All run non-interactively, in the chosen working directory, with auto-approval:

| Provider | argv | notes |
|---|---|---|
| claude | `claude -p <prompt> --dangerously-skip-permissions [--model <m>]` | headless print mode |
| codex | `codex exec <prompt> --dangerously-bypass-approvals-and-sandbox -C <cwd> [-m <m>]` | non-interactive exec |
| gemini | `gemini -p <prompt> --yolo [-m <m>]` | headless yolo mode |

Each provider's argv is produced by a single function; adding a provider = one
table entry.

## Architecture

Three focused modules (one responsibility each; matches "1 class/widget per file"
spirit — here, one concern per file):

### `src/providers.ts`
- `type Provider = "claude" | "codex" | "gemini"`.
- `PROVIDERS`: a class with `static` members mapping each provider to:
  - `bin` (binary name),
  - `buildArgs({ prompt, cwd, model }) => string[]`.
- `resolveProvider(name): Provider` — validates, throws a clear error on unknown.
- `assertAvailable(provider)` — checks the binary exists on PATH (`which`-style),
  throws a friendly "X CLI not installed" error.
- Pure/argv logic only — no spawning. This is the unit-tested core.

### `src/jobs.ts`
- `JobManager` class. Owns the lifecycle of background jobs.
- State dir: `~/.pi/agent/ai-bridge/jobs/` with, per job:
  - `<id>.json` — `{ id, provider, prompt, cwd, model, pid, status, startedAt, endedAt, exitCode }`
  - `<id>.log` — combined stdout+stderr.
- `start(spec) => Job` — spawns **detached**, stdio redirected to the log file fd,
  `child.unref()` so it survives a Pi restart; writes initial JSON; on `exit`,
  updates JSON (`status`, `endedAt`, `exitCode`).
- `get(id)` — reads JSON from disk (source of truth across restarts); if status is
  `running`, confirms the pid is still alive (`process.kill(pid, 0)`), else marks
  `failed`.
- `tail(id, lines)` — returns the last N lines of the log.
- `list()` — recent jobs (most recent first), capped (e.g. last 50).
- `cancel(id)` — `process.kill(pid)`, marks `canceled`.
- `status`: `running | done | failed | canceled`.
- Job ids: `${provider}-${Date.now()}-${short-random}`.

### `src/index.ts` — extension entrypoint
`export default function aiBridge(pi: ExtensionAPI)`. Registers:

**Tools (LLM-callable, via `registerTool`, TypeBox schemas):**
- `ask_ai({ provider, prompt, cwd?, model? })` — starts a background job, returns
  `{ jobId, status: "running" }` immediately. `cwd` defaults to the session cwd.
- `check_ai({ jobId, tailLines? })` — `{ status, exitCode, output }` (output =
  tail of the log, default ~200 lines).
- `list_ai({})` — recent/running jobs.
- `cancel_ai({ jobId })` — kills the job.

Tool results use the standard shape: `{ content: [{ type: "text", text }], isError }`.
`promptGuidelines` tell the model: prefer `ask_ai` for second opinions / parallel
work, then poll `check_ai`; jobs are background so don't block waiting.

**Slash commands (user-triggered, via `registerCommand`):**
- `/ask <provider> <prompt…>` — manual start; notifies the job id.
- `/ai-jobs` — list jobs.
- `/ai-result <id> [lines]` — show status + output tail.
- `/ai-cancel <id>` — cancel.
- Tab completion for provider names and subcommands.

## Data flow

```
LLM or user
  -> ask_ai / /ask
    -> providers.buildArgs()  (validate provider + binary)
    -> jobs.start()           (spawn detached, log to file, write state json)
  <- { jobId }                (returns immediately — background)
...later...
  -> check_ai / /ai-result
    -> jobs.get() + jobs.tail()
  <- { status, exitCode, output }
```

## Error handling

- Unknown provider → clear error listing valid providers.
- Binary not on PATH → "claude CLI not installed (see <url>)".
- Spawn failure → job marked `failed`, error captured in log + JSON.
- `check_ai`/`cancel_ai` on unknown id → friendly error.
- Optional per-job `timeoutMs` (default off): a watchdog kills the job and marks
  `failed` with reason `timeout`.
- Never throw raw stack traces at the user; `ctx.ui.notify(msg, "error")` for
  commands, `isError: true` text for tools.

## Safety notes (documented in README)

Yolo + background + edit = the external agent runs unattended with full
permissions in `cwd`. README must state this prominently and recommend running
in trusted repos only. `cwd` is always explicit (defaults to session cwd) so the
blast radius is the project directory.

## Testing

- `providers.test.ts` — argv built correctly per provider, with/without model;
  unknown provider throws; binary-availability check.
- `jobs.test.ts` — state transitions using a fake command (`node -e`/`sleep`/
  `echo`): start→running→done, exit code captured, cancel→canceled, get() across a
  simulated "restart" (fresh JobManager reads disk state), tail returns last lines.
- No network/real-CLI calls in tests.

## Packaging (for the Pi catalog)

Mirror the structure of the installed `pi-effort` package:

```
pi-ai-bridge/
├── package.json      # name, version, type:module, pi.extensions:["./src/index.ts"], peerDeps, keywords, files, license
├── README.md         # usage, safety warning, install
├── LICENSE           # MIT
├── CHANGELOG.md
├── tsconfig.json
├── src/{index,providers,jobs}.ts
└── tests/*.test.ts
```

- `package.json` `pi.extensions: ["./src/index.ts"]`; keywords include
  `pi-package`, `pi-extension`, `pi`.
- **Peer dependency / import source: to confirm at implementation start.** The
  installed runtime resolves `@earendil-works/pi-coding-agent`
  (`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`), while the
  installed `pi-effort` imports `@mariozechner/pi-coding-agent`. Verify which the
  catalog expects and declare that as `peerDependencies` (likely both ecosystems
  are aliased; pick the one the catalog publishes against). Local imports use the
  `.js` extension (e.g. `./providers.js`) as in pi-effort, even though source is
  `.ts` (jiti/ESM resolution).
- Runtime deps (if any) go in `dependencies`, never `devDependencies`.
- Package lives in its **own git repo / directory** (not under `~/.pi`, which is
  not a git repo). Publish with `npm publish`; install for internal use with
  `pi install npm:pi-ai-bridge` (adds `"npm:pi-ai-bridge"` to
  `~/.pi/agent/settings.json` `packages`).

## Open items to resolve during implementation

1. Confirm correct peer-dependency scope (`@earendil-works` vs `@mariozechner`)
   and exact `AgentToolResult` shape from the runtime's published types.
2. Confirm `registerTool` TypeBox import path (`@sinclair/typebox` `Type`) used by
   the runtime.
3. Decide final package name availability on npm (`pi-ai-bridge` vs scoped).
