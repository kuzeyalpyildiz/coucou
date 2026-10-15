import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadSaved } from '../src/hub/load.ts';

test('startup retries unavailable IPC and keeps saved toggles and model readiness', async () => {
  let reads = 0;
  let waits = 0;
  const saved = { prefs: { enabled: true, voiceCommands: true }, models: { parakeet: { state: 'ready' } } };
  const result = await loadSaved(async () => ++reads < 3 ? null : saved, async () => { waits++; });
  assert.equal(result, saved);
  assert.equal(reads, 3);
  assert.equal(waits, 2);
});

test('history and word totals load their real saved values after a transient failure', async () => {
  let reads = 0;
  const stats = { all: { words: 1234, wordsPerMinute: 95 }, streak: 3 };
  assert.equal(await loadSaved(async () => {
    if (++reads === 1) throw new Error('native startup');
    return stats;
  }, async () => {}), stats);
  assert.deepEqual(await loadSaved(async () => []), []);
  assert.equal(await loadSaved(async () => 0), 0);
});

test('failed reads stop after five attempts instead of inventing empty saved data', async () => {
  let reads = 0;
  let waits = 0;
  await assert.rejects(loadSaved(async () => { reads++; return null; }, async () => { waits++; }));
  assert.equal(reads, 5);
  assert.equal(waits, 4);
});

test('native saved Flow data is registered before the settings webview starts', () => {
  const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const setup = lib.slice(lib.indexOf('.setup(move |app|'));
  assert.ok(setup.indexOf('flow::prepare(&handle)') >= 0);
  assert.ok(setup.indexOf('flow::prepare(&handle)') < setup.indexOf('create_settings_window(&handle)'));
  const flow = readFileSync(new URL('../src-tauri/src/flow/mod.rs', import.meta.url), 'utf8');
  const prepare = flow.slice(flow.indexOf('pub fn prepare('), flow.indexOf('pub fn setup('));
  assert.match(prepare, /Store::load\(\)/);
  assert.match(prepare, /app\.manage\(flow\)/);
  assert.doesNotMatch(prepare, /pill::setup|enable\(app|voice::sync/);
});
