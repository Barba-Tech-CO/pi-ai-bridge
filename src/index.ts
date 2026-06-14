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
      provider: Type.Union(
        [Type.Literal("claude"), Type.Literal("codex"), Type.Literal("gemini")],
        { description: "Which CLI agent to use" },
      ),
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
    getArgumentCompletions: (prefix: string) => {
      const tokens = prefix.trimStart().split(/\s+/).filter(Boolean);
      if (tokens.length <= 1 && !/\s$/.test(prefix)) {
        return PROVIDER_NAMES.filter((p) => p.startsWith(tokens[0] ?? "")).map((p) => ({ value: p, label: p }));
      }
      return null;
    },
    handler: async (args: string, ctx: ExtensionContext) => {
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
    handler: async (_args: string, ctx: ExtensionContext) => {
      const list = jobs.list();
      ctx.ui.notify(list.length ? list.map(formatJob).join("\n") : "No jobs yet.", "info");
    },
  });

  pi.registerCommand("ai-result", {
    description: "Show status + output of a job: /ai-result <id> [lines]",
    handler: async (args: string, ctx: ExtensionContext) => {
      const [id, linesStr] = args.trim().split(/\s+/);
      if (!id) {
        ctx.ui.notify("Usage: /ai-result <id> [lines]", "error");
        return;
      }
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
    handler: async (args: string, ctx: ExtensionContext) => {
      const id = args.trim();
      if (!id) {
        ctx.ui.notify("Usage: /ai-cancel <id>", "error");
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
}
