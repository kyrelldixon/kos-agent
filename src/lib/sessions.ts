import { homedir } from "node:os";
import { join } from "node:path";

const SESSIONS_DIR = join(homedir(), ".kos/agent/sessions");

interface SessionData {
  sessionId?: string;
  workspace?: string;
  updatedAt: string;
}

export async function getSession(
  sessionKey: string,
): Promise<SessionData | undefined> {
  const file = Bun.file(join(SESSIONS_DIR, `${sessionKey}.json`));
  if (!(await file.exists())) return undefined;
  return file.json();
}

export async function saveSession(
  sessionKey: string,
  data: Partial<SessionData>,
): Promise<void> {
  const existing = (await getSession(sessionKey)) ?? {};
  await Bun.write(
    join(SESSIONS_DIR, `${sessionKey}.json`),
    JSON.stringify(
      { ...existing, ...data, updatedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
}
