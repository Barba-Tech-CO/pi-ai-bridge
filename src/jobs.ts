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
      try { closeSync(logFd); } catch { /* already closed */ }
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

  async wait(id: string, timeoutMs: number): Promise<Job> {
    const started = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        const job = this.get(id);
        if (job.status !== "running") return resolve(job);
        if (Date.now() - started > timeoutMs) return resolve(job); // still running on timeout
        setTimeout(tick, 200);
      };
      tick();
    });
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
