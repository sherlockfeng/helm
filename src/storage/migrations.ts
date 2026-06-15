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
  {
    version: 4,
    description: 'host_sessions.first_prompt — Phase 32 capture user opening message for chat label',
    up: `
      ALTER TABLE host_sessions ADD COLUMN first_prompt TEXT;
    `,
  },
  {
    version: 5,
    description: 'pending_binds.label + channel_bindings.label — Phase 36 user annotation from the bind command, carried from pending → consumed binding',
    up: `
      ALTER TABLE pending_binds   ADD COLUMN label TEXT;
      ALTER TABLE channel_bindings ADD COLUMN label TEXT;
    `,
  },
  {
    version: 6,
    description: 'host_session_roles join table — Phase 42: a chat can be bound to multiple expert roles whose system prompts + chunks all get auto-injected at sessionStart',
    up: `
      CREATE TABLE IF NOT EXISTS host_session_roles (
        host_session_id TEXT NOT NULL REFERENCES host_sessions(id) ON DELETE CASCADE,
        role_id         TEXT NOT NULL REFERENCES roles(id)         ON DELETE CASCADE,
        created_at      TEXT NOT NULL,
        PRIMARY KEY (host_session_id, role_id)
      );
      CREATE INDEX IF NOT EXISTS idx_session_roles_session ON host_session_roles(host_session_id);
      CREATE INDEX IF NOT EXISTS idx_session_roles_role    ON host_session_roles(role_id);

      -- Backfill: copy any existing single-role binding from host_sessions.role_id
      -- into the new join table. The role_id column itself stays in place as
      -- harmless dead weight (SQLite DROP COLUMN is awkward on older versions);
      -- nothing reads it after this migration.
      INSERT OR IGNORE INTO host_session_roles (host_session_id, role_id, created_at)
        SELECT id, role_id, last_seen_at FROM host_sessions WHERE role_id IS NOT NULL;
    `,
  },
  {
    version: 7,
    description: 'host_sessions.display_name — Phase 55: user-set chat label, rendered in Active Chats with first_prompt as fallback',
    up: `
      ALTER TABLE host_sessions ADD COLUMN display_name TEXT;
    `,
  },
  {
    version: 8,
    description: 'host_sessions.last_injected_role_ids — Phase 56: track which roleIds were last injected so beforeSubmitPrompt can re-inject when the binding changes mid-chat',
    up: `
      ALTER TABLE host_sessions ADD COLUMN last_injected_role_ids TEXT;
    `,
  },
  {
    version: 9,
    description: 'pending_binds.host_session_id — Phase 64: helm-first bind flow records which chat owns the pending code so the Lark-side `@bot bind <code>` consume handler can stitch the binding without a renderer round-trip',
    up: `
      ALTER TABLE pending_binds ADD COLUMN host_session_id TEXT REFERENCES host_sessions(id) ON DELETE CASCADE;
    `,
  },
  {
    version: 10,
    description: 'Harness toolchain MVP — three tables backing the on-disk .harness/ workflow scaffold: harness_tasks (task.md mirror + DB-side state), harness_archive_cards (structured index over .harness/archive cards for exact-match retrieval), harness_reviews (one row per claude -p review subprocess invocation, holding the report text + base/head SHAs).',
    up: `
      CREATE TABLE IF NOT EXISTS harness_tasks (
        id                    TEXT PRIMARY KEY,
        title                 TEXT NOT NULL,
        current_stage         TEXT NOT NULL DEFAULT 'new_feature',
        project_path          TEXT NOT NULL,
        host_session_id       TEXT REFERENCES host_sessions(id) ON DELETE SET NULL,
        intent_json           TEXT,
        structure_json        TEXT,
        decisions_json        TEXT,
        risks_json            TEXT,
        related_tasks_json    TEXT,
        stage_log_json        TEXT NOT NULL DEFAULT '[]',
        implement_base_commit TEXT,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_harness_tasks_project ON harness_tasks(project_path);
      CREATE INDEX IF NOT EXISTS idx_harness_tasks_stage   ON harness_tasks(current_stage);

      CREATE TABLE IF NOT EXISTS harness_archive_cards (
        task_id            TEXT PRIMARY KEY REFERENCES harness_tasks(id) ON DELETE CASCADE,
        entities_json      TEXT NOT NULL DEFAULT '[]',
        files_touched_json TEXT NOT NULL DEFAULT '[]',
        modules_json       TEXT NOT NULL DEFAULT '[]',
        patterns_json      TEXT NOT NULL DEFAULT '[]',
        downstream_json    TEXT NOT NULL DEFAULT '[]',
        rules_applied_json TEXT NOT NULL DEFAULT '[]',
        one_liner          TEXT NOT NULL DEFAULT '',
        full_doc_pointer   TEXT NOT NULL,
        project_path       TEXT NOT NULL,
        archived_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_harness_archive_project ON harness_archive_cards(project_path);
      CREATE INDEX IF NOT EXISTS idx_harness_archive_at      ON harness_archive_cards(archived_at);

      CREATE TABLE IF NOT EXISTS harness_reviews (
        id            TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL REFERENCES harness_tasks(id) ON DELETE CASCADE,
        status        TEXT NOT NULL DEFAULT 'pending',
        report_text   TEXT,
        base_commit   TEXT,
        head_commit   TEXT,
        error         TEXT,
        spawned_at    TEXT NOT NULL,
        completed_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_harness_reviews_task ON harness_reviews(task_id);
    `,
  },
  {
    version: 11,
    description: 'host_sessions.last_injected_guide_version — Phase 71: per-chat marker for which version of the Helm tool guide was injected. Lets us push a freshened guide to existing chats by bumping the version constant.',
    up: `
      ALTER TABLE host_sessions ADD COLUMN last_injected_guide_version INTEGER;
    `,
  },
  {
    version: 12,
    description:
      'Role-knowledge typing + source lineage (Phase 73). Introduces a `knowledge_sources` table that records each raw-doc ingestion event (Lark URL / local file / inline blob, plus SHA-256 fingerprint for dedup), and extends `knowledge_chunks` with a `source_id` FK + a `kind` discriminator (spec/example/warning/runbook/glossary/other). Cascade delete on knowledge_sources → knowledge_chunks gives us C4A-style "drop a source, all derived chunks vanish" cleanup. '
      + 'CLEAN-SLATE: as part of this migration we DELETE every existing knowledge_chunks row whose source_id IS NULL — which is every row the moment the column is added. This is intentional (Decision §D in the task doc): we trade a one-time loss of trained knowledge for a 100%-traceable knowledge base going forward. Users must re-train roles after this migration lands. Built-in roles are unaffected because they have no chunks (only system prompts).',
    up: `
      CREATE TABLE IF NOT EXISTS knowledge_sources (
        id            TEXT PRIMARY KEY,
        role_id       TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        kind          TEXT NOT NULL,
        origin        TEXT NOT NULL,
        fingerprint   TEXT NOT NULL,
        label         TEXT,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sources_role        ON knowledge_sources(role_id);
      CREATE INDEX IF NOT EXISTS idx_sources_fingerprint ON knowledge_sources(role_id, fingerprint);

      ALTER TABLE knowledge_chunks ADD COLUMN source_id TEXT REFERENCES knowledge_sources(id) ON DELETE CASCADE;
      ALTER TABLE knowledge_chunks ADD COLUMN kind      TEXT NOT NULL DEFAULT 'other';
      CREATE INDEX IF NOT EXISTS idx_chunks_source ON knowledge_chunks(source_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_kind   ON knowledge_chunks(role_id, kind);

      -- Decision §D: clean-slate. Every pre-migration chunk has no source_id
      -- (we just added the column), so this clears the entire chunks table
      -- except for chunks that get re-inserted by application code AFTER
      -- migration runs (i.e. via train_role / update_role with the new
      -- source-aware writer). One-shot data loss; no backfill.
      DELETE FROM knowledge_chunks WHERE source_id IS NULL;
    `,
  },
  {
    version: 13,
    description:
      'Multipath retrieval (Phase 76) — adds two structures alongside the existing cosine index:'
      + ' (1) a SQLite FTS5 virtual table mirroring `knowledge_chunks.chunk_text` for BM25 ranking,'
      + ' kept in sync by triggers on the main table;'
      + ' (2) a `knowledge_chunk_entities` table holding rule-extracted entities (whitelist short-acronyms,'
      + ' >=3 caps, camelCase, URL host/path tail, filename basename) so an "entity match" leg can'
      + ' contribute to RRF fusion. Both structures are populated forward by trainRole/updateRole;'
      + ' the migration backfills BM25 for existing chunks (cheap) but NOT entities (the extractor'
      + ' code lives in TS and migrations only run SQL — the orchestrator runs a one-shot entity'
      + ' backfill at boot when it detects an entity-less role with chunks).',
    up: `
      -- (1) FTS5 virtual table — external-content mode bound to knowledge_chunks.rowid.
      -- unicode61 with remove_diacritics=2 covers ascii + accent stripping; for CJK
      -- the tokenizer falls back to per-character which gives literal-substring
      -- recall but no word segmentation. jieba integration is a follow-up.
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
        chunk_text,
        content = 'knowledge_chunks',
        content_rowid = 'rowid',
        tokenize = 'unicode61 remove_diacritics 2'
      );

      -- Triggers — FTS5 external-content does NOT auto-sync on writes to the
      -- backing table, so we mirror INSERT/UPDATE/DELETE manually. Note that
      -- ON DELETE CASCADE on knowledge_chunks (via knowledge_sources or roles
      -- being dropped) also fires the AFTER DELETE trigger here, so cascading
      -- still cleans the FTS index.
      CREATE TRIGGER IF NOT EXISTS kc_fts_ai AFTER INSERT ON knowledge_chunks BEGIN
        INSERT INTO knowledge_chunks_fts(rowid, chunk_text) VALUES (new.rowid, new.chunk_text);
      END;
      CREATE TRIGGER IF NOT EXISTS kc_fts_ad AFTER DELETE ON knowledge_chunks BEGIN
        INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts, rowid, chunk_text)
        VALUES ('delete', old.rowid, old.chunk_text);
      END;
      CREATE TRIGGER IF NOT EXISTS kc_fts_au AFTER UPDATE ON knowledge_chunks BEGIN
        INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts, rowid, chunk_text)
        VALUES ('delete', old.rowid, old.chunk_text);
        INSERT INTO knowledge_chunks_fts(rowid, chunk_text) VALUES (new.rowid, new.chunk_text);
      END;

      -- Backfill the FTS5 index for any chunks that survived v12. After this
      -- migration runs once, the triggers maintain consistency going forward.
      INSERT INTO knowledge_chunks_fts(rowid, chunk_text)
        SELECT rowid, chunk_text FROM knowledge_chunks;

      -- (2) Entity index. One row per (chunk, entity) pair; same entity may
      -- repeat across chunks. role_id is denormalized so the query path can
      -- filter without joining knowledge_chunks. PK on (chunk_id, entity)
      -- dedups same-entity-twice-in-one-chunk; SELECT DISTINCT not needed.
      CREATE TABLE IF NOT EXISTS knowledge_chunk_entities (
        chunk_id   TEXT NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
        role_id    TEXT NOT NULL REFERENCES roles(id)            ON DELETE CASCADE,
        entity     TEXT NOT NULL,
        weight     REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (chunk_id, entity)
      );
      CREATE INDEX IF NOT EXISTS idx_chunk_entities_role   ON knowledge_chunk_entities(role_id, entity);
      CREATE INDEX IF NOT EXISTS idx_chunk_entities_entity ON knowledge_chunk_entities(entity);
    `,
  },
  {
    version: 14,
    description:
      'Knowledge lifecycle (Phase 77) — adds three columns to knowledge_chunks so'
      + ' the retrieval path can track per-chunk usage and the background sweep can'
      + ' soft-archive cold knowledge:'
      + ' (a) access_count INTEGER — incremented (fire-and-forget) every time the'
      + '     chunk appears in a search result;'
      + ' (b) last_accessed_at TEXT — ISO timestamp of the most recent access (NULL'
      + '     for never-accessed chunks; the decay function treats NULL as createdAt'
      + '     so freshly-trained chunks are not unfairly demoted);'
      + ' (c) archived INTEGER (0/1) — soft-archive flag; archived chunks default'
      + '     OUT of all three retrieval legs (BM25, cosine, entity) but can be'
      + '     opted back in via includeArchived=true on the reader path.'
      + ' Index (role_id, archived) accelerates the "live chunks for this role"'
      + ' read path which is the default for every search call.'
      + ' Decision §10 in the task doc: NO backfill — last_accessed_at stays NULL'
      + ' on existing rows. The decay function handles NULL by substituting'
      + ' createdAt, so existing roles do not see a sudden weight cliff.',
    up: `
      ALTER TABLE knowledge_chunks ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE knowledge_chunks ADD COLUMN last_accessed_at TEXT;
      ALTER TABLE knowledge_chunks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_chunks_role_archived ON knowledge_chunks(role_id, archived);
    `,
  },
  {
    version: 15,
    description:
      'Knowledge-capture candidates (Phase 78) — adds a `knowledge_candidates` table that'
      + ' holds agent-response segments which scored above the capture thresholds against a'
      + ' bound role\'s knowledge base. Each row has its OWN lifecycle (pending → accepted /'
      + ' rejected / expired) independent of `knowledge_chunks`, so the Roles UI can show a'
      + ' "Candidates (N)" tab where the user batches Accept / Reject without ever touching'
      + ' the trained chunks until they decide.'
      + '\n\n'
      + 'Columns:'
      + ' - id: TEXT PK'
      + ' - role_id: FK → roles(id) CASCADE (role gone → candidates gone, audit lost; acceptable)'
      + ' - host_session_id: FK → host_sessions(id) SET NULL (chat closed but candidate survives)'
      + ' - chunk_text: TEXT NOT NULL — the segment we\'d insert on accept'
      + ' - source_segment_index: INTEGER NOT NULL — splitter index within the response'
      + ' - kind: TEXT NOT NULL DEFAULT \'other\' — heuristic kind (fenced → example, else other)'
      + ' - score_entity: REAL NOT NULL — # of entity-overlap hits (≥2 to qualify; stored for UI)'
      + ' - score_cosine: REAL NOT NULL — max cosine vs existing chunks (≥0.6 to qualify)'
      + ' - text_hash: TEXT NOT NULL — sha256(chunk_text) for the dedup gate'
      + ' - status: TEXT NOT NULL DEFAULT \'pending\' — state machine'
      + ' - created_at / decided_at: ISO timestamps; decided_at NULL while pending'
      + '\n\n'
      + 'Indexes:'
      + ' - (role_id, status) — drives Roles tab list query'
      + ' - (host_session_id) — chat-detail back-reference'
      + ' - UNIQUE(role_id, text_hash) WHERE status IN (pending, rejected) — partial unique'
      + '   enforces the §7 dedup rule at the DB layer; a re-insert of the same chunk_text +'
      + '   same role while a pending OR rejected row exists fails with SQLITE_CONSTRAINT,'
      + '   which `writeCandidateIfNew` catches as "already known, skip". Accepted rows are'
      + '   excluded from the partial index so the same text can be re-suggested after the'
      + '   accepted chunk has been deleted from the role.',
    up: `
      CREATE TABLE IF NOT EXISTS knowledge_candidates (
        id                   TEXT PRIMARY KEY,
        role_id              TEXT NOT NULL REFERENCES roles(id)         ON DELETE CASCADE,
        host_session_id      TEXT          REFERENCES host_sessions(id) ON DELETE SET NULL,
        chunk_text           TEXT NOT NULL,
        source_segment_index INTEGER NOT NULL,
        kind                 TEXT NOT NULL DEFAULT 'other',
        score_entity         REAL NOT NULL,
        score_cosine         REAL NOT NULL,
        text_hash            TEXT NOT NULL,
        status               TEXT NOT NULL DEFAULT 'pending',
        created_at           TEXT NOT NULL,
        decided_at           TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_candidates_role_status ON knowledge_candidates(role_id, status);
      CREATE INDEX IF NOT EXISTS idx_candidates_session     ON knowledge_candidates(host_session_id);
      -- Partial unique index: one PENDING-or-REJECTED row per (role, text_hash).
      -- Accepted rows are excluded so a deleted accepted chunk could conceivably
      -- be re-suggested by a future chat (rare; intentional safety valve).
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_candidates_role_hash_pending
        ON knowledge_candidates(role_id, text_hash)
        WHERE status = 'pending' OR status = 'rejected';
    `,
  },
  {
    version: 16,
    description:
      'Plugin-storage + role-subscription (Phase 79). Two additions:'
      + ' (1) `role_subscriptions` — one row per "this role mirrors content from a remote URL".'
      + '     sourceUrl scheme picks which storage plugin handles transport (file:// built-in;'
      + '     tos:// / s3:// / git:// via external plugins). lastEtag is the storage backend\'s'
      + '     opaque change-detection token; lastContentHash is the canonical-JSON sha256 of the'
      + '     last successfully-unpacked bundle (defense-in-depth in case etag is misleading).'
      + '     UNIQUE(role_id) enforces "one source per role" for v1 — multi-source merge is a'
      + '     deliberate cut.'
      + ' (2) `knowledge_candidates.provenance` — new column distinguishing chat-capture (Phase 78)'
      + '     candidates from subscription-pull candidates. Existing rows default to'
      + '     `\'chat_capture\'` (the only thing that wrote to this table before today).',
    up: `
      CREATE TABLE IF NOT EXISTS role_subscriptions (
        id                     TEXT PRIMARY KEY,
        role_id                TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        source_type            TEXT NOT NULL,
        source_url             TEXT NOT NULL,
        last_etag              TEXT,
        last_content_hash      TEXT,
        last_sync_at           TEXT,
        last_error             TEXT,
        sync_interval_minutes  INTEGER NOT NULL DEFAULT 1440,
        auto_apply             INTEGER NOT NULL DEFAULT 0,
        status                 TEXT NOT NULL DEFAULT 'active',
        created_at             TEXT NOT NULL
      );
      -- One subscription per role for v1 (multi-source merge would need
      -- explicit conflict policy; Decision #8 / scope-out item).
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_role_subscriptions_role ON role_subscriptions(role_id);
      -- Sync sweep uses (status, last_sync_at) to find "due" subscriptions.
      CREATE INDEX IF NOT EXISTS idx_role_subscriptions_status_synced ON role_subscriptions(status, last_sync_at);

      ALTER TABLE knowledge_candidates ADD COLUMN provenance TEXT NOT NULL DEFAULT 'chat_capture';
      CREATE INDEX IF NOT EXISTS idx_candidates_provenance ON knowledge_candidates(role_id, provenance);
    `,
  },
  {
    version: 17,
    description:
      'Role version counter (Phase 80 / helm-design PR A). Adds a monotonic'
      + ' `version` column to roles, bumped on every meaningful content change'
      + ' (trainRole / updateRole / deleteChunkById / deleteSource).'
      + ' Foundation for upcoming sync features:'
      + ' - PR B (auto-push to remote) uses version to decide whether the role'
      + '   has changed since the last successful mirror upload.'
      + ' - PR C (version-aware pull) compares local version vs the remote'
      + '   bundle\'s `roleVersion` to detect "remote and local both diverged'
      + '   from last sync" conflicts and gate the apply step.'
      + ' Existing roles get version=1 (the schema default); the first mutation'
      + ' after the migration bumps them to 2.',
    up: `
      ALTER TABLE roles ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    version: 18,
    description:
      'Role mirror config (Phase 80 / helm-design PR B). One row per role'
      + ' that should auto-publish its .helmrole bundle to a remote URL on'
      + ' every meaningful content change.'
      + ' Lifecycle: each mutation path bumps roles.version (PR A); the in-'
      + ' process MirrorRunner debounces N seconds then packs + uploads via the'
      + ' matching storage plugin and writes last_pushed_version + last_pushed_at.'
      + ' A periodic catch-up sweep rescues missed pushes (process restart while'
      + ' a debounce was in flight, plugin/network failure, etc.) by selecting'
      + ' mirrors where last_pushed_version < roles.version.'
      + ' UNIQUE(role_id) enforces "at most one mirror per role" — multi-target'
      + ' fan-out is a deliberate cut (config gets complicated; v1 keeps it'
      + ' simple). Use target_url with a scheme registered in the plugin registry.',
    up: `
      CREATE TABLE IF NOT EXISTS role_mirrors (
        role_id              TEXT PRIMARY KEY REFERENCES roles(id) ON DELETE CASCADE,
        target_url           TEXT NOT NULL,
        enabled              INTEGER NOT NULL DEFAULT 1,
        last_pushed_version  INTEGER,
        last_pushed_etag     TEXT,
        last_pushed_at       TEXT,
        last_error           TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );
      -- Catch-up sweep query: WHERE enabled AND (last_pushed_version IS NULL OR < roles.version).
      -- Index on (enabled, last_pushed_version) keeps the sweep O(N enabled-mirrors)
      -- instead of full-table-scan, though for v1's expected scale (< 100 mirrors)
      -- this is mostly defensive.
      CREATE INDEX IF NOT EXISTS idx_role_mirrors_enabled_version
        ON role_mirrors(enabled, last_pushed_version);
    `,
  },
  {
    version: 19,
    description:
      'Version-aware subscription pull (Phase 80 / helm-design PR C).'
      + ' Adds `role_subscriptions.last_pulled_version` to track what'
      + ' bundle version was successfully applied last. Combined with'
      + ' PR A\'s `roles.version` + PR B\'s bundle.roleVersion, lets the'
      + ' sync engine detect "remote and local both diverged from last'
      + ' sync" conflicts and surface them via a new `conflict` status'
      + ' instead of silently overwriting local edits.'
      + ' 4-case logic in syncOne:'
      + '   remote==pulled, local==pulled → noop (caught by contentHash)'
      + '   remote>pulled, local==pulled  → fast-forward apply'
      + '   remote==pulled, local>pulled  → noop (PR B push handles inverse)'
      + '   remote>pulled, local>pulled   → CONFLICT, status=conflict, no apply'
      + ' Existing rows back-migrate with last_pulled_version=NULL — first'
      + ' subsequent sync apply still goes through (no conflict possible'
      + ' until we have a baseline).',
    up: `
      ALTER TABLE role_subscriptions ADD COLUMN last_pulled_version INTEGER;
    `,
  },
  {
    version: 20,
    description:
      'Conversation-knowledge redesign foundations'
      + ' (docs/design/2026-06-06-conversation-knowledge-redesign.md PR 2).'
      + ' Six concerns merged into one migration so the renderer-side PR'
      + ' that reads against new columns/tables can land in a single rev:'
      + ' (1) knowledge_chunks gains promotion fields — title (h1-or-firstline'
      + ' filled by backfill), source (provenance JSON), lastReferencedAt'
      + ' (Insights decay signal), editVersion (G4 optimistic lock; MCP +'
      + ' Helm UI can race on the same row otherwise), visibility (R-1: chat'
      + ' captures default internal so R-0 publish gate never accidentally'
      + ' leaks them), and version_ext (per-chunk monotonic counter,'
      + ' independent of role-level version from Phase 80 PR A).'
      + ' (2) knowledge_point_alias is a normalized table (was JSON-in-TEXT'
      + ' in design rev 1 → fixed in rev 5 after reviewer flagged it cannot'
      + ' support indexed alias lookup). Lookups go through idx_alias_lookup.'
      + ' (3) knowledge_point_rel: typed graph edges between points'
      + ' (includes / correspondsTo / supersedes). 4.4.2 rel-expansion needs'
      + ' indexed from→to traversal + reverse "who points at me" lookups.'
      + ' (4) knowledge_point_roles is the N..N replacement for the existing'
      + ' 1..1 knowledge_chunks.roleId. The old column STAYS for back-compat'
      + ' so existing reads do not break; new code reads through the join'
      + ' table. Backfill copies the existing single role mapping in.'
      + ' (5) retrieval_log + retrieval_log_points let Conversation Detail'
      + ' (§5.2) show "what knowledge was used in turn N" AND KnowledgePoint'
      + ' Detail (§5.4) show "which conversations used this point". The'
      + ' points table is normalized so the reverse query is cheap.'
      + ' (6) host_sessions.agentKind discriminates Cursor / Claude Code /'
      + ' Codex sessions for the Conversations facet tabs (§5.1). Backfilled'
      + ' from the existing host column where present, NULL otherwise.'
      + ' Backfills: knowledge_point_roles populated from chunks.roleId.'
      + ' Title backfill runs on the renderer side at next boot (lazy; not'
      + ' part of the SQL migration to keep this transactional).',
    up: `
      ALTER TABLE knowledge_chunks ADD COLUMN title TEXT;
      ALTER TABLE knowledge_chunks ADD COLUMN source TEXT;
      ALTER TABLE knowledge_chunks ADD COLUMN last_referenced_at INTEGER;
      ALTER TABLE knowledge_chunks ADD COLUMN edit_version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE knowledge_chunks ADD COLUMN visibility TEXT NOT NULL DEFAULT 'internal';
      ALTER TABLE knowledge_chunks ADD COLUMN version_ext INTEGER NOT NULL DEFAULT 1;

      CREATE TABLE IF NOT EXISTS knowledge_point_alias (
        point_id   TEXT NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
        alias      TEXT NOT NULL,
        source     TEXT NOT NULL DEFAULT 'manual',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (point_id, alias)
      );
      CREATE INDEX IF NOT EXISTS idx_alias_lookup ON knowledge_point_alias(alias);

      -- to_point_id intentionally NOT a strict FK: knowledge edges can
      -- reference points that haven't been imported yet (cross-repo,
      -- cross-role, or external) and the importer should not refuse
      -- those edges. Source-side FK keeps cleanup straightforward —
      -- deleting a point cascades away its outgoing edges.
      CREATE TABLE IF NOT EXISTS knowledge_point_rel (
        from_point_id TEXT NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
        to_point_id   TEXT NOT NULL,
        rel_kind      TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (from_point_id, to_point_id, rel_kind)
      );
      CREATE INDEX IF NOT EXISTS idx_rel_from ON knowledge_point_rel(from_point_id, rel_kind);
      CREATE INDEX IF NOT EXISTS idx_rel_to   ON knowledge_point_rel(to_point_id,   rel_kind);

      CREATE TABLE IF NOT EXISTS knowledge_point_roles (
        point_id TEXT NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
        role_id  TEXT NOT NULL REFERENCES roles(id)            ON DELETE CASCADE,
        PRIMARY KEY (point_id, role_id)
      );
      CREATE INDEX IF NOT EXISTS idx_point_roles_role ON knowledge_point_roles(role_id);

      -- Backfill the N..N join from the existing 1..1 chunks.roleId
      -- column so retrieval code can read through the new table from
      -- day one without losing any existing role assignment.
      --
      -- R-16 retro-fix: the inner JOIN to roles filters out orphan
      -- chunks (rows whose role_id points to a deleted role --
      -- possible if a historical script deleted a role with
      -- foreign_keys=OFF and left chunks behind). Without the JOIN
      -- the FK on knowledge_point_roles.role_id would throw and
      -- abort the migration; INSERT OR IGNORE only swallows PK /
      -- UNIQUE conflicts, not FK violations. Orphans are silently
      -- dropped from the join; the underlying knowledge_chunks rows
      -- are left intact so a future cleanup can audit them.
      INSERT OR IGNORE INTO knowledge_point_roles (point_id, role_id)
        SELECT k.id, k.role_id
          FROM knowledge_chunks k
          JOIN roles r ON r.id = k.role_id
         WHERE k.role_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS retrieval_log (
        id              TEXT PRIMARY KEY,
        host_session_id TEXT NOT NULL,
        turn            INTEGER NOT NULL,
        query_text      TEXT,
        ts              INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_retrieval_log_session_turn
        ON retrieval_log(host_session_id, turn);

      CREATE TABLE IF NOT EXISTS retrieval_log_points (
        log_id        TEXT    NOT NULL REFERENCES retrieval_log(id) ON DELETE CASCADE,
        point_id      TEXT    NOT NULL,
        rank          INTEGER NOT NULL,
        fusion_score  REAL    NOT NULL,
        leg_contrib   TEXT,
        injected      INTEGER NOT NULL,
        PRIMARY KEY (log_id, point_id)
      );
      -- "Which conversations cited point X" is the load-bearing query
      -- for KnowledgePoint Detail's "Used by conversations" panel.
      CREATE INDEX IF NOT EXISTS idx_retrieval_log_point
        ON retrieval_log_points(point_id);

      ALTER TABLE host_sessions ADD COLUMN agent_kind TEXT;
      -- Backfill the discriminator from the existing host column so the
      -- Conversations facet tabs have non-NULL data for legacy rows.
      UPDATE host_sessions SET agent_kind = host WHERE host IS NOT NULL;
    `,
  },
  {
    version: 21,
    description:
      'Verification layer (docs/design/2026-06-06-conversation-knowledge-'
      + 'redesign.md PR 5). Six tables that turn the §4.7 case-proposal +'
      + ' run-and-judge loop into persistent state.'
      + ' benchmark_case carries the question / expected_truth / state'
      + ' machine — proposedSource discriminates manual / llm-on-edit /'
      + ' imported authorship; status (proposed → confirmed → rejected →'
      + ' archived) enforces R-5: only confirmed cases enter regression'
      + ' detection or coverage stats.'
      + ' benchmark_case_golden + benchmark_case_target_role are the'
      + ' normalized N..N joins replacing the JSON-in-TEXT shapes the'
      + ' reviewer flagged in design rev 1 — reverse queries like "which'
      + ' cases use this point as a golden?" now hit an index.'
      + ' benchmark_run holds one row per executed case; the companion'
      + ' benchmark_run_repo_state table pins the (repoUrl, repoSha)'
      + ' tuples that produced the score, so any run is reproducible by'
      + ' anyone with the same repo tree.'
      + ' regression_alert tracks score drops between consecutive runs of'
      + ' the same case (§3.5).'
      + ' benchmark_cost_audit aggregates daily spend per role (NULL ='
      + ' global) for the §4.7.6 cost cap that prevents bulk-accept from'
      + ' burning $$$.',
    up: `
      CREATE TABLE IF NOT EXISTS benchmark_case (
        id                       TEXT PRIMARY KEY,
        name                     TEXT NOT NULL,
        question                 TEXT NOT NULL,
        expected_truth           TEXT NOT NULL,
        agent_kind_hint          TEXT,
        notes                    TEXT,
        source_repo_url          TEXT,
        source_revision          TEXT,
        proposed_source          TEXT NOT NULL DEFAULT 'manual',
        proposed_at              INTEGER NOT NULL,
        proposed_from_point_id   TEXT REFERENCES knowledge_chunks(id) ON DELETE SET NULL,
        proposed_from_event      TEXT,
        proposed_question_hash   TEXT,
        status                   TEXT NOT NULL DEFAULT 'confirmed',
        confirmed_by             TEXT,
        confirmed_at             INTEGER,
        rejected_reason          TEXT,
        created_at               INTEGER NOT NULL,
        updated_at               INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_case_status        ON benchmark_case(status, proposed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_case_proposed_from ON benchmark_case(proposed_from_point_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_case_proposed_hash
        ON benchmark_case(proposed_question_hash) WHERE proposed_question_hash IS NOT NULL;

      CREATE TABLE IF NOT EXISTS benchmark_case_golden (
        case_id  TEXT NOT NULL REFERENCES benchmark_case(id) ON DELETE CASCADE,
        point_id TEXT NOT NULL,  -- intentionally NOT a FK: deleting the
                                 -- point does NOT delete the case spec
        PRIMARY KEY (case_id, point_id)
      );
      CREATE INDEX IF NOT EXISTS idx_case_golden_point ON benchmark_case_golden(point_id);

      CREATE TABLE IF NOT EXISTS benchmark_case_target_role (
        case_id TEXT NOT NULL REFERENCES benchmark_case(id) ON DELETE CASCADE,
        role_id TEXT NOT NULL REFERENCES roles(id)         ON DELETE CASCADE,
        PRIMARY KEY (case_id, role_id)
      );

      CREATE TABLE IF NOT EXISTS benchmark_run (
        id                      TEXT PRIMARY KEY,
        case_id                 TEXT NOT NULL REFERENCES benchmark_case(id) ON DELETE CASCADE,
        run_at                  INTEGER NOT NULL,
        answer_provider_id      TEXT NOT NULL,
        judge_provider_id       TEXT NOT NULL,
        recall_pct              REAL NOT NULL,
        alignment_pct           REAL NOT NULL,
        answer_text             TEXT NOT NULL,
        judge_verdict_text      TEXT NOT NULL,
        judge_verdict_json      TEXT NOT NULL,
        duration_ms             INTEGER NOT NULL,
        estimated_cost_usd      REAL,
        llm_call_count          INTEGER,
        knowledge_state_sha     TEXT NOT NULL,
        is_reproducible         INTEGER NOT NULL DEFAULT 0,
        reproduced_from_run_id  TEXT REFERENCES benchmark_run(id) ON DELETE SET NULL,
        triggering_event_kind   TEXT,
        triggering_event_ref_id TEXT,
        baseline_run_id         TEXT REFERENCES benchmark_run(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_case_time ON benchmark_run(case_id, run_at DESC);
      CREATE INDEX IF NOT EXISTS idx_run_sha       ON benchmark_run(case_id, knowledge_state_sha);

      CREATE TABLE IF NOT EXISTS benchmark_run_repo_state (
        run_id   TEXT NOT NULL REFERENCES benchmark_run(id) ON DELETE CASCADE,
        repo_url TEXT NOT NULL,
        repo_sha TEXT NOT NULL,
        PRIMARY KEY (run_id, repo_url)
      );
      CREATE INDEX IF NOT EXISTS idx_run_repo_state_sha
        ON benchmark_run_repo_state(repo_url, repo_sha);

      CREATE TABLE IF NOT EXISTS regression_alert (
        id                       TEXT PRIMARY KEY,
        case_id                  TEXT NOT NULL REFERENCES benchmark_case(id) ON DELETE CASCADE,
        prev_run_id              TEXT NOT NULL REFERENCES benchmark_run(id)  ON DELETE CASCADE,
        current_run_id           TEXT NOT NULL REFERENCES benchmark_run(id)  ON DELETE CASCADE,
        prev_score               REAL NOT NULL,
        current_score            REAL NOT NULL,
        delta                    REAL NOT NULL,
        triggering_event_kind    TEXT NOT NULL,
        triggering_event_ref_id  TEXT NOT NULL,
        status                   TEXT NOT NULL,
        resolved_note            TEXT,
        created_at               INTEGER NOT NULL,
        updated_at               INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_alert_status ON regression_alert(status, created_at DESC);

      CREATE TABLE IF NOT EXISTS benchmark_cost_audit (
        id                  TEXT PRIMARY KEY,
        date                TEXT NOT NULL,
        role_id             TEXT,
        llm_calls           INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd  REAL    NOT NULL DEFAULT 0,
        updated_at          INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cost_date_role
        ON benchmark_cost_audit(date, role_id);
      CREATE INDEX IF NOT EXISTS idx_cost_date ON benchmark_cost_audit(date DESC);
    `,
  },
  {
    version: 22,
    description:
      'Git-as-substrate KnowledgeRepo subscription (docs/design/2026-06-06-'
      + 'conversation-knowledge-redesign.md §7 / PR 5.5a). knowledge_repo'
      + ' stores one row per subscribed git repository — the local clone'
      + ' path, last fetched commit, sync cadence, host classification'
      + ' (internal vs public per §7.4 R-0), and lifecycle status. The'
      + ' table is intentionally separate from role_subscriptions so the'
      + ' URL-based legacy path (a single .helmrole bundle URL) can'
      + ' continue to coexist while the git-based path takes over as the'
      + ' main sharing primitive. PR 5.5b will land the frontmatter ↔'
      + ' DB mapper that turns clones in this table into KnowledgePoint'
      + ' rows; PR 5.5c/d add merge UI + PR-platform push.'
      + ' classification is filled at subscribe time by the host'
      + ' allow-list classifier — internal hosts (code.byted.org by'
      + ' default) yield "internal"; everything else is "public" and'
      + ' R-0 stops internal-marked points from being published there.',
    up: `
      CREATE TABLE IF NOT EXISTS knowledge_repo (
        id                      TEXT PRIMARY KEY,
        url                     TEXT NOT NULL UNIQUE,
        branch                  TEXT NOT NULL DEFAULT 'main',
        local_path              TEXT NOT NULL,
        last_fetched_sha        TEXT,
        last_fetched_at         INTEGER,
        sync_interval_minutes   INTEGER NOT NULL DEFAULT 30,
        auto_apply              INTEGER NOT NULL DEFAULT 0,
        classification          TEXT NOT NULL,
        status                  TEXT NOT NULL DEFAULT 'active',
        last_error              TEXT,
        created_at              INTEGER NOT NULL,
        updated_at              INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_repo_status
        ON knowledge_repo(status, last_fetched_at);
      CREATE INDEX IF NOT EXISTS idx_repo_branch
        ON knowledge_repo(url, branch);
    `,
  },
  {
    version: 23,
    description:
      'Knowledge merge conflicts (PR 5.5c). When import-now would'
      + ' overwrite a chunk that diverged locally (edit_version moved'
      + ' past the last imported version), the importer records a row'
      + ' here instead of clobbering. The Library shows pending'
      + ' conflicts and surfaces local / remote / merged-draft panes so'
      + ' the user picks a winner. status open / resolved.',
    up: `
      CREATE TABLE IF NOT EXISTS knowledge_merge_conflict (
        id              TEXT PRIMARY KEY,
        repo_id         TEXT NOT NULL REFERENCES knowledge_repo(id) ON DELETE CASCADE,
        point_id        TEXT NOT NULL,
        local_body      TEXT NOT NULL,
        remote_body     TEXT NOT NULL,
        local_version   INTEGER NOT NULL,
        remote_revision TEXT NOT NULL,
        status          TEXT NOT NULL,
        resolved_body   TEXT,
        resolved_at     INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_merge_conflict_status
        ON knowledge_merge_conflict(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_merge_conflict_repo
        ON knowledge_merge_conflict(repo_id);
    `,
  },
  {
    version: 24,
    description:
      'Conversation insights — host_sessions.summary + summary_generated_at'
      + ' (the TL;DR LLM block at the top of the detail pane);'
      + ' knowledge_candidates.gist (one-line classified summary). Both'
      + ' columns are nullable so back-fill is opt-in and existing rows'
      + ' simply render without the new fields.',
    up: `
      ALTER TABLE host_sessions ADD COLUMN summary TEXT;
      ALTER TABLE host_sessions ADD COLUMN summary_generated_at TEXT;
      ALTER TABLE knowledge_candidates ADD COLUMN gist TEXT;
    `,
  },
  {
    version: 25,
    description:
      'Curation report (PR-B) — knowledge_candidates.target_chunk_id'
      + ' marks a candidate as an UPDATE to an existing chunk (vs NEW'
      + ' knowledge). Nullable, ON DELETE SET NULL so dropping the chunk'
      + ' downgrades the candidate to a New-knowledge entry instead of'
      + ' cascading the delete.',
    up: `
      ALTER TABLE knowledge_candidates
        ADD COLUMN target_chunk_id TEXT
        REFERENCES knowledge_chunks(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_candidates_target_chunk
        ON knowledge_candidates(target_chunk_id);
    `,
  },
  {
    version: 26,
    description:
      'knowledge_repo.profile — persist the repo layout/serialization'
      + ' profile (helm-native / llm-wiki / generic) at subscribe time.'
      + ' Previously the UI and importer each re-inferred it from the'
      + ' URL; the scheduled sync sweep needs the authoritative value'
      + ' to auto-import correctly.',
    up: `
      ALTER TABLE knowledge_repo
        ADD COLUMN profile TEXT NOT NULL DEFAULT 'helm-native';
    `,
  },
  {
    version: 27,
    description:
      'files-as-truth PR-4: drop knowledge_merge_conflict. Markdown in'
      + ' the repo working copy is the source of truth and imports always'
      + ' sync the DB row to the file, so the DB-side 3-way merge flow'
      + ' (PR 5.5c) has nothing left to arbitrate. Unresolved rows drop'
      + ' with the table — file content wins on the next import.',
    up: `
      DROP INDEX IF EXISTS idx_merge_conflict_status;
      DROP INDEX IF EXISTS idx_merge_conflict_repo;
      DROP TABLE IF EXISTS knowledge_merge_conflict;
    `,
  },
  {
    version: 28,
    description:
      'knowledge_repo.import_dirs — JSON array of top-level directories'
      + ' the llm-wiki importer reads (whitelist). NULL/absent = all'
      + ' directories (legacy behaviour). chat-captured/ is always'
      + ' imported regardless. Motivation: mechanically mapping every'
      + ' top-level dir to a role pulled in scripts/, raw/, etc.',
    up: `
      ALTER TABLE knowledge_repo ADD COLUMN import_dirs TEXT;
    `,
  },
  {
    version: 29,
    description:
      'candidate_external_context — cached external-knowledge context'
      + ' (Tika / custom MCP bridges) per knowledge candidate.'
      + ' Prefetched in the background right after capture so the Review'
      + ' inbox renders the candidate and the org-side context together'
      + ' without a click or an on-page round-trip.',
    up: `
      CREATE TABLE IF NOT EXISTS candidate_external_context (
        candidate_id TEXT PRIMARY KEY
          REFERENCES knowledge_candidates(id) ON DELETE CASCADE,
        providers    TEXT NOT NULL,
        body         TEXT NOT NULL,
        fetched_at   INTEGER NOT NULL
      );
    `,
  },
  {
    version: 30,
    description:
      'chat_entity_curation — LLM-curated unknown-entity strip per chat.'
      + ' Rule extraction surfaces noise no regex can judge (usernames,'
      + ' generic platform words); an LLM pass at the Stop hook decides'
      + ' which tokens are real knowledge entities. input_entities is the'
      + ' list the LLM saw — entities outside it (new since curation) are'
      + ' shown unfiltered until the next pass.',
    up: `
      CREATE TABLE IF NOT EXISTS chat_entity_curation (
        host_session_id TEXT PRIMARY KEY
          REFERENCES host_sessions(id) ON DELETE CASCADE,
        input_hash      TEXT NOT NULL,
        input_entities  TEXT NOT NULL,
        kept            TEXT NOT NULL,
        curated_at      INTEGER NOT NULL
      );
    `,
  },
  {
    version: 31,
    description:
      'roles.bindable (knowledge tiers PR-δ) — splits the collection'
      + ' layer: bindable=1 is an Expert (prompt, chat binding, session'
      + ' injection); bindable=0 is a pure knowledge Collection (imported'
      + ' dirs like wiki/, entity buckets like og). Retrieval treats both'
      + ' the same; only the binding/persona surface differs. Backfill:'
      + ' non-builtin roles with an empty prompt are collections.',
    up: `
      ALTER TABLE roles ADD COLUMN bindable INTEGER NOT NULL DEFAULT 1;
      UPDATE roles SET bindable = 0
       WHERE is_builtin = 0 AND TRIM(COALESCE(system_prompt, '')) = '';
    `,
  },
  {
    version: 32,
    description:
      'drop role_mirrors — the .helmrole remote-mirror auto-push (Phase'
      + ' 80 PR B) is superseded by files-as-truth: knowledge syncs'
      + ' through the llm-wiki repo via MR flows (个人同步 / Contribute),'
      + ' not bundle uploads to storage plugins.',
    up: `
      DROP INDEX IF EXISTS idx_role_mirrors_enabled_version;
      DROP TABLE IF EXISTS role_mirrors;
    `,
  },
  {
    version: 33,
    description:
      'drop role_subscriptions — the .helmrole bundle-subscription'
      + ' system (Phase 79/80) is removed with the storage-plugin'
      + ' ecosystem; knowledge sync is the llm-wiki repo (knowledge_repo'
      + ' table + MR flows).',
    up: `
      DROP TABLE IF EXISTS role_subscriptions;
    `,
  },
  {
    version: 34,
    description:
      'host_sessions.capture_disabled — per-chat knowledge-capture'
      + ' opt-out. helm-development chats about helm itself produced'
      + ' meta-noise buckets (the LLM bucket capturing a feature-audit'
      + ' table); the user can now mute capture for a chat from the'
      + ' conversation detail pane.',
    up: `
      ALTER TABLE host_sessions
        ADD COLUMN capture_disabled INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 35,
    description:
      'chat_knowledge_points + host_sessions.last_extracted_turn — LLM'
      + ' chat-level knowledge extraction. An LLM reads the conversation'
      + ' and proposes concrete knowledge points, each suggesting an'
      + ' existing topic (suggested_role_id) or a new one'
      + ' (suggested_topic_name). Replaces the deterministic entity-token'
      + ' walls. last_extracted_agent_chars throttles the Stop-hook auto-run'
      + ' so it only fires once new assistant output accumulates past a'
      + ' threshold (agent output ≈ where knowledge lives; turn count is a'
      + ' poor proxy).',
    up: `
      CREATE TABLE IF NOT EXISTS chat_knowledge_points (
        id                   TEXT PRIMARY KEY,
        host_session_id      TEXT NOT NULL REFERENCES host_sessions(id) ON DELETE CASCADE,
        title                TEXT NOT NULL,
        body                 TEXT NOT NULL,
        kind                 TEXT NOT NULL DEFAULT 'other',
        suggested_role_id    TEXT REFERENCES roles(id) ON DELETE SET NULL,
        suggested_topic_name TEXT,
        text_hash            TEXT NOT NULL,
        status               TEXT NOT NULL DEFAULT 'pending',
        created_at           TEXT NOT NULL,
        decided_at           TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ckp_session_status
        ON chat_knowledge_points(host_session_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_ckp_session_hash
        ON chat_knowledge_points(host_session_id, text_hash)
        WHERE status = 'pending' OR status = 'dismissed';
      ALTER TABLE host_sessions
        ADD COLUMN last_extracted_agent_chars INTEGER NOT NULL DEFAULT 0;
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
