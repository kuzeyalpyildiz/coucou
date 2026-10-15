// What the island tells the phone link (src-tauri/src/phone_link).
//
// While the link is on, the island publishes a picture of its agent sessions and
// of the permission request waiting for an answer; Rust works out what changed
// and sends it to the paired phone. A phone's Allow or Deny comes back through
// Rust (which answers the waiting hook) and only the card on the island is
// closed here. While the link is off nothing is computed and no timer runs.

import { Bridge, onEvent, type PhoneLinkPlan, type PhoneLinkUsage, type PhoneLinkApproval, type PhoneLinkDiff, type PhoneLinkFile, type PhoneLinkQuestion, type PhoneLinkSession } from "../core/bridge";
import { fileName, parseDiffStep, type FileDiff } from "../core/diff";
import type { PlanUsage, CodexPlanUsage } from "../core/plan";
import { State } from "../core/state";
import { parseOutfit } from "../mochi/wardrobe";
import { dropPendingCard } from "./hooks";
import { serviceCards } from "./phone-services";
import type { Island } from "./island";

/** Changes arrive in bursts (a tool call is several events); one picture per burst. */
const DEBOUNCE_MS = 250;

export interface LinkSnapshot {
  sessions: PhoneLinkSession[];
  approval: PhoneLinkApproval | null;
  /** The question Claude Code is asking, offered only to phones that may answer (Rust decides who). */
  question: PhoneLinkQuestion | null;
}

/**
 * The island labels what it shows as "Bash · npm test". The phone shows the tool on its own
 * line, so it gets the bare command.
 */
export function bareCommand(tool: string, command: string): string {
  const prefix = `${tool} · `;
  return command.startsWith(prefix) ? command.slice(prefix.length) : command;
}

/** Only the last segment of a folder path, whichever way it is written; never the path itself. */
export function folderName(path: string | null | undefined): string | undefined {
  const last = (path ?? "").split(/[\\/]+/).filter(Boolean).pop();
  return last && last !== "." && last !== ".." ? last : undefined;
}

/** A step as the phone sees it: a file diff by its file name, anything else as it is. */
function stepText(step: string): string {
  const diff = parseDiffStep(step);
  return diff ? diff.filename : step;
}

/** One plan as the phone gets it: the percentages and reset times the pills show, and nothing else. */
function planFor(u: PlanUsage | CodexPlanUsage | null | undefined): PhoneLinkPlan | null {
  if (!u || (!u.fiveHour && !u.sevenDay)) return null;
  const plan: PhoneLinkPlan = { updatedAt: u.updatedAt };
  if (u.fiveHour) plan.fiveHour = { usedPct: u.fiveHour.usedPct, resetsAt: u.fiveHour.resetsAt };
  if (u.sevenDay) plan.sevenDay = { usedPct: u.sevenDay.usedPct, resetsAt: u.sevenDay.resetsAt };
  const codex = u as CodexPlanUsage;
  if (typeof codex.resetCredits === "number") plan.resetCredits = codex.resetCredits;
  if (codex.planType) plan.planType = codex.planType;
  return plan;
}

export function linkUsage(): PhoneLinkUsage {
  return { claude: planFor(State.planUsage), codex: planFor(State.codexPlanUsage) };
}

/** The files a session changed, newest last, by name and counts only (the lines are sent when a phone asks). */
export function linkFiles(pillId: string): PhoneLinkFile[] {
  return (State.sessionDiffs.get(pillId) ?? []).slice(-20).map((d) => {
    const f: PhoneLinkFile = { id: d.id, name: fileName(d.path), added: d.added, removed: d.removed };
    if (d.tooLarge) f.tooLarge = true;
    if (d.isNewFile) f.isNew = true;
    return f;
  });
}

/** One file's diff as lines of [kind, text]: "@" opens each hunk. A diff that was too large has counts only. */
export function linkDiff(pillId: string, fileId: number): PhoneLinkDiff {
  const d: FileDiff | null = State.findDiff(pillId, fileId);
  const empty = { pillId, fileId, name: "", added: 0, removed: 0, tooLarge: false, lines: [] as [string, string][] };
  if (!d) return { ...empty, gone: true };
  const lines: [string, string][] = [];
  for (const h of d.hunks) {
    lines.push(["@", `@@ ${h.newStart}`]);
    for (const l of h.lines) lines.push([l.kind === "added" ? "+" : l.kind === "removed" ? "-" : " ", l.text]);
  }
  return { pillId, fileId, name: fileName(d.path), added: d.added, removed: d.removed, tooLarge: d.tooLarge, gone: false, lines };
}

/** The agents' sessions — not the services — and the request the phone may answer. */
export function linkSnapshot(): LinkSnapshot {
  const sessions: PhoneLinkSession[] = State.tasks
    .filter((t) => t.source !== "n8n")
    .map((t) => {
      const last = t.steps[t.steps.length - 1] ?? "";
      // A step that stands for a file diff is shown by the file's name.
      const diff = parseDiffStep(last);
      return {
        pillId: t.id,
        agent: t.name,
        state: t.state,
        statusText: diff ? diff.filename : last,
        stepIndex: t.stepIndex,
        stepCount: t.steps.length,
        // Session details. Rust sends them only to a phone that asked and was offered them (the user's
        // switch), and cuts them to size; the folder's name is all that leaves this file, not the path.
        steps: t.steps.slice(-20).map(stepText),
        finalLine: t.finalLine || undefined,
        project: folderName(t.sessionCwd),
        color: t.color,
        files: linkFiles(t.id),
      };
    });

  // Permission requests (Allow / Deny) go to every phone. A question goes only to a phone that has the `answers`
  // capability (Rust decides), as its own message: the options with their labels, nothing else of the request.
  const a = State.pendingApproval;
  const approval =
    a && !a.questions && a.requestId
      ? { requestId: a.requestId, sessionId: a.sessionId, pillId: a.pillId, tool: a.tool, command: bareCommand(a.tool, a.command) }
      : null;
  const question =
    a && a.questions && a.questions.length > 0 && a.requestId
      ? {
          requestId: a.requestId,
          sessionId: a.sessionId,
          pillId: a.pillId,
          questions: a.questions.map((q) => ({
            question: q.question,
            options: q.options.map((o) => ({ label: o.label, description: o.description ?? "" })),
            multiSelect: q.multiSelect,
          })),
        }
      : null;
  return { sessions, approval, question };
}

/** Returns what undoes it (the tests use it; the app registers once and keeps it). */
export function registerPhoneLink(island: Island): () => void {
  let running = false;
  let last = "";
  /** What was last sent as the question; "" before anything was, so a link that comes up syncs the hub. */
  let lastQuestion = "";
  /** The outfit last sent; "" before anything was. */
  let lastOutfit = "";
  /** The plan usage last sent, as JSON; "" before anything was. */
  let lastUsage = "";
  /** The service cards last sent, as JSON; "" before anything was. */
  let lastServices = "";
  let timer: number | null = null;
  let disposed = false;
  let unlistenStatus: (() => void) | undefined;
  let unlistenSync: (() => void) | undefined;
  let refreshVersion = 0;
  let linkVersion = 0;
  let publishing = false;
  let failures = 0;
  const unlisteners: (() => void)[] = [];
  const retainListener = (unlisten: () => void) => {
    if (disposed) unlisten();
    else unlisteners.push(unlisten);
  };

  const publish = () => {
    timer = null;
    if (!running || disposed) return;
    const snapshot = linkSnapshot();
    const key = JSON.stringify(snapshot);
    if (!publishing && key !== last) {
      publishing = true;
      const version = linkVersion;
      void Bridge.phoneLinkPublish(snapshot.sessions, snapshot.approval).then(accepted => {
        if (version !== linkVersion) return;
        if (accepted === true) {
          last = key;
          failures = 0;
        } else {
          failures++;
          if (failures === 3) void Bridge.log("phone link: agent snapshot delivery failed after 3 attempts");
        }
      }).finally(() => {
        publishing = false;
        if (!disposed && running && failures < 3 && JSON.stringify(linkSnapshot()) !== last) schedule(false);
      });
    }
    // Auxiliary cards must not block the core agent snapshot publication.
    for (const send of [publishQuestion, publishOutfit, publishUsage, publishServices]) {
      try { send(); } catch { void Bridge.log("phone link: auxiliary snapshot could not be prepared"); }
    }
  };

  const publishQuestion = () => {
    const key = JSON.stringify(linkSnapshot().question);
    if (key === lastQuestion) return;
    lastQuestion = key;
    void Bridge.phoneLinkPublishQuestion(JSON.parse(key));
  };

  const publishOutfit = () => {
    const outfit = parseOutfit(State.settings.mochiOutfit);
    if (outfit === lastOutfit) return;
    lastOutfit = outfit;
    void Bridge.phoneLinkPublishPrefs(outfit);
  };

  const publishUsage = () => {
    const usage = linkUsage();
    const key = JSON.stringify(usage);
    if (key === lastUsage) return;
    lastUsage = key;
    void Bridge.phoneLinkPublishUsage(usage);
  };

  const publishServices = () => {
    const cards = serviceCards();
    const key = JSON.stringify(cards);
    if (key === lastServices) return;
    lastServices = key;
    void Bridge.phoneLinkPublishServices(cards);
  };

  const schedule = (resetFailures = true) => {
    if (resetFailures) failures = 0;
    if (!running || timer != null) return;
    timer = window.setTimeout(publish, DEBOUNCE_MS);
  };

  const refresh = async (force = false) => {
    const version = ++refreshVersion;
    const status = await Bridge.phoneLinkStatus();
    if (disposed || version !== refreshVersion || !status) return;
    const now = status?.running ?? false;
    if (now === running && !force) return;
    running = now;
    linkVersion++;
    failures = 0;
    last = ""; // a link that has just come up needs the whole picture
    lastQuestion = "";
    lastOutfit = "";
    lastUsage = "";
    lastServices = "";
    if (running) schedule();
    else if (timer != null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const unsubscribe = State.subscribe(() => schedule());
  // Turning the link on or off in Settings reaches the island as settings-changed.
  void onEvent("settings-changed", () => void refresh()).then(retainListener);
  // The phone answered: Rust has already told the agent; the card goes.
  void onEvent<string>("phone-link-decided", (requestId) => {
    if (State.pendingApproval?.requestId === requestId) dropPendingCard(island);
  }).then(retainListener);
  // A phone asked for a file's diff: the answer goes to that phone only (Rust cuts it to the limits).
  void onEvent<{ conn: number; pillId: string; fileId: number }>("phone-link-getdiff", (ask) => {
    if (!running || typeof ask?.conn !== "number") return;
    void Bridge.phoneLinkSendDiff(ask.conn, linkDiff(String(ask.pillId), Number(ask.fileId)));
  }).then(retainListener);
  // Listen before the initial read: startup can start the link after the
  // island's first status request, without any settings change.
  void onEvent("phone-link-status-changed", () => void refresh()).then((unlisten) => {
    if (disposed) unlisten();
    else {
      unlistenStatus = unlisten;
      void refresh();
    }
  });
  void onEvent("phone-link-sync", () => void refresh(true)).then(unlisten => {
    if (disposed) unlisten();
    else unlistenSync = unlisten;
  });
  return () => {
    disposed = true;
    unlistenStatus?.();
    unlistenSync?.();
    for (const unlisten of unlisteners) unlisten();
    unsubscribe();
    if (timer != null) window.clearTimeout(timer);
    timer = null;
    running = false;
  };
}
