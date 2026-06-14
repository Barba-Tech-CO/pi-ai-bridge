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
