# Changelog

## 0.1.0
- `ask_ai` now supports `wait: true` (and `timeoutMs`) to run synchronously and
  return the external agent's output inline — good for simple/quick tasks.
- New `/ask-wait` command: runs an agent and shows its output in the chat (blocks).
- `/ai-result` with no id now shows the latest job.
- New `/ai-help` command listing all commands and providers.
- Richer command descriptions and usage messages with examples.

## 0.0.1
- Initial release.
