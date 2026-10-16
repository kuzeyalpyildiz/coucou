import { test } from "node:test";
import assert from "node:assert/strict";
import { openCodePillId } from "../src/island/session-routing.ts";

test("OpenCode session routing preserves the configured pill and reuses session identity", () => {
  assert.equal(openCodePillId([], "first"), "agent_opencode");
  const tasks = [{ id: "agent_opencode", sessionId: "first", state: "working" }];
  assert.equal(openCodePillId(tasks, "first"), "agent_opencode");
  assert.equal(openCodePillId(tasks, "second"), "agent_opencode_session_1");
  tasks.push({ id: "agent_opencode_session_1", sessionId: "second", state: "question" });
  assert.equal(openCodePillId(tasks, "second"), "agent_opencode_session_1");
  assert.equal(openCodePillId(tasks, "third"), "agent_opencode_session_2");
});

test("session display IDs do not contain user paths or untrusted session text", () => {
  const tasks = [{ id: "agent_opencode", sessionId: "first", state: "working" }];
  const id = openCodePillId(tasks, "C:\\private\\project\nsecret");
  assert.equal(id, "agent_opencode_session_1");
  assert.ok(id.length < 64);
});

test("session routing is bounded and never evicts an existing active session", () => {
  const tasks = Array.from({ length: 32 }, (_, i) => ({
    id: i === 0 ? "agent_opencode" : `agent_opencode_session_${i}`,
    sessionId: `s${i}`, state: "working",
  }));
  assert.equal(openCodePillId(tasks, "extra"), null);
  assert.equal(openCodePillId(tasks, "s17"), "agent_opencode_session_17");
  assert.equal(tasks.length, 32);
});
