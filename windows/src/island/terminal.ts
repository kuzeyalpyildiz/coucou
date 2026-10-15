import { Bridge } from "../core/bridge";
import { State } from "../core/state";

/** Capture the request's target before closing the card changes focus/state. */
export function answerInTerminal(close: () => void): void {
  const request = State.pendingApproval;
  if (!request) return;
  const task = State.tasks.find(t => t.id === request.pillId);
  const path = task?.sessionId === request.sessionId ? task.sessionCwd ?? null : null;
  // Request focus while handling the user click. Declining does not answer the
  // question or approve anything: it returns control to the agent's native UI.
  void Bridge.focusSession(request.sessionId, path).then(focused => {
    if (!focused) void Bridge.log("Answer in terminal: session window could not be focused");
  });
  void Bridge.approvalDecline(request.requestId);
  close();
}
