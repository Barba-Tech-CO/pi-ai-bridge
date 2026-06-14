# Changelog

## 0.2.0
- Styled tool results: `ask_ai`/`check_ai`/`list_ai`/`cancel_ai` now color their
  output by job status via `renderResult` (green = done, red = failed/error,
  yellow = running, dim = canceled) with a bold header.
- "Agents running" widget below the input: shows live count, provider, job id and
  elapsed time for each running agent (like background tasks in Claude Code).

## 0.1.0
- `ask_ai` now supports `wait: true` (and `timeoutMs`) to run synchronously and
  return the external agent's output inline — good for simple/quick tasks.
- New `/ask-wait` command: runs an agent and shows its output in the chat (blocks).
- `/ai-result` with no id now shows the latest job.
- New `/ai-help` command listing all commands and providers.
- Richer command descriptions and usage messages with examples.

## 0.0.1
- Initial release.
