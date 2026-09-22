import { readFileSync } from 'node:fs';

// Claude-hosted compatibility only; workflow preferences come from the session.
const instructions = readFileSync(new URL('./instructions.md', import.meta.url), 'utf8').trim();

export function openaiInstructions(runtime: string): string {
  // Claude mixes built-in prose, appended policies and environment in one block.
  // Retain it intact: deleting that block would also delete user/worker restrictions.
  return `${runtime}\n\n# OpenAI provider instructions\n\n${instructions}`;
}
