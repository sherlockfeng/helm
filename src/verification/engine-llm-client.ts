/**
 * Engine-backed CompletionClient (Run-now fallback).
 *
 * When `~/.helm/benchmark/providers.json` is absent, the Verification
 * runner can still execute using the app's already-configured engine
 * (the same `LlmClient` the summarizer / curation use). This adapter
 * bridges the runner's `CompletionClient` surface onto that
 * `LlmClient.generate(prompt, { model, maxTokens })` contract.
 *
 * The `provider` argument the runner passes is ignored — the engine
 * decides the underlying model/auth itself. The system + user prompts
 * are concatenated into the single prompt the engine accepts.
 *
 * `getLlm` is a getter (not a captured instance) so each call picks up
 * the engine the user currently has selected in Settings, mirroring how
 * the rest of helm reads `engineRouter.current()` lazily.
 */

import type { LlmClient } from '../summarizer/campaign.js';
import type { CompletionClient } from './runner.js';

export function makeEngineCompletionClient(
  getLlm: () => LlmClient,
  model: string,
): CompletionClient {
  return {
    async complete({ systemPrompt, userPrompt, maxOutputTokens }) {
      const prompt = systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt;
      const text = await getLlm().generate(prompt, {
        model,
        maxTokens: maxOutputTokens ?? 1024,
      });
      return { text };
    },
  };
}
