import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { calls, sent } from './tauri.mjs';
import { State } from '../src/core/state.ts';
import { answerInTerminal } from '../src/island/terminal.ts';

beforeEach(() => {
  calls.length = 0;
  State.tasks = [];
  State.pendingApproval = null;
  State.focusId = 'other';
});

test('terminal handoff targets the requesting session, not the currently focused pill', () => {
  State.tasks = [
    { id: 'requesting', sessionId: 'asked-session', sessionCwd: 'C:\\work\\correct' },
    { id: 'other', sessionId: 'other-session', sessionCwd: 'C:\\work\\wrong' },
  ];
  State.pendingApproval = { requestId: 'request', sessionId: 'asked-session', pillId: 'requesting' };
  let closed = false;
  answerInTerminal(() => { closed = true; State.pendingApproval = null; });
  assert.equal(closed, true);
  assert.deepEqual(sent('focus_session'), [{ sessionId: 'asked-session', path: 'C:\\work\\correct' }]);
  assert.deepEqual(sent('approval_decline'), [{ requestId: 'request' }]);
  assert.equal(sent('open_session').length, 0, 'must not open an unrelated fallback editor');
  assert.equal(sent('approval_answer').length, 0, 'handoff does not answer for the user');
  assert.equal(sent('approval_decision').length, 0, 'handoff does not approve anything');
});

test('a reused agent pill cannot supply a different session folder', () => {
  State.tasks = [{ id: 'requesting', sessionId: 'new-session', sessionCwd: 'C:\\wrong' }];
  State.pendingApproval = { requestId: 'request', sessionId: 'original-session', pillId: 'requesting' };
  answerInTerminal(() => {});
  assert.deepEqual(sent('focus_session'), [{ sessionId: 'original-session', path: null }]);
});

test('no pending question means no terminal handoff', () => {
  answerInTerminal(() => assert.fail('must not close anything'));
  assert.equal(calls.length, 0);
});
