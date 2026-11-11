import type { DatabaseSync } from "node:sqlite";
import type { SshCommandResult, SshHost } from "@kanna/shared";

export type StoredSshHost = Omit<SshHost, "status" | "lastError">;

function hostFrom(row: Record<string, unknown>): StoredSshHost {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    host: String(row.host),
    port: Number(row.port),
    username: String(row.username),
    authType: String(row.auth_type) as StoredSshHost["authType"],
    privateKeyPath: row.private_key_path == null ? undefined : String(row.private_key_path),
    hostFingerprint: row.host_fingerprint == null ? undefined : String(row.host_fingerprint),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function commandFrom(row: Record<string, unknown>): SshCommandResult {
  return {
    id: String(row.id),
    hostId: String(row.host_id),
    actor: String(row.actor) as SshCommandResult["actor"],
    command: String(row.command),
    stdout: String(row.stdout),
    stderr: String(row.stderr),
    exitCode: row.exit_code == null ? undefined : Number(row.exit_code),
    signal: row.signal == null ? undefined : String(row.signal),
    timedOut: Number(row.timed_out) === 1,
    startedAt: Number(row.started_at),
    endedAt: Number(row.ended_at),
  };
}

export class SshHostsRepo {
  constructor(private readonly db: DatabaseSync) {}

  save(host: StoredSshHost): void {
    this.db
      .prepare(`
      INSERT INTO ssh_hosts (
        id, project_id, name, host, port, username, auth_type, private_key_path,
        host_fingerprint, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, host=excluded.host, port=excluded.port,
        username=excluded.username, auth_type=excluded.auth_type,
        private_key_path=excluded.private_key_path,
        host_fingerprint=excluded.host_fingerprint, updated_at=excluded.updated_at
    `)
      .run(
        host.id,
        host.projectId,
        host.name,
        host.host,
        host.port,
        host.username,
        host.authType,
        host.privateKeyPath ?? null,
        host.hostFingerprint ?? null,
        host.createdAt,
        host.updatedAt,
      );
  }

  get(id: string): StoredSshHost | undefined {
    const row = this.db.prepare("SELECT * FROM ssh_hosts WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? hostFrom(row) : undefined;
  }

  list(projectId: string): StoredSshHost[] {
    return (
      this.db
        .prepare("SELECT * FROM ssh_hosts WHERE project_id = ? ORDER BY updated_at DESC")
        .all(projectId) as Record<string, unknown>[]
    ).map(hostFrom);
  }

  delete(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM ssh_hosts WHERE id = ?").run(id).changes) > 0;
  }
}

export class SshCommandHistoryRepo {
  constructor(private readonly db: DatabaseSync) {}

  save(result: SshCommandResult): void {
    this.db
      .prepare(`
      INSERT INTO ssh_command_history (
        id, host_id, actor, command, stdout, stderr, exit_code, signal,
        timed_out, started_at, ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        result.id,
        result.hostId,
        result.actor,
        result.command,
        result.stdout,
        result.stderr,
        result.exitCode ?? null,
        result.signal ?? null,
        result.timedOut ? 1 : 0,
        result.startedAt,
        result.endedAt,
      );
  }

  list(hostId: string, limit = 50): SshCommandResult[] {
    return (
      this.db
        .prepare("SELECT * FROM ssh_command_history WHERE host_id = ? ORDER BY started_at DESC LIMIT ?")
        .all(hostId, Math.min(Math.max(limit, 1), 200)) as Record<string, unknown>[]
    ).map(commandFrom);
  }
}
