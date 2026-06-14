# pi-ai-bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A publishable Pi extension that lets the Pi agent (and the user) delegate work to external AI CLIs (claude, codex, gemini) as background, full-autonomy agents.

**Architecture:** Three modules — `providers.ts` (pure argv building + binary check), `jobs.ts` (detached background process lifecycle with disk-persisted state), `index.ts` (registers LLM tools + slash commands). Background jobs survive Pi restarts because state lives in `~/.pi/agent/ai-bridge/jobs/`.

**Tech Stack:** TypeScript (ESM, `type: module`), TypeBox for tool schemas, Node's built-in test runner via `tsx`, `@earendil-works/pi-coding-agent` (peer dep — verify scope in Task 1).

---

## File Structure

```
pi-ai-bridge/                 # NEW dedicated git repo (NOT under ~/.pi)
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE
├── CHANGELOG.md
├── .gitignore
├── src/
│   ├── providers.ts          # Provider table, argv builder, binary check
│   ├── jobs.ts               # JobManager: spawn/track/cancel background jobs
│   └── index.ts              # Extension entrypoint: tools + commands
└── tests/
    ├── providers.test.ts
    └── jobs.test.ts
```

Decomposition: `providers.ts` and `jobs.ts` are pure Node (no Pi types) → fully unit-testable. `index.ts` is the only file importing Pi types (erased at runtime by jiti), so it stays thin and is verified manually.

---

## Task 1: Scaffold package + confirm runtime contract

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`, `CHANGELOG.md`

- [ ] **Step 1: Create the project dir and git repo**

```bash
mkdir -p "/Volumes/BarbaExt/Projects/NodeJs/pi-ai-bridge" && cd "/Volumes/BarbaExt/Projects/NodeJs/pi-ai-bridge"
git init
```

- [ ] **Step 2: Confirm the runtime contract before coding**

Inspect the installed Pi runtime to lock the import scope and tool result shape:

```bash
ls /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts
grep -nE "registerTool|registerCommand" /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts
```

Expected: `registerTool<...>(tool: ToolDefinition...)` and `registerCommand(name, options)` present. Record the package scope actually resolvable (`@earendil-works/pi-coding-agent`). If the Pi catalog publishes against `@mariozechner/pi-coding-agent`, declare BOTH as peer deps with `*` and import from the one that resolves. Use `@earendil-works/pi-coding-agent` in code by default.

- [ ] **Step 3: Write `package.json`**

```json
{
  "name": "pi-ai-bridge",
  "version": "0.0.1",
  "description": "Pi extension to delegate tasks to external AI CLIs (claude, codex, gemini) as background agents",
  "type": "module",
  "license": "MIT",
  "keywords": ["pi-package", "pi-extension", "pi", "pi-coding-agent", "claude", "codex", "gemini", "cli", "delegation"],
  "files": ["src", "README.md", "LICENSE", "CHANGELOG.md"],
  "scripts": {
    "check": "tsc --noEmit",
    "test": "tsx --test tests/*.test.ts"
  },
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "dependencies": {
    "@sinclair/typebox": "^0.34.0"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "latest",
    "@types/node": "^24.0.0",
    "tsx": "^4.20.0",
    "typescript": "^5.9.0"
  },
  "publishConfig": { "access": "public" }
}
```

- [ ] **Step 4: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 5: Write `.gitignore`, `LICENSE` (MIT), empty `CHANGELOG.md`**

```bash
printf "node_modules\n*.log\n" > .gitignore
printf "# Changelog\n\n## 0.0.1\n- Initial release.\n" > CHANGELOG.md
# LICENSE: standard MIT text with author "barbadz" and year 2026
```

- [ ] **Step 6: Install deps**

```bash
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold pi-ai-bridge package"
```

---

## Task 2: `providers.ts` — provider table + argv builder

**Files:**
- Create: `src/providers.ts`
- Test: `tests/providers.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/providers.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Providers, resolveProvider } from "../src/providers.js";

test("claude argv: headless + skip permissions", () => {
  const argv = Providers.buildArgs("claude", { prompt: "hi", cwd: "/tmp", model: undefined });
  assert.deepEqual(argv, ["-p", "hi", "--dangerously-skip-permissions"]);
});

test("claude argv includes model when provided", () => {
  const argv = Providers.buildArgs("claude", { prompt: "hi", cwd: "/tmp", model: "opus" });
  assert.deepEqual(argv, ["-p", "hi", "--dangerously-skip-permissions", "--model", "opus"]);
});

test("codex argv: exec + bypass + cwd", () => {
  const argv = Providers.buildArgs("codex", { prompt: "do x", cwd: "/repo", model: undefined });
  assert.deepEqual(argv, ["exec", "do x", "--dangerously-bypass-approvals-and-sandbox", "-C", "/repo"]);
});

test("gemini argv: prompt + yolo", () => {
  const argv = Providers.buildArgs("gemini", { prompt: "q", cwd: "/tmp", model: "gemini-2.5-pro" });
  assert.deepEqual(argv, ["-p", "q", "--yolo", "-m", "gemini-2.5-pro"]);
});

test("bin names", () => {
  assert.equal(Providers.bin("claude"), "claude");
  assert.equal(Providers.bin("codex"), "codex");
  assert.equal(Providers.bin("gemini"), "gemini");
});

test("resolveProvider rejects unknown with helpful message", () => {
  assert.throws(() => resolveProvider("gpt"), /Unknown provider "gpt".*claude, codex, gemini/s);
});

test("resolveProvider accepts valid", () => {
  assert.equal(resolveProvider("codex"), "codex");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../src/providers.js`.

- [ ] **Step 3: Write `src/providers.ts`**

```typescript
import { execFileSync } from "node:child_process";

export type Provider = "claude" | "codex" | "gemini";

export const PROVIDER_NAMES: readonly Provider[] = ["claude", "codex", "gemini"] as const;

export interface BuildArgsInput {
  prompt: string;
  cwd: string;
  model: string | undefined;
}

export class Providers {
  static bin(provider: Provider): string {
    // Binary name equals provider name for all current providers.
    return provider;
  }

  static buildArgs(provider: Provider, input: BuildArgsInput): string[] {
    const { prompt, cwd, model } = input;
    switch (provider) {
      case "claude":
        return ["-p", prompt, "--dangerously-skip-permissions", ...(model ? ["--model", model] : [])];
      case "codex":
        return ["exec", prompt, "--dangerously-bypass-approvals-and-sandbox", "-C", cwd, ...(model ? ["-m", model] : [])];
      case "gemini":
        return ["-p", prompt, "--yolo", ...(model ? ["-m", model] : [])];
    }
  }
}

export function resolveProvider(name: string): Provider {
  if ((PROVIDER_NAMES as readonly string[]).includes(name)) {
    return name as Provider;
  }
  throw new Error(`Unknown provider "${name}". Valid providers: ${PROVIDER_NAMES.join(", ")}`);
}

export function assertAvailable(provider: Provider): void {
  const bin = Providers.bin(provider);
  try {
    execFileSync("command", ["-v", bin], { shell: "/bin/sh", stdio: "ignore" });
  } catch {
    throw new Error(`${bin} CLI is not installed or not on PATH. Install it before using provider "${provider}".`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (7 tests in providers).

- [ ] **Step 5: Commit**

```bash
git add src/providers.ts tests/providers.test.ts
git commit -m "feat: provider argv builder and validation"
```

---

## Task 3: `jobs.ts` — background job manager

**Files:**
- Create: `src/jobs.ts`
- Test: `tests/jobs.test.ts`

`JobManager` takes an injectable command resolver so tests can run a fake command instead of a real CLI.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/jobs.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "../src/jobs.js";

function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

test("start -> running -> done, captures output and exit code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aibridge-"));
  const mgr = new JobManager(dir, () => ({ bin: "node", args: ["-e", "console.log('hello'); process.exit(0)"] }));
  const job = mgr.start({ provider: "claude", prompt: "hi", cwd: dir, model: undefined });
  assert.equal(job.status, "running");
  await waitFor(() => mgr.get(job.id).status === "done");
  const done = mgr.get(job.id);
  assert.equal(done.exitCode, 0);
  assert.match(mgr.tail(job.id, 10), /hello/);
  rmSync(dir, { recursive: true, force: true });
});

test("non-zero exit -> failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aibridge-"));
  const mgr = new JobManager(dir, () => ({ bin: "node", args: ["-e", "process.exit(3)"] }));
  const job = mgr.start({ provider: "codex", prompt: "x", cwd: dir, model: undefined });
  await waitFor(() => mgr.get(job.id).status === "failed");
  assert.equal(mgr.get(job.id).exitCode, 3);
  rmSync(dir, { recursive: true, force: true });
});

test("state survives a fresh JobManager (simulated restart)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aibridge-"));
  const mgr = new JobManager(dir, () => ({ bin: "node", args: ["-e", "console.log('x')"] }));
  const job = mgr.start({ provider: "gemini", prompt: "x", cwd: dir, model: undefined });
  await waitFor(() => mgr.get(job.id).status === "done");
  const fresh = new JobManager(dir, () => ({ bin: "node", args: [] }));
  assert.equal(fresh.get(job.id).status, "done");
  assert.equal(fresh.list().length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("cancel marks canceled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aibridge-"));
  const mgr = new JobManager(dir, () => ({ bin: "node", args: ["-e", "setTimeout(()=>{}, 60000)"] }));
  const job = mgr.start({ provider: "claude", prompt: "x", cwd: dir, model: undefined });
  await waitFor(() => mgr.get(job.id).status === "running");
  mgr.cancel(job.id);
  await waitFor(() => mgr.get(job.id).status === "canceled");
  assert.equal(mgr.get(job.id).status, "canceled");
  rmSync(dir, { recursive: true, force: true });
});

test("get/cancel on unknown id throws friendly error", () => {
  const dir = mkdtempSync(join(tmpdir(), "aibridge-"));
  const mgr = new JobManager(dir, () => ({ bin: "node", args: [] }));
  assert.throws(() => mgr.get("nope"), /No job with id "nope"/);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../src/jobs.js`.

- [ ] **Step 3: Write `src/jobs.ts`**

```typescript
import { spawn } from "node:child_process";
import { openSync, closeSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type JobStatus = "running" | "done" | "failed" | "canceled";

export interface JobSpec {
  provider: string;
  prompt: string;
  cwd: string;
  model: string | undefined;
}

export interface Job extends JobSpec {
  id: string;
  pid: number | undefined;
  status: JobStatus;
  startedAt: number;
  endedAt: number | undefined;
  exitCode: number | undefined;
}

export interface ResolvedCommand {
  bin: string;
  args: string[];
}

export type CommandResolver = (spec: JobSpec) => ResolvedCommand;

const MAX_LISTED = 50;

export class JobManager {
  private readonly dir: string;
  private readonly resolve: CommandResolver;

  constructor(jobsDir: string, resolver: CommandResolver) {
    this.dir = jobsDir;
    this.resolve = resolver;
    mkdirSync(this.dir, { recursive: true });
  }

  private jsonPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private logPath(id: string): string {
    return join(this.dir, `${id}.log`);
  }

  private write(job: Job): void {
    writeFileSync(this.jsonPath(job.id), JSON.stringify(job, null, 2));
  }

  start(spec: JobSpec): Job {
    const id = `${spec.provider}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { bin, args } = this.resolve(spec);
    const logFd = openSync(this.logPath(id), "a");
    const child = spawn(bin, args, {
      cwd: spec.cwd,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    const job: Job = {
      ...spec,
      id,
      pid: child.pid,
      status: "running",
      startedAt: Date.now(),
      endedAt: undefined,
      exitCode: undefined,
    };
    this.write(job);

    child.on("error", () => {
      this.finalize(id, "failed", undefined);
      closeSync(logFd);
    });
    child.on("exit", (code) => {
      const status: JobStatus = code === 0 ? "done" : "failed";
      this.finalize(id, status, code === null ? undefined : code);
      try { closeSync(logFd); } catch { /* already closed */ }
    });
    child.unref();
    return job;
  }

  private finalize(id: string, status: JobStatus, exitCode: number | undefined): void {
    if (!existsSync(this.jsonPath(id))) return;
    const job = this.readRaw(id);
    if (job.status === "canceled") return; // cancel wins
    job.status = status;
    job.exitCode = exitCode;
    job.endedAt = Date.now();
    this.write(job);
  }

  private readRaw(id: string): Job {
    const p = this.jsonPath(id);
    if (!existsSync(p)) throw new Error(`No job with id "${id}"`);
    return JSON.parse(readFileSync(p, "utf-8")) as Job;
  }

  get(id: string): Job {
    const job = this.readRaw(id);
    if (job.status === "running" && job.pid !== undefined && !this.isAlive(job.pid)) {
      job.status = "failed";
      job.endedAt = job.endedAt ?? Date.now();
      this.write(job);
    }
    return job;
  }

  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  tail(id: string, lines: number): string {
    const p = this.logPath(id);
    if (!existsSync(p)) return "";
    const all = readFileSync(p, "utf-8").split("\n");
    return all.slice(Math.max(0, all.length - lines)).join("\n").trim();
  }

  list(): Job[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), "utf-8")) as Job)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, MAX_LISTED);
  }

  cancel(id: string): Job {
    const job = this.readRaw(id);
    if (job.status === "running" && job.pid !== undefined) {
      try { process.kill(job.pid); } catch { /* already gone */ }
    }
    job.status = "canceled";
    job.endedAt = Date.now();
    this.write(job);
    return job;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all providers + jobs tests).

- [ ] **Step 5: Commit**

```bash
git add src/jobs.ts tests/jobs.test.ts
git commit -m "feat: background job manager with disk-persisted state"
```

---

## Task 4: `index.ts` — extension entrypoint (tools + commands)

**Files:**
- Create: `src/index.ts`

No automated test (depends on Pi runtime); verified manually in Task 5. Keep it thin — it only wires `providers.ts` + `jobs.ts` to the Pi API.

- [ ] **Step 1: Write `src/index.ts`**

```typescript
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Providers, resolveProvider, assertAvailable, PROVIDER_NAMES, type Provider } from "./providers.js";
import { JobManager, type JobSpec } from "./jobs.js";

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], isError };
}

function formatJob(j: { id: string; provider: string; status: string; exitCode?: number }): string {
  const code = j.exitCode === undefined ? "" : ` (exit ${j.exitCode})`;
  return `${j.id} [${j.provider}] ${j.status}${code}`;
}

export default function aiBridge(pi: ExtensionAPI): void {
  const jobsDir = join(getAgentDir(), "ai-bridge", "jobs");
  const jobs = new JobManager(jobsDir, (spec: JobSpec) => ({
    bin: Providers.bin(spec.provider as Provider),
    args: Providers.buildArgs(spec.provider as Provider, { prompt: spec.prompt, cwd: spec.cwd, model: spec.model }),
  }));

  function startJob(providerName: string, prompt: string, cwd: string, model: string | undefined) {
    const provider = resolveProvider(providerName);
    assertAvailable(provider);
    return jobs.start({ provider, prompt, cwd, model });
  }

  // ─── Tools (LLM-callable) ────────────────────────────────────────
  pi.registerTool({
    name: "ask_ai",
    label: "Ask AI",
    description:
      "Delegate a task to another AI CLI (claude, codex, or gemini) as a background full-autonomy agent. Returns a jobId immediately; poll with check_ai. The external agent can read and edit files in cwd.",
    promptGuidelines: [
      "Use ask_ai to get a second opinion or run an independent subtask in parallel; it does not block.",
      "After ask_ai, continue your own work and poll check_ai for the result instead of waiting idle.",
    ],
    parameters: Type.Object({
      provider: Type.Union(PROVIDER_NAMES.map((p) => Type.Literal(p)), { description: "Which CLI agent to use" }),
      prompt: Type.String({ description: "The task / question for the external agent" }),
      cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the session cwd" })),
      model: Type.Optional(Type.String({ description: "Optional model override for the external CLI" })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx: ExtensionContext) => {
      try {
        const cwd = params.cwd ?? ctx.cwd;
        const job = startJob(params.provider, params.prompt, cwd, params.model);
        return text(`Started ${params.provider} job ${job.id} in ${cwd}. Poll with check_ai({ jobId: "${job.id}" }).`);
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e), true);
      }
    },
  });

  pi.registerTool({
    name: "check_ai",
    label: "Check AI job",
    description: "Check the status and output of a background AI job started with ask_ai.",
    parameters: Type.Object({
      jobId: Type.String(),
      tailLines: Type.Optional(Type.Number({ description: "How many trailing log lines to return (default 200)" })),
    }),
    execute: async (_id, params) => {
      try {
        const job = jobs.get(params.jobId);
        const out = jobs.tail(params.jobId, params.tailLines ?? 200);
        return text(`status=${job.status} exitCode=${job.exitCode ?? "-"}\n\n${out || "(no output yet)"}`);
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e), true);
      }
    },
  });

  pi.registerTool({
    name: "list_ai",
    label: "List AI jobs",
    description: "List recent and running background AI jobs.",
    parameters: Type.Object({}),
    execute: async () => {
      const list = jobs.list();
      return text(list.length ? list.map(formatJob).join("\n") : "No jobs yet.");
    },
  });

  pi.registerTool({
    name: "cancel_ai",
    label: "Cancel AI job",
    description: "Cancel a running background AI job.",
    parameters: Type.Object({ jobId: Type.String() }),
    execute: async (_id, params) => {
      try {
        const job = jobs.cancel(params.jobId);
        return text(`Canceled ${job.id}.`);
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e), true);
      }
    },
  });

  // ─── Slash commands (user-triggered) ─────────────────────────────
  pi.registerCommand("ask", {
    description: "Delegate a task to an external AI CLI: /ask <claude|codex|gemini> <prompt>",
    getArgumentCompletions: (prefix) => {
      const tokens = prefix.trimStart().split(/\s+/).filter(Boolean);
      if (tokens.length <= 1 && !/\s$/.test(prefix)) {
        return PROVIDER_NAMES.filter((p) => p.startsWith(tokens[0] ?? "")).map((p) => ({ value: p, label: p }));
      }
      return null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const space = trimmed.indexOf(" ");
      if (space < 0) {
        ctx.ui.notify("Usage: /ask <claude|codex|gemini> <prompt>", "error");
        return;
      }
      const providerName = trimmed.slice(0, space);
      const prompt = trimmed.slice(space + 1).trim();
      try {
        const job = startJob(providerName, prompt, ctx.cwd, undefined);
        ctx.ui.notify(`Started ${providerName} job ${job.id}. Use /ai-result ${job.id} to see output.`, "info");
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  pi.registerCommand("ai-jobs", {
    description: "List background AI jobs",
    handler: async (_args, ctx) => {
      const list = jobs.list();
      ctx.ui.notify(list.length ? list.map(formatJob).join("\n") : "No jobs yet.", "info");
    },
  });

  pi.registerCommand("ai-result", {
    description: "Show status + output of a job: /ai-result <id> [lines]",
    handler: async (args, ctx) => {
      const [id, linesStr] = args.trim().split(/\s+/);
      if (!id) { ctx.ui.notify("Usage: /ai-result <id> [lines]", "error"); return; }
      try {
        const job = jobs.get(id);
        const out = jobs.tail(id, linesStr ? Number(linesStr) : 200);
        ctx.ui.notify(`status=${job.status} exitCode=${job.exitCode ?? "-"}\n\n${out || "(no output yet)"}`, "info");
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  pi.registerCommand("ai-cancel", {
    description: "Cancel a background AI job: /ai-cancel <id>",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) { ctx.ui.notify("Usage: /ai-cancel <id>", "error"); return; }
      try {
        jobs.cancel(id);
        ctx.ui.notify(`Canceled ${id}.`, "info");
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });
}
```

- [ ] **Step 2: Type-check**

Run: `npm run check`
Expected: PASS. If `getAgentDir`, `ctx.cwd`, the tool result shape, or the `Type.Union(array)` form mismatch the installed types, fix against `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` (these are the only runtime-coupled lines).

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: register ask_ai/check_ai/list_ai/cancel_ai tools and /ask commands"
```

---

## Task 5: Local end-to-end smoke test in Pi

**Files:** none (manual verification)

- [ ] **Step 1: Load the extension from the local checkout**

```bash
cd ~/Documents/projects/pi-ai-bridge
pi -e ./src/index.ts
```

- [ ] **Step 2: Manual checks inside Pi**

- Run `/ask gemini say hello in one word` → expect a job id notification.
- Run `/ai-jobs` → expect the job listed as `running` then `done`.
- Run `/ai-result <id>` → expect the model's output in the log tail.
- Ask the Pi model: "use the ask_ai tool to have codex summarize README.md" → expect a tool call returning a job id, then check_ai returning output.
- Run `/ask gpt hi` → expect the friendly "Unknown provider" error.

- [ ] **Step 3: Verify state dir**

```bash
ls ~/.pi/agent/ai-bridge/jobs/
```

Expected: `<id>.json` and `<id>.log` files present.

---

## Task 6: README + publish + internal install

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

Include: what it does; the four tools and four commands; the **safety warning** (yolo + background + edit runs external agents unattended with full permissions in cwd — use in trusted repos only); install (`pi install npm:pi-ai-bridge`); provider table; local-dev instructions (`pi -e ./src/index.ts`).

- [ ] **Step 2: Final verification before publish**

```bash
npm run check && npm test && npm pack --dry-run
```

Expected: type-check passes, all tests pass, pack lists `src/`, `README.md`, `LICENSE`, `CHANGELOG.md`.

- [ ] **Step 3: Commit + tag**

```bash
git add -A && git commit -m "docs: README with usage and safety warning"
git tag v0.0.1
```

- [ ] **Step 4: Publish to the catalog**

```bash
npm publish
```

Expected: `pi-ai-bridge@0.0.1` published. (Requires `npm login`.)

- [ ] **Step 5: Install for internal use**

```bash
pi install npm:pi-ai-bridge
```

Expected: `"npm:pi-ai-bridge"` added to `~/.pi/agent/settings.json` `packages`. Restart Pi; confirm `ask_ai` tool and `/ask` command are available.

---

## Self-Review Notes

- **Spec coverage:** tool+command (T4), full-agent invocation (T2 argv), background/non-blocking (T3 detached spawn), yolo flags (T2), publishable package (T1, T6), restart-survival (T3 test), error handling (T2/T3/T4), tests (T2/T3), safety docs (T6). All spec sections mapped.
- **Runtime-coupled risk** is isolated to `index.ts` and flagged in T1/T4 with the exact `.d.ts` to check (`getAgentDir`, `ctx.cwd`, tool result shape, `Type.Union` of literals, peer-dep scope).
- **Type consistency:** `JobSpec`/`Job`/`JobStatus`/`CommandResolver` names are consistent across `jobs.ts`, its tests, and `index.ts`; `Providers.bin`/`Providers.buildArgs`/`resolveProvider`/`assertAvailable` consistent across `providers.ts`, tests, and `index.ts`.
