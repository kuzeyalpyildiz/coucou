import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

const source = readFileSync(new URL('../src-tauri/src/opencode-plugin.js', import.meta.url), 'utf8')
  .replace('{HOOK}', JSON.stringify('dummy-relay'));

async function fixture(reply, options = {}) {
  const hooks = new Map();
  const calls = [];
  const disposed = [];
  const formReplies = [];
  const context = vm.createContext({ setTimeout, clearTimeout, AbortController, AbortSignal });
  const transport = new vm.SyntheticModule(['spawn'], function () {
    this.setExport('spawn', () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdin = new EventEmitter();
      child.kill = () => {};
      child.unref = () => {};
      child.stdin.end = (data) => {
        calls.push(JSON.parse(data));
        queueMicrotask(() => {
          if (reply != null) child.stdout.emit('data', reply);
          child.emit('close', 0);
        });
      };
      return child;
    });
  }, { context });
  const module = new vm.SourceTextModule(source, { context });
  await module.link(() => transport);
  await module.evaluate();
  const hook = (domain) => async (name, fn) => {
    hooks.set(`${domain}.${name}`, fn);
    return { dispose: async () => disposed.push(`${domain}.${name}`) };
  };
  const cleanup = await module.namespace.default.setup({
    location: { directory: '/plugin' },
    session: { hook: hook('session'), get: async () => ({ location: { directory: '/session' } }), form: {
      get: async () => ({ ...options.form, state: { status: options.formState || 'pending' } }),
      reply: async (input) => formReplies.push(input),
    } },
    tool: { hook: hook('tool') },
    permission: { hook: hook('permission') },
    event: { subscribe: ({ signal }) => ({ async *[Symbol.asyncIterator]() {
      for (const event of options.events || []) yield event;
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    } }) },
  });
  return { hooks, calls, cleanup, disposed, formReplies, questionForm: module.namespace.questionForm };
}

for (const behavior of ['allow', 'deny']) {
  test(`explicit relay ${behavior} answers only the current ask`, async () => {
    const f = await fixture(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior } } }));
    try {
      const e = { sessionID: 'one', effect: 'ask', action: 'shell', resources: ['echo test'] };
      await f.hooks.get('permission.evaluate')(e);
      assert.equal(e.effect, behavior);
      assert.equal(f.calls[0].session_id, 'one');
      assert.equal(f.calls[0].cwd, '/session');
    } finally { await f.cleanup(); }
    assert.equal(f.disposed.length, 4);
  });
}

for (const reply of [null, '', 'garbage', '{}', '{"hookSpecificOutput":{"decision":{"behavior":"allow"}}}']) {
  test(`missing or invalid decision preserves native approval: ${reply}`, async () => {
    const f = await fixture(reply);
    try {
      const e = { sessionID: 'one', effect: 'ask', action: 'shell', resources: ['echo test'] };
      await f.hooks.get('permission.evaluate')(e);
      assert.equal(e.effect, 'ask');
    } finally { await f.cleanup(); }
  });
}

test('configured decisions never reach the relay; oversized requests remain native', async () => {
  const f = await fixture(null);
  try {
    for (const effect of ['allow', 'deny']) {
      await f.hooks.get('permission.evaluate')({ effect, resources: [] });
    }
    await f.hooks.get('permission.evaluate')({ effect: 'ask', resources: ['x'.repeat(2001)] });
    assert.equal(f.calls.length, 0);
  } finally { await f.cleanup(); }
});

test('prompt and failed tool notifications use the real session folder', async () => {
  const f = await fixture(null);
  try {
    await f.hooks.get('session.prompt')({ sessionID: 'one', prompt: { text: 'not forwarded' } });
    await f.hooks.get('tool.execute.after')({ sessionID: 'one', tool: 'shell', status: 'error' });
    assert.equal(f.calls[0].hook_event_name, 'UserPromptSubmit');
    assert.equal(f.calls[1].hook_event_name, 'PostToolUseFailure');
    assert.equal(f.calls[1].cwd, '/session');
    assert.equal(JSON.stringify(f.calls).includes('not forwarded'), false);
  } finally { await f.cleanup(); }
});

test('forms translate Yes/No, option labels, multiple picks and typed answers to field values', async () => {
  const f = await fixture(null);
  try {
    const converted = f.questionForm({ fields: [
      { key: 'confirm', type: 'boolean', title: 'Continue?' },
      { key: 'color', type: 'string', options: [{ label: 'Blue', value: 'blue-id' }] },
      { key: 'features', type: 'multiselect', options: [{ label: 'One', value: '1' }, { label: 'Two', value: '2' }] },
      { key: 'notes', type: 'string' },
    ] });
    const answers = Object.fromEntries(converted.input.questions.map((q, i) => [q.question, ['No', 'Blue', ['Two'], 'typed text'][i]]));
    assert.deepEqual(JSON.parse(JSON.stringify(converted.answer(answers))), {
      confirm: false, color: 'blue-id', features: ['2'], notes: 'typed text',
    });
    answers[converted.input.questions[0].question] = 'unrecognized';
    assert.equal(converted.answer(answers), null);
  } finally { await f.cleanup(); }
});

test('unsupported, conditional and ambiguous forms stay in OpenCode', async () => {
  const f = await fixture(null);
  try {
    for (const fields of [
      [{ key: 'x', type: 'external', url: 'https://example.invalid' }],
      [{ key: 'x', type: 'number' }],
      [{ key: 'x', type: 'string', hidden: true }],
      [{ key: 'x', type: 'string', when: [{ key: 'other' }] }],
      [{ key: 'x', type: 'string' }, { key: 'x', type: 'string' }],
      [{ key: 'x', type: 'string', options: [{ label: 'same', value: 'a' }, { label: 'same', value: 'b' }] }],
    ]) assert.equal(f.questionForm({ fields }), null);
  } finally { await f.cleanup(); }
});

for (const state of ['pending', 'answered', 'cancelled']) {
  test(`a question response is submitted only to its original pending form: ${state}`, async () => {
    const form = { id: 'frm_one', sessionID: 'ses_one', fields: [{ key: 'notes', type: 'string', title: 'Notes' }] };
    const response = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: {
      behavior: 'allow', updatedInput: { answers: { 'Notes (1)': 'my answer' } },
    } } });
    const f = await fixture(response, { form, formState: state, events: [
      { type: 'form.created', location: { directory: '/plugin' }, data: { form } },
    ] });
    try {
      await new Promise(setImmediate);
      assert.equal(f.formReplies.length, state === 'pending' ? 1 : 0);
      if (state === 'pending') assert.deepEqual(JSON.parse(JSON.stringify(f.formReplies[0])), {
        sessionID: 'ses_one', formID: 'frm_one', answer: { notes: 'my answer' },
      });
    } finally { await f.cleanup(); }
  });
}

test('events for another location do not show a question card', async () => {
  const form = { id: 'frm_one', sessionID: 'ses_one', fields: [{ key: 'notes', type: 'string' }] };
  const f = await fixture(null, { form, events: [
    { type: 'form.created', location: { directory: '/other' }, data: { form } },
  ] });
  try {
    await new Promise(setImmediate);
    assert.equal(f.calls.length, 0);
  } finally { await f.cleanup(); }
});
