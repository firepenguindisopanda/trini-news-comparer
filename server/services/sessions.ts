/**
 * In-memory session store for comparison jobs.
 *
 * Used by the polling fallback when Pusher is not available.
 * The server creates sessions, the comparison runner updates them
 * with results, and the status endpoint returns them to the client.
 */

export interface Session {
  topic: string;
  status: string;
  createdAt: number;
  result?: unknown;
}

const sessions = new Map<string, Session>();

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

export function setSession(sessionId: string, data: Session): void {
  sessions.set(sessionId, data);
}

export function setSessionResult(sessionId: string, result: unknown): void {
  const s = sessions.get(sessionId);
  if (s) {
    s.result = result;
    s.status = "completed";
  }
}

export function setSessionStatus(sessionId: string, status: string): void {
  const s = sessions.get(sessionId);
  if (s) s.status = status;
}
