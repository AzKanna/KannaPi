/**
 * Database bootstrap: open SQLite (WAL) and run migrations (ADR-005).
 * Driver: Node built-in `node:sqlite` (DatabaseSync) — zero native deps, FTS5 included.
 */
import { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "core-schema",
    sql: `
      CREATE TABLE sessions (
        id          TEXT PRIMARY KEY,
        started_at  INTEGER NOT NULL,
        target      TEXT,
        scope_json  TEXT NOT NULL,
        ended_at    INTEGER
      );

      CREATE TABLE blobs (
        hash     TEXT PRIMARY KEY,
        size     INTEGER NOT NULL,
        mime_type TEXT,
        data     BLOB NOT NULL
      );

      CREATE TABLE flows (
        id                    TEXT PRIMARY KEY,
        session_id            TEXT NOT NULL REFERENCES sessions(id),
        proxy_flow_key        TEXT NOT NULL,
        ts_start              INTEGER NOT NULL,
        ts_end                INTEGER,
        method                TEXT NOT NULL,
        url                   TEXT NOT NULL,
        host                  TEXT NOT NULL,
        port                  INTEGER,
        path                  TEXT NOT NULL,
        request_headers       TEXT NOT NULL DEFAULT '[]',
        request_body_hash     TEXT,
        request_body_size     INTEGER,
        request_body_truncated INTEGER,
        request_body_mime     TEXT,
        request_body_preview  TEXT,
        status_code           INTEGER,
        response_headers      TEXT NOT NULL DEFAULT '[]',
        response_body_hash    TEXT,
        response_body_size    INTEGER,
        response_body_truncated INTEGER,
        response_body_mime    TEXT,
        response_body_preview TEXT,
        content_type          TEXT,
        source                TEXT NOT NULL,
        browser_action_id     TEXT,
        browser_page_id       TEXT,
        initiator_url         TEXT,
        timing                TEXT NOT NULL DEFAULT '{}',
        security_metadata     TEXT NOT NULL DEFAULT '{}',
        websocket_messages    TEXT,
        created_at            INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_flows_proxy_key ON flows(session_id, proxy_flow_key);
      CREATE INDEX idx_flows_session_ts ON flows(session_id, ts_start);
      CREATE INDEX idx_flows_action ON flows(browser_action_id);
      CREATE INDEX idx_flows_host_path ON flows(host, path);
      CREATE INDEX idx_flows_status ON flows(status_code);

      CREATE TABLE actions (
        id                  TEXT PRIMARY KEY,
        session_id          TEXT NOT NULL REFERENCES sessions(id),
        seq                 INTEGER NOT NULL,
        type                TEXT NOT NULL,
        params              TEXT NOT NULL DEFAULT '{}',
        page_id             TEXT NOT NULL,
        started_at          INTEGER NOT NULL,
        ended_at            INTEGER,
        status              TEXT NOT NULL,
        error               TEXT,
        page_url_before     TEXT,
        page_url_after      TEXT,
        correlated_flow_ids TEXT NOT NULL DEFAULT '[]'
      );
      CREATE UNIQUE INDEX idx_actions_session_seq ON actions(session_id, seq);

      CREATE TABLE endpoints (
        id            TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL REFERENCES sessions(id),
        host          TEXT NOT NULL,
        method        TEXT NOT NULL,
        path_template TEXT NOT NULL,
        test_state    TEXT NOT NULL DEFAULT 'untested',
        first_seen    INTEGER NOT NULL,
        last_seen     INTEGER NOT NULL,
        json          TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_endpoints_identity ON endpoints(session_id, host, method, path_template);

      CREATE TABLE hypotheses (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL REFERENCES sessions(id),
        category    TEXT NOT NULL,
        status      TEXT NOT NULL,
        priority    TEXT NOT NULL,
        title       TEXT NOT NULL,
        json        TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_hypotheses_session ON hypotheses(session_id, status);

      CREATE TABLE tests (
        id             TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL REFERENCES sessions(id),
        hypothesis_id  TEXT NOT NULL,
        strategy       TEXT NOT NULL,
        json           TEXT NOT NULL,
        created_at     INTEGER NOT NULL
      );
      CREATE INDEX idx_tests_hypothesis ON tests(hypothesis_id);

      CREATE TABLE findings (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL REFERENCES sessions(id),
        category    TEXT NOT NULL,
        severity    TEXT NOT NULL,
        status      TEXT NOT NULL,
        endpoint    TEXT,
        parameter   TEXT,
        title       TEXT NOT NULL,
        json        TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_findings_session ON findings(session_id, category, status);

      CREATE TABLE audit (
        id         TEXT PRIMARY KEY,
        ts         INTEGER NOT NULL,
        actor      TEXT NOT NULL,
        event_type TEXT NOT NULL,
        tool_name  TEXT,
        action_id  TEXT,
        flow_id    TEXT,
        decision   TEXT,
        reason     TEXT,
        details    TEXT
      );
      CREATE INDEX idx_audit_ts ON audit(ts);
      CREATE INDEX idx_audit_type ON audit(event_type, decision);
    `,
  },
  {
    version: 2,
    name: "generic-agent-workspace",
    sql: `
      CREATE TABLE projects (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        description    TEXT,
        workspace_path TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );

      CREATE TABLE project_assets (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        type          TEXT NOT NULL,
        name          TEXT NOT NULL,
        value         TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX idx_project_assets_project ON project_assets(project_id, created_at);

      CREATE TABLE agent_workspaces (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        provider_id     TEXT NOT NULL,
        model_id        TEXT NOT NULL,
        cwd             TEXT NOT NULL,
        system_prompt   TEXT NOT NULL,
        tool_profile    TEXT NOT NULL,
        pi_session_file TEXT,
        status          TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        last_error      TEXT
      );
      CREATE INDEX idx_agent_workspaces_project ON agent_workspaces(project_id, updated_at);
    `,
  },
  {
    version: 3,
    name: "agent-skills-and-mcp",
    sql: `
      CREATE TABLE agent_skills (
        id                TEXT PRIMARY KEY,
        agent_id          TEXT NOT NULL REFERENCES agent_workspaces(id) ON DELETE CASCADE,
        path              TEXT NOT NULL,
        names_json        TEXT NOT NULL DEFAULT '[]',
        descriptions_json TEXT NOT NULL DEFAULT '[]',
        enabled           INTEGER NOT NULL DEFAULT 1,
        created_at        INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_agent_skills_path ON agent_skills(agent_id, path);

      CREATE TABLE agent_mcp_servers (
        id              TEXT PRIMARY KEY,
        agent_id        TEXT NOT NULL REFERENCES agent_workspaces(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        transport       TEXT NOT NULL,
        command         TEXT,
        args_json       TEXT NOT NULL DEFAULT '[]',
        url             TEXT,
        env_json        TEXT NOT NULL DEFAULT '{}',
        enabled         INTEGER NOT NULL DEFAULT 1,
        tool_names_json TEXT NOT NULL DEFAULT '[]',
        last_error      TEXT,
        last_checked_at INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX idx_agent_mcp_servers_agent ON agent_mcp_servers(agent_id, updated_at);
    `,
  },
  {
    version: 4,
    name: "agent-attack-graph",
    sql: `
      CREATE TABLE agent_attack_graphs (
        agent_id   TEXT PRIMARY KEY REFERENCES agent_workspaces(id) ON DELETE CASCADE,
        run_id     TEXT NOT NULL,
        graph_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 5,
    name: "agent-attachments",
    sql: `
      CREATE TABLE agent_attachments (
        id           TEXT PRIMARY KEY,
        agent_id     TEXT NOT NULL REFERENCES agent_workspaces(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        mime_type    TEXT NOT NULL,
        size         INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_agent_attachments_agent ON agent_attachments(agent_id, created_at);
    `,
  },
  {
    version: 6,
    name: "project-ssh",
    sql: `
      CREATE TABLE ssh_hosts (
        id                 TEXT PRIMARY KEY,
        project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name               TEXT NOT NULL,
        host               TEXT NOT NULL,
        port               INTEGER NOT NULL,
        username           TEXT NOT NULL,
        auth_type          TEXT NOT NULL,
        private_key_path   TEXT,
        host_fingerprint   TEXT,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL
      );
      CREATE INDEX idx_ssh_hosts_project ON ssh_hosts(project_id, updated_at);

      CREATE TABLE ssh_command_history (
        id          TEXT PRIMARY KEY,
        host_id     TEXT NOT NULL REFERENCES ssh_hosts(id) ON DELETE CASCADE,
        actor       TEXT NOT NULL,
        command     TEXT NOT NULL,
        stdout      TEXT NOT NULL,
        stderr      TEXT NOT NULL,
        exit_code   INTEGER,
        signal      TEXT,
        timed_out   INTEGER NOT NULL DEFAULT 0,
        started_at  INTEGER NOT NULL,
        ended_at    INTEGER NOT NULL
      );
      CREATE INDEX idx_ssh_commands_host ON ssh_command_history(host_id, started_at DESC);
    `,
  },
  {
    version: 7,
    name: "request-lab",
    sql: `
      CREATE TABLE request_lab_tabs (
        id                TEXT PRIMARY KEY,
        project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name              TEXT NOT NULL,
        source_session_id TEXT,
        source_flow_id    TEXT,
        allowed_origin    TEXT NOT NULL,
        raw_request       TEXT NOT NULL,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
      CREATE INDEX idx_request_lab_tabs_project
        ON request_lab_tabs(project_id, updated_at DESC);

      CREATE TABLE request_lab_exchanges (
        id                    TEXT PRIMARY KEY,
        tab_id                TEXT NOT NULL REFERENCES request_lab_tabs(id) ON DELETE CASCADE,
        request_url           TEXT NOT NULL,
        raw_request           TEXT NOT NULL,
        response_status       INTEGER,
        response_status_text  TEXT,
        response_headers_json TEXT NOT NULL DEFAULT '{}',
        response_body         TEXT NOT NULL DEFAULT '',
        response_truncated    INTEGER NOT NULL DEFAULT 0,
        duration_ms           INTEGER,
        error                 TEXT,
        created_at            INTEGER NOT NULL
      );
      CREATE INDEX idx_request_lab_exchanges_tab
        ON request_lab_exchanges(tab_id, created_at DESC);
    `,
  },
  {
    version: 8,
    name: "agent-chat-sessions",
    sql: `
      CREATE TABLE agent_chat_sessions (
        id              TEXT PRIMARY KEY,
        agent_id        TEXT NOT NULL REFERENCES agent_workspaces(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        workspace_path  TEXT NOT NULL,
        pi_session_file TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX idx_agent_chat_sessions_agent
        ON agent_chat_sessions(agent_id, updated_at DESC);
    `,
  },
  {
    version: 9,
    name: "agent-chat-session-initialization",
    sql: `
      CREATE TABLE agent_chat_session_state (
        agent_id TEXT PRIMARY KEY REFERENCES agent_workspaces(id) ON DELETE CASCADE
      );
    `,
  },
  {
    version: 10,
    name: "agent-thinking-level",
    sql: `
      ALTER TABLE agent_workspaces
        ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'medium';
    `,
  },
  {
    version: 11,
    name: "session-attack-graphs",
    sql: `
      CREATE TABLE agent_session_attack_graphs (
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL REFERENCES agent_workspaces(id) ON DELETE CASCADE,
        graph_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, session_id)
      );
      CREATE INDEX idx_agent_session_attack_graphs_agent
        ON agent_session_attack_graphs(agent_id, updated_at DESC);
    `,
  },
  {
    version: 12,
    name: "agent-plugins",
    sql: `
      CREATE TABLE agent_plugins (
        id         TEXT PRIMARY KEY,
        agent_id   TEXT NOT NULL REFERENCES agent_workspaces(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        path       TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_agent_plugins_agent ON agent_plugins(agent_id, created_at);
    `,
  },
];

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA synchronous = NORMAL;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as
    | { v: number | null }
    | undefined;
  const current = row?.v ?? 0;
  for (const m of MIGRATIONS.filter((x) => x.version > current)) {
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        m.version,
        Date.now(),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration v${m.version} (${m.name}) failed: ${(e as Error).message}`);
    }
  }
}
