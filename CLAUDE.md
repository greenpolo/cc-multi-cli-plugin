@AGENTS.md

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the current architecture and [README.md](README.md) for usage and installation.

Before changing Claude Code harness UI or extensibility, read
[docs/claude-mods.md](docs/claude-mods.md). Every such change must use Claude
Mods function hooks. Use the existing authenticated `/multi/mod/*` control plane
when gateway data or actions are needed; a local UI change need not change a route.
