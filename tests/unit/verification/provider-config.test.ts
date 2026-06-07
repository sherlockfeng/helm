/**
 * Unit tests for the verification provider config loader (PR 5.3).
 */

import { describe, expect, it } from 'vitest';
import {
  ProviderConfigError,
  resolveProviders,
  validateConfig,
} from '../../../src/verification/provider-config.js';

function fakeModel() {
  return {
    id: 'gpt-4o-mini', api: 'openai-completions',
    provider: 'openai', baseUrl: 'https://api.openai.com/v1',
    contextWindow: 128000, maxTokens: 2048,
  };
}

describe('validateConfig', () => {
  it('accepts the minimal llm-wiki-aligned shape', () => {
    const cfg = validateConfig({
      defaultProvider: 'openai-mini',
      providers: {
        'openai-mini': { model: fakeModel(), apiKeyEnv: 'OPENAI_API_KEY' },
      },
    });
    expect(cfg.defaultProvider).toBe('openai-mini');
  });

  it('rejects a missing providers map', () => {
    expect(() => validateConfig({ defaultProvider: 'x' })).toThrow(ProviderConfigError);
  });

  it('rejects a provider id with invalid characters', () => {
    expect(() => validateConfig({
      defaultProvider: 'has space',
      providers: { 'has space': { model: fakeModel(), apiKeyEnv: 'K' } },
    })).toThrow(/invalid characters/);
  });

  it('rejects a model missing required string fields', () => {
    const bad = { ...fakeModel() } as Record<string, unknown>;
    delete bad['baseUrl'];
    expect(() => validateConfig({
      defaultProvider: 'p',
      providers: { p: { model: bad, apiKeyEnv: 'K' } },
    })).toThrow(/baseUrl/);
  });

  it('rejects when neither apiKey nor apiKeyEnv is set', () => {
    expect(() => validateConfig({
      defaultProvider: 'p',
      providers: { p: { model: fakeModel() } },
    })).toThrow(/apiKey or apiKeyEnv/);
  });

  it('rejects when both apiKey and apiKeyEnv are set', () => {
    expect(() => validateConfig({
      defaultProvider: 'p',
      providers: { p: { model: fakeModel(), apiKey: 'sk-1', apiKeyEnv: 'K' } },
    })).toThrow(/exactly one/);
  });

  it('rejects when answer/judge are not both present and defaultProvider absent', () => {
    expect(() => validateConfig({
      providers: { p: { model: fakeModel(), apiKeyEnv: 'K' } },
      answerProvider: 'p',
    })).toThrow(/either defaultProvider/);
  });

  it('rejects when a named provider does not exist in the providers map', () => {
    expect(() => validateConfig({
      defaultProvider: 'unknown',
      providers: { p: { model: fakeModel(), apiKeyEnv: 'K' } },
    })).toThrow(/unknown provider/);
  });

  it('accepts explicit answer + judge without defaultProvider', () => {
    const cfg = validateConfig({
      answerProvider: 'a', judgeProvider: 'j',
      providers: {
        a: { model: fakeModel(), apiKeyEnv: 'A' },
        j: { model: fakeModel(), apiKeyEnv: 'B' },
      },
    });
    expect(cfg.answerProvider).toBe('a');
    expect(cfg.judgeProvider).toBe('j');
  });
});

describe('resolveProviders', () => {
  const cfg = validateConfig({
    answerProvider: 'a', judgeProvider: 'j',
    providers: {
      a: { model: fakeModel(), apiKeyEnv: 'KEY_A' },
      j: { model: fakeModel(), apiKeyEnv: 'KEY_J' },
    },
  });

  it('returns a hydrated answer + judge pair', () => {
    const out = resolveProviders(cfg, { KEY_A: 'sk-aaa', KEY_J: 'sk-jjj' });
    expect(out.answer.id).toBe('a');
    expect(out.answer.apiKey).toBe('sk-aaa');
    expect(out.judge.id).toBe('j');
    expect(out.judge.apiKey).toBe('sk-jjj');
  });

  it('throws when the resolved env var is empty', () => {
    expect(() => resolveProviders(cfg, { KEY_A: 'sk-aaa' })).toThrow(/KEY_J/);
  });

  it('falls back to defaultProvider on both legs when answer/judge omitted', () => {
    const c2 = validateConfig({
      defaultProvider: 'p',
      providers: { p: { model: fakeModel(), apiKey: 'sk-inline' } },
    });
    const out = resolveProviders(c2, {});
    expect(out.answer.apiKey).toBe('sk-inline');
    expect(out.judge.apiKey).toBe('sk-inline');
    expect(out.answer.id).toBe('p');
  });
});
