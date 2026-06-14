import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Providers, resolveProvider, assertAvailable, PROVIDER_NAMES, type Provider } from "./providers.js";
import { JobManager, type Job, type JobSpec } from "./jobs.js";

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], isError, details: undefined };
}

function formatJob(j: Job): string {
  const code = j.exitCode === undefined ? "" : ` (exit ${j.exitCode})`;
  return `${j.id} [${j.provider}] ${j.status}${code}`;
}

export default function aiBridge(pi: ExtensionAPI): void {
  const jobsDir = join(getAgentDir(), "ai-bridge", "jobs");
  const jobs = new JobManager(jobsDir, (spec: JobSpec) => ({
    bin: Providers.bin(spec.provider as Provider),
    args: Providers.buildArgs(spec.provider as Provider, { prompt: spec.prompt, cwd: spec.cwd, model: spec.model }),
  }));

  function startJob(providerName: string, prompt: string, cwd: string, model: string | undefined): Job {
    const provider = resolveProvider(providerName);
    assertAvailable(provider);
    return jobs.start({ provider, prompt, cwd, model });
  }

  // ─── Tools (LLM-callable) ────────────────────────────────────────
  const defaultWaitMs = 120000;

  pi.registerTool({
    name: "ask_ai",
    label: "Ask AI",
    description:
      "Delegate a task to another AI CLI (claude, codex, or gemini) as a full-autonomy agent that can read and edit files in cwd. " +
      "By default runs in the BACKGROUND and returns a jobId immediately (poll with check_ai). " +
      "For a simple/quick question, pass wait:true to BLOCK until it finishes and get the answer inline on screen.",
    promptGuidelines: [
      "For a quick question or short task where you want the answer now, call ask_ai with wait:true — the output comes back inline, no polling needed.",
      "For long or open-ended work, leave wait off (background): you get a jobId, keep working, and poll check_ai later.",
      "wait blocks up to timeoutMs (default 120000ms); if it times out the job keeps running and you can still check_ai it.",
    ],
    parameters: Type.Object({
      provider: Type.Union(
        [Type.Literal("claude"), Type.Literal("codex"), Type.Literal("gemini")],
        { description: "Which CLI agent to use" },
      ),
      prompt: Type.String({ description: "The task / question for the external agent" }),
      wait: Type.Optional(Type.Boolean({ description: "If true, block until the agent finishes and return its output inline (good for simple tasks). Default false = background." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Max ms to block when wait is true (default 120000). On timeout the job keeps running." })),
      cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the session cwd" })),
      model: Type.Optional(Type.String({ description: "Optional model override for the external CLI" })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx: ExtensionContext) => {
      try {
        const cwd = params.cwd ?? ctx.cwd;
        const job = startJob(params.provider, params.prompt, cwd, params.model);
        if (params.wait) {
          const timeoutMs = params.timeoutMs ?? defaultWaitMs;
          const final = await jobs.wait(job.id, timeoutMs);
          const out = jobs.tail(job.id, 200);
          if (final.status === "running") {
            return text(`Job ${job.id} still running after ${timeoutMs}ms (left in background; use check_ai).\n\n${out || "(no output yet)"}`);
          }
          return text(`[${params.provider}] status=${final.status} exitCode=${final.exitCode ?? "-"}\n\n${out || "(no output)"}`, final.status !== "done");
        }
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
  const helpText = [
    "pi-ai-bridge — delegate to external AI CLIs (claude, codex, gemini).",
    "",
    "  /ask <provider> <prompt>      start a background agent (then /ai-result)",
    "  /ask-wait <provider> <prompt> run and show the output here (blocks)",
    "  /ai-jobs                      list recent/running jobs",
    "  /ai-result [id] [lines]       show a job's status + output (no id = latest job)",
    "  /ai-cancel <id>               cancel a running job",
    "  /ai-help                      this help",
    "",
    `  providers: ${PROVIDER_NAMES.join(", ")}`,
    "  the model can also call these on its own via the ask_ai / check_ai tools.",
  ].join("\n");

  function providerCompletions(prefix: string) {
    const tokens = prefix.trimStart().split(/\s+/).filter(Boolean);
    if (tokens.length <= 1 && !/\s$/.test(prefix)) {
      return PROVIDER_NAMES.filter((p) => p.startsWith(tokens[0] ?? "")).map((p) => ({ value: p, label: p }));
    }
    return null;
  }

  function parseProviderAndPrompt(args: string): { providerName: string; prompt: string } | null {
    const trimmed = args.trim();
    const space = trimmed.indexOf(" ");
    if (space < 0) return null;
    return { providerName: trimmed.slice(0, space), prompt: trimmed.slice(space + 1).trim() };
  }

  pi.registerCommand("ask", {
    description: "Start a background AI agent: /ask <claude|codex|gemini> <prompt> — then view with /ai-result",
    getArgumentCompletions: providerCompletions,
    handler: async (args: string, ctx: ExtensionContext) => {
      const parsed = parseProviderAndPrompt(args);
      if (!parsed || !parsed.prompt) {
        ctx.ui.notify("Usage: /ask <claude|codex|gemini> <prompt>\nExample: /ask gemini summarize README.md\nTip: /ask-wait runs and shows the output here.", "error");
        return;
      }
      try {
        const job = startJob(parsed.providerName, parsed.prompt, ctx.cwd, undefined);
        ctx.ui.notify(`Started ${parsed.providerName} job: ${job.id}\nView output: /ai-result (or /ai-result ${job.id})`, "info");
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  pi.registerCommand("ask-wait", {
    description: "Run an AI agent and show its output here (blocks): /ask-wait <claude|codex|gemini> <prompt>",
    getArgumentCompletions: providerCompletions,
    handler: async (args: string, ctx: ExtensionContext) => {
      const parsed = parseProviderAndPrompt(args);
      if (!parsed || !parsed.prompt) {
        ctx.ui.notify("Usage: /ask-wait <claude|codex|gemini> <prompt>\nExample: /ask-wait claude what does package.json declare?", "error");
        return;
      }
      try {
        const job = startJob(parsed.providerName, parsed.prompt, ctx.cwd, undefined);
        ctx.ui.notify(`Running ${parsed.providerName} (${job.id})…`, "info");
        const final = await jobs.wait(job.id, defaultWaitMs);
        const out = jobs.tail(job.id, 200);
        if (final.status === "running") {
          ctx.ui.notify(`Still running after ${defaultWaitMs}ms — left in background. /ai-result ${job.id}\n\n${out}`, "warning");
          return;
        }
        ctx.ui.notify(`[${parsed.providerName}] ${final.status} (exit ${final.exitCode ?? "-"})\n\n${out || "(no output)"}`, final.status === "done" ? "info" : "error");
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  pi.registerCommand("ai-jobs", {
    description: "List recent and running AI jobs",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const list = jobs.list();
      ctx.ui.notify(list.length ? list.map(formatJob).join("\n") : "No jobs yet. Start one with /ask or /ask-wait.", "info");
    },
  });

  pi.registerCommand("ai-result", {
    description: "Show a job's status + output: /ai-result [id] [lines] — no id uses the latest job",
    handler: async (args: string, ctx: ExtensionContext) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const id = parts[0] ?? jobs.list()[0]?.id;
      const linesStr = parts[0] ? parts[1] : undefined;
      if (!id) {
        ctx.ui.notify("No jobs yet. Start one with /ask or /ask-wait.", "error");
        return;
      }
      try {
        const job = jobs.get(id);
        const out = jobs.tail(id, linesStr ? Number(linesStr) : 200);
        ctx.ui.notify(`${job.id} [${job.provider}] ${job.status} (exit ${job.exitCode ?? "-"})\n\n${out || "(no output yet)"}`, "info");
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  pi.registerCommand("ai-cancel", {
    description: "Cancel a running AI job: /ai-cancel <id> (see ids with /ai-jobs)",
    handler: async (args: string, ctx: ExtensionContext) => {
      const id = args.trim();
      if (!id) {
        ctx.ui.notify("Usage: /ai-cancel <id>\nList ids with /ai-jobs.", "error");
        return;
      }
      try {
        jobs.cancel(id);
        ctx.ui.notify(`Canceled ${id}.`, "info");
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  pi.registerCommand("ai-help", {
    description: "Show pi-ai-bridge commands and providers",
    handler: async (_args: string, ctx: ExtensionContext) => {
      ctx.ui.notify(helpText, "info");
    },
  });
}
