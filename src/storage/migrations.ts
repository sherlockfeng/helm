import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  description: string;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'relay-origin tables: campaigns, cycles, tasks, roles, knowledge_chunks, agent_sessions, doc_audit_log, requirements, capture_sessions',
    up: `
      CREATE TABLE IF NOT EXISTS campaigns (
        id           TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        title        TEXT NOT NULL,
        brief        TEXT,
        status       TEXT NOT NULL DEFAULT 'active',
        started_at   TEXT NOT NULL,
        completed_at TEXT,
        summary      TEXT
      );

      CREATE TABLE IF NOT EXISTS cycles (
        id            TEXT PRIMARY KEY,
        campaign_id   TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        cycle_num     INTEGER NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending',
        product_brief TEXT,
        screenshots   TEXT,
        started_at    TEXT,
        completed_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cycles_campaign ON cycles(campaign_id);

      CREATE TABLE IF NOT EXISTS tasks (
        id              TEXT PRIMARY KEY,
        cycle_id        TEXT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
        role            TEXT NOT NULL,
        title           TEXT NOT NULL,
        description     TEXT,
        acceptance      TEXT,
        e2e_scenarios   TEXT,
        status          TEXT NOT NULL DEFAULT 'pending',
        result          TEXT,
        doc_audit_token TEXT,
        comments        TEXT,
        created_at      TEXT NOT NULL,
        completed_at    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_cycle ON tasks(cycle_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_role  ON tasks(role, status);

      CREATE TABLE IF NOT EXISTS roles (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        doc_path      TEXT,
        is_builtin    INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id          TEXT PRIMARY KEY,
        role_id     TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        source_file TEXT,
        chunk_text  TEXT NOT NULL,
        embedding   BLOB,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_role ON knowledge_chunks(role_id);

      CREATE TABLE IF NOT EXISTS agent_sessions (
        provider    TEXT NOT NULL,
        role_id     TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        session_id  TEXT NOT NULL,
        external_id TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (provider, role_id, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_role ON agent_sessions(role_id);

      CREATE TABLE IF NOT EXISTS doc_audit_log (
        token        TEXT PRIMARY KEY,
        task_id      TEXT,
        file_path    TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS requirements (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        purpose      TEXT,
        context      TEXT NOT NULL,
        summary      TEXT,
        related_docs TEXT,
        changes      TEXT,
        tags         TEXT,
        todos        TEXT,
        project_path TEXT,
        status       TEXT NOT NULL DEFAULT 'draft',
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_requirements_name ON requirements(name);

      CREATE TABLE IF NOT EXISTS capture_sessions (
        id             TEXT PRIMARY KEY,
        requirement_id TEXT,
        phase          TEXT NOT NULL,
        answers        TEXT NOT NULL DEFAULT '{}',
        draft          TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    description: 'helm-new tables: host_sessions, channel_bindings, channel_message_queue, pending_binds, approval_requests, approval_policies, host_event_log',
    up: `
      CREATE TABLE IF NOT EXISTS host_sessions (
        id            TEXT PRIMARY KEY,
        host          TEXT NOT NULL,
        cwd           TEXT,
        composer_mode TEXT,
        campaign_id   TEXT REFERENCES campaigns(id),
        cycle_id      TEXT REFERENCES cycles(id),
        status        TEXT NOT NULL DEFAULT 'active',
        first_seen_at TEXT NOT NULL,
        last_seen_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channel_bindings (
        id              TEXT PRIMARY KEY,
        channel         TEXT NOT NULL,
        host_session_id TEXT NOT NULL REFERENCES host_sessions(id) ON DELETE CASCADE,
        external_chat   TEXT,
        external_thread TEXT,
        external_root   TEXT,
        wait_enabled    INTEGER NOT NULL DEFAULT 1,
        metadata        TEXT,
        created_at      TEXT NOT NULL,
        UNIQUE (channel, external_chat, external_thread)
      );
      CREATE INDEX IF NOT EXISTS idx_bindings_session ON channel_bindings(host_session_id);

      CREATE TABLE IF NOT EXISTS channel_message_queue (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        binding_id  TEXT NOT NULL REFERENCES channel_bindings(id) ON DELETE CASCADE,
        external_id TEXT,
        text        TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_queue_binding ON channel_message_queue(binding_id, consumed_at);

      CREATE TABLE IF NOT EXISTS pending_binds (
        code            TEXT PRIMARY KEY,
        channel         TEXT NOT NULL,
        external_chat   TEXT,
        external_thread TEXT,
        external_root   TEXT,
        expires_at      TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approval_requests (
        id              TEXT PRIMARY KEY,
        host_session_id TEXT REFERENCES host_sessions(id) ON DELETE CASCADE,
        binding_id      TEXT REFERENCES channel_bindings(id) ON DELETE SET NULL,
        tool            TEXT NOT NULL,
        command         TEXT,
        payload         TEXT,
        status          TEXT NOT NULL,
        decided_by      TEXT,
        reason          TEXT,
        created_at      TEXT NOT NULL,
        decided_at      TEXT,
        expires_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_approval_status  ON approval_requests(status);
      CREATE INDEX IF NOT EXISTS idx_approval_session ON approval_requests(host_session_id);

      CREATE TABLE IF NOT EXISTS approval_policies (
        id             TEXT PRIMARY KEY,
        tool           TEXT NOT NULL,
        command_prefix TEXT,
        path_prefix    TEXT,
        tool_scope     INTEGER NOT NULL DEFAULT 0,
        decision       TEXT NOT NULL,
        hits           INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL,
        last_used_at   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_policy_tool ON approval_policies(tool);

      CREATE TABLE IF NOT EXISTS host_event_log (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        host_session_id TEXT NOT NULL REFERENCES host_sessions(id) ON DELETE CASCADE,
        kind            TEXT NOT NULL,
        payload         TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_event_session ON host_event_log(host_session_id, created_at);
    `,
  },
  {
    version: 3,
    description: 'host_sessions.role_id — Phase 25 chat ↔ role binding for sessionStart auto-inject',
    up: `
      ALTER TABLE host_sessions ADD COLUMN role_id TEXT REFERENCES roles(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_host_sessions_role ON host_sessions(role_id) WHERE role_id IS NOT NULL;
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at  TEXT NOT NULL
    );
  `);

  const applied = new Set<number>(
    (db.prepare(`SELECT version FROM schema_migrations ORDER BY version ASC`).all() as { version: number }[])
      .map((r) => r.version),
  );

  const insertMigration = db.prepare(
    `INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)`,
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    db.transaction(() => {
      db.exec(migration.up);
      insertMigration.run(migration.version, migration.description, new Date().toISOString());
    })();
  }
}
