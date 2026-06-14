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
