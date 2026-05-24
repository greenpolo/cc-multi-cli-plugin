/**
 * Build the canonical MCP server list (Exa + Context7) for ACP `session/new`.
 *
 * Without this, ACP agents (Gemini, Cursor, Copilot) start with no tools
 * beyond their built-ins — research-style prompts that ask the agent to "search
 * the web" or "look up library docs" have no way to actually do so.
 *
 * Reads keys from `~/.claude/plugins/cc-multi-cli-plugin/config.json`. Returns
 * an array suitable for the ACP `mcpServers` parameter. Servers whose key is
 * missing are omitted rather than half-configured.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_PATH = path.join(
  os.homedir(),
  ".claude",
  "plugins",
  "cc-multi-cli-plugin",
  "config.json"
);

function readPluginConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * @returns {Array<{name: string, command: string, args: string[], env: Array<{name: string, value: string}>}>}
 */
export function buildStandardMcpServers() {
  const config = readPluginConfig();
  const servers = [];

  // ACP wants env as an array of {name, value} pairs (NOT a Record). The
  // mcpServers settings.json shape is different (object) — don't confuse them.
  // See: https://github.com/agentclientprotocol/agent-client-protocol — protocol/session-setup.mdx
  if (config.exaApiKey) {
    servers.push({
      name: "exa",
      command: "npx",
      args: ["-y", "exa-mcp-server"],
      env: [{ name: "EXA_API_KEY", value: String(config.exaApiKey) }]
    });
  }

  if (config.context7ApiKey) {
    servers.push({
      name: "context7",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      env: [{ name: "CONTEXT7_API_KEY", value: String(config.context7ApiKey) }]
    });
  }

  return servers;
}
