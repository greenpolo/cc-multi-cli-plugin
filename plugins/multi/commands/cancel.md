---
description: Cancel an active background multi-CLI job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/multi-cli-companion.mjs" cancel "$ARGUMENTS"`
