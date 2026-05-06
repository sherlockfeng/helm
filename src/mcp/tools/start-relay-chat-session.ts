/**
 * MCP tool: start_relay_chat_session
 *
 * Phase 26 (PROJECT_BLUEPRINT.md §25.3 C3). Lets a Cursor agent spawn a sibling
 * Cursor agent against another (or the same) project directory — e.g. the
 * Product role in chat A asking the Dev role's chat B to start working on a
 * cycle.
 *
 * Returns the new agent's `agentId` so the caller can address it via the
 * Cursor SDK or surface it to the user in the Active Chats UI once the next
 * `host_session_start` hook fires.
 */

import type { CursorAgentSpawner, SpawnInput, SpawnResult } from '../../spawner/cursor-spawner.js';

export interface StartRelayChatSessionInput {
  projectPath: string;
  prompt?: string;
  name?: string;
  modelId?: string;
}

export async function startRelayChatSession(
  spawner: CursorAgentSpawner,
  input: StartRelayChatSessionInput,
): Promise<SpawnResult> {
  const spawnInput: SpawnInput = {
    projectPath: input.projectPath,
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.name ? { name: input.name } : {}),
    ...(input.modelId ? { modelId: input.modelId } : {}),
  };
  return spawner.spawn(spawnInput);
}
