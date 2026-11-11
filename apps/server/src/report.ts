import { join, resolve } from "node:path";
import { FindingsRepo, openDatabase, SessionsRepo } from "@kanna/database";

export function loadReport(dataDir: string, sessionId?: string) {
  const db = openDatabase(join(resolve(dataDir), "kanna.db"));
  try {
    const sessions = new SessionsRepo(db);
    const session = sessionId ? sessions.get(sessionId) : sessions.list()[0];
    if (!session) throw new Error("No scan sessions found");
    return { session, findings: new FindingsRepo(db).list(session.id) };
  } finally {
    db.close();
  }
}
