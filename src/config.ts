/**
 * Helm — 配置加载 / 保存（Phase 0 stub）
 * Schema 详见 PROJECT_BLUEPRINT.md §15。
 *
 * Phase 0 仅提供类型 + 默认值，I/O 留给后续 Phase 在 storage migrations 之后实现。
 */

export interface AppConfig {
  llm: {
    provider: 'anthropic' | 'openai';
    model: string;
    apiKey: string;
    embeddingModel?: string;
  };
  cursor: {
    apiKey: string;
    model: string;
    workspacePath: string;
  };
  spawner: {
    mode: 'sdk' | 'cli';
    fallbackToCli: boolean;
  };
  channels: {
    local: { enabled: true };
    lark: {
      enabled: boolean;
      approvalMode: 'text' | 'card';
      autoCreateThread: boolean;
    };
  };
  approval: {
    timeoutMs: number;
    waitPollMs: number;
    docFirstStrict: boolean;
  };
  ui: {
    autoLaunch: boolean;
    closeToTray: boolean;
    notifications: boolean;
  };
  server: {
    port: number;
  };
  logging: {
    persistEvents: boolean;
    maxEventsPerSession: number;
  };
  knowledge: {
    providers: KnowledgeProviderConfig[];
    sessionContextMaxBytes: number;
    canHandleTotalTimeoutMs: number;
    getContextTimeoutMs: number;
  };
  relay?: {
    backend: 'depscope' | 'cloudflare-tunnel' | 'tailscale' | 'self-hosted';
    config: Record<string, unknown>;
  };
}

export interface KnowledgeProviderConfig {
  id: string;
  enabled: boolean;
  config: ProviderConfig;
}

export interface ProviderConfig {
  /** Provider-specific schema; mappings is the shared field name. */
  mappings?: Array<{ cwdPrefix: string } & Record<string, unknown>>;
  [key: string]: unknown;
}

export function defaultConfig(): AppConfig {
  return {
    llm: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    },
    cursor: {
      apiKey: process.env.CURSOR_API_KEY ?? '',
      model: 'composer-2',
      workspacePath: process.cwd(),
    },
    spawner: {
      mode: 'sdk',
      fallbackToCli: true,
    },
    channels: {
      local: { enabled: true },
      lark: {
        enabled: false,
        approvalMode: 'text',
        autoCreateThread: false,
      },
    },
    approval: {
      timeoutMs: 24 * 60 * 60 * 1000,
      waitPollMs: 10 * 60 * 1000,
      docFirstStrict: false,
    },
    ui: {
      autoLaunch: false,
      closeToTray: true,
      notifications: true,
    },
    server: { port: 17317 },
    logging: {
      persistEvents: true,
      maxEventsPerSession: 1000,
    },
    knowledge: {
      providers: [],
      sessionContextMaxBytes: 8192,
      canHandleTotalTimeoutMs: 200,
      getContextTimeoutMs: 5000,
    },
  };
}

// I/O implementations land in Phase 1 alongside SQLite migrations.
// loadConfig / saveConfig stubs intentionally omitted to avoid dead code.
