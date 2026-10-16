import type { AgentTask } from "../core/state";

const BASE = "agent_opencode";
const PREFIX = `${BASE}_session_`;
const MAX_SESSIONS = 32;

/** Reuse the catalog pill for the first session, never for a different live
 * session. Additional sessions use the existing dynamic-agent-pill machinery.
 * IDs contain no paths or session text and stay below the phone protocol limit.
 */
export function openCodePillId(tasks: readonly AgentTask[], sessionId: string): string | null {
  if (!sessionId) return BASE;
  const sessions = tasks.filter((task) => task.id === BASE || task.id.startsWith(PREFIX));
  const existing = sessions.find((task) => task.sessionId === sessionId);
  if (existing) return existing.id;
  const primary = sessions.find((task) => task.id === BASE);
  if (!primary || !primary.sessionId) return BASE;
  if (sessions.length >= MAX_SESSIONS) return null;
  for (let index = 1; index < MAX_SESSIONS; index++) {
    const id = `${PREFIX}${index}`;
    if (!sessions.some((task) => task.id === id)) return id;
  }
  return null;
}
