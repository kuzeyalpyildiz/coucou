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
  const warnings = [];
  const context = vm.createContext({ setTimeout, clearTimeout, AbortController, AbortSignal, TextEncoder,
    process: { platform: 'win32' }, console: { warn: (message) => warnings.push(message) } });
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
  const api = new vm.SyntheticModule(['OpenCode', 'Service'], function () {
    this.setExport('OpenCode', { make: () => ({ session: { form: {
      get: async () => ({ ...options.form, state: { status: options.formState || 'pending' } }),
      reply: async (input) => formReplies.push(input),
    } }, form: { list: async () => ({ data: options.pendingForms || [] }) } }) });
    this.setExport('Service', { discover: async () => options.noService ? undefined : { url: 'http://local.test' }, headers: () => ({}) });
  }, { context });
  await api.link(() => { throw new Error('Unexpected dependency'); });
  await api.evaluate();
  const module = new vm.SourceTextModule(source, { context, importModuleDynamically: async (specifier) => {
    assert.ok(['@opencode/client', '@opencode/client/service'].includes(specifier));
    if (options.missingClient) throw new Error('Package unavailable');
    return api;
  } });
  await module.link(() => transport);
  await module.evaluate();
  const hook = (domain) => async (name, fn) => {
    hooks.set(`${domain}.${name}`, fn);
    return { dispose: async () => disposed.push(`${domain}.${name}`) };
  };
  const cleanup = await module.namespace.default.setup({
    location: { directory: '/plugin' },
    // Deliberately matches the real plugin SessionDomain: no form API here.
    session: { hook: hook('session'), get: async () => ({ location: { directory: '/session' } }) },
    tool: { hook: hook('tool') },
    permission: { hook: hook('permission') },
    event: { subscribe: ({ signal }) => ({ async *[Symbol.asyncIterator]() {
      for (const event of options.events || []) yield event;
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    } }) },
  });
  return { hooks, calls, cleanup, disposed, formReplies, warnings,
    questionForm: module.namespace.questionForm, sameDirectory: module.namespace.sameDirectory };
}

test('idle, busy and retry statuses do not imply session completion', async () => {
  const f = await fixture(null, { events: [
    { type: 'session.status', data: { sessionID: 'busy', status: { type: 'busy' } } },
    { type: 'session.status', data: { sessionID: 'retry', status: { type: 'retry' } } },
    { type: 'session.status', data: { sessionID: 'done', status: { type: 'idle' } } },
    { type: 'session.idle', data: { sessionID: 'legacy-idle' } },
  ] });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    const stops = f.calls.filter(call => call.hook_event_name === 'Stop');
    assert.equal(stops.length, 0);
  } finally { await f.cleanup(); }
});

test('the live V2 execution-success event completes a task, not an intermediate model step', async () => {
  const f = await fixture(null, { events: [
    { type: 'session.step.ended', data: { sessionID: 'one', finish: 'tool-calls' } },
    { type: 'session.step.ended', data: { sessionID: 'one', finish: 'stop' } },
    { type: 'session.execution.succeeded', data: { sessionID: 'one' } },
  ] });
  try {
    await new Promise(setImmediate);
    const stops = f.calls.filter(call => call.hook_event_name === 'Stop');
    assert.equal(stops.length, 1);
    assert.equal(stops[0].session_id, 'one');
  } finally { await f.cleanup(); }
});

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

test('the visible question uses its full description, without a generated number or field key', async () => {
  const f = await fixture(null);
  try {
    const text = 'If you could have a tiny dragon, what would you name it?';
    const converted = f.questionForm({ fields: [{
      key: 'internal-question-0', title: 'Random question', description: text, type: 'string',
    }] });
    assert.equal(converted.input.questions[0].question, text);
    assert.deepEqual(JSON.parse(JSON.stringify(converted.answer({ [text]: 'Toast' }))), {
      'internal-question-0': 'Toast',
    });
  } finally { await f.cleanup(); }
});

test('questions without descriptions fall back to the heading or key without adding a suffix', async () => {
  const f = await fixture(null);
  try {
    const converted = f.questionForm({ fields: [
      { key: 'one', title: 'Your answer', description: '   ', type: 'string' },
      { key: 'two', type: 'string' },
    ] });
    assert.deepEqual(Array.from(converted.input.questions, (q) => q.question), ['Your answer', 'two']);
    assert.equal(f.questionForm({ fields: [
      { key: 'one', description: 'Same question?', type: 'string' },
      { key: 'two', description: 'Same question?', type: 'string' },
    ] }), null);
  } finally { await f.cleanup(); }
});

for (const state of ['pending', 'answered', 'cancelled']) {
  test(`a question response is submitted only to its original pending form: ${state}`, async () => {
    const form = { id: 'frm_one', sessionID: 'ses_one', fields: [{ key: 'notes', type: 'string', title: 'Notes' }] };
    const response = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: {
      behavior: 'allow', updatedInput: { answers: { 'Notes': 'my answer' } },
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

test('ordinary multi-question forms over 1800 characters reach the relay and return answers', async () => {
  const fields = Array.from({ length: 3 }, (_, i) => ({
    key: `q${i}`, type: 'string', description: `Question ${i}: ${'text '.repeat(50)}`,
    options: Array.from({ length: 4 }, (_, j) => ({ label: `Choice ${j}`, value: `value${j}`, description: 'Details '.repeat(20) })),
  }));
  const form = { id: 'frm_long', sessionID: 'ses_one', fields };
  const answers = Object.fromEntries(fields.map((field) => [field.description, 'Choice 1']));
  const response = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: {
    behavior: 'allow', updatedInput: { answers },
  } } });
  const f = await fixture(response, { form, events: [
    { type: 'form.created', location: { directory: '/plugin' }, data: { form } },
  ] });
  try {
    await new Promise(setImmediate);
    const request = f.calls.find((call) => call.hook_event_name === 'PermissionRequest');
    assert.ok(request, 'the full form must reach the desktop instead of silently staying native');
    assert.ok(JSON.stringify(request.tool_input).length > 1800);
    assert.deepEqual(request.tool_input.questions.map((q) => q.question), fields.map((field) => field.description));
    assert.equal(f.formReplies.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(f.formReplies[0].answer)), { q0: 'value1', q1: 'value1', q2: 'value1' });
  } finally { await f.cleanup(); }
});

test('question fields obey relay byte limits without truncating answer keys or labels', async () => {
  const f = await fixture(null);
  try {
    assert.ok(f.questionForm({ fields: [{ key: 'x', type: 'string', description: 'é'.repeat(1000) }] }));
    assert.equal(f.questionForm({ fields: [{ key: 'x', type: 'string', description: 'é'.repeat(1001) }] }), null);
    assert.equal(f.questionForm({ fields: [{ key: 'x', type: 'string', options: [{ label: '界'.repeat(667), value: 'x' }] }] }), null);
  } finally { await f.cleanup(); }
});

test('a declined duplicate relay must not close another instance\'s active card', async () => {
  const form = { id: 'frm_duplicate', sessionID: 'ses_one', fields: [{ key: 'notes', type: 'string' }] };
  const f = await fixture(null, { form, events: [
    { type: 'form.created', location: { directory: '/plugin' }, data: { form } },
  ] });
  try {
    await new Promise(setImmediate);
    assert.equal(f.calls.filter((c) => c.hook_event_name === 'PermissionRequest').length, 1);
    assert.equal(f.calls.some((c) => c.hook_event_name === 'OpenCodeFormClosed'), false);
    assert.equal(f.formReplies.length, 0);
  } finally { await f.cleanup(); }
});

test('Windows folder comparisons ignore case and slash differences, not different folders', async () => {
  const f = await fixture(null);
  try {
    assert.equal(f.sameDirectory('C:\\Users\\North\\Desktop\\Swap', 'c:/users/north/desktop/swap/'), true);
    assert.equal(f.sameDirectory('/Project', '/project', false), false);
    assert.equal(f.sameDirectory('C:\\one', 'C:\\two'), false);
  } finally { await f.cleanup(); }
});

for (const missing of ['missingClient', 'noService']) {
  test(`unavailable form client leaves native questions untouched: ${missing}`, async () => {
    const form = { id: 'frm_one', sessionID: 'ses_one', fields: [{ key: 'notes', type: 'string' }] };
    const f = await fixture(null, { [missing]: true, form, events: [
      { type: 'form.created', location: { directory: '/plugin' }, data: { form } },
    ] });
    try {
      await new Promise(setImmediate);
      assert.equal(f.calls.length, 0);
      assert.equal(f.formReplies.length, 0);
      if (missing === 'missingClient') assert.equal(f.warnings.length, 1);
    } finally { await f.cleanup(); }
  });
}
