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
