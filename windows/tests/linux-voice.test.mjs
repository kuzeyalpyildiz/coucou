import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDom } from './fakedom.mjs';
import { voicePage } from '../src/hub/pages/voice.ts';

const { root } = installFakeDom();

async function page(platform, modelState = 'ready') {
  const status = {
    platform, hasClaudeKey: false,
    models: { parakeet: { state: modelState } },
    prefs: { voiceCommands: false, voice: false, enabled: false, voiceOutput: 'off', voiceGender: 'female' },
  };
  const navigations = [];
  let writes = 0;
  const ctx = {
    status, refresh: async () => status, hero: () => root(),
    setPrefs: async (change) => { writes++; change(status.prefs); },
    navigate: (destination) => navigations.push(destination),
  };
  const el = root();
  await voicePage(el, ctx);
  return { el, status, navigations, writes: () => writes };
}

test('Linux offers opt-in offline commands independently of AI and dictation', async () => {
  const f = await page('linux');
  assert.match(f.el.textContent, /Linux application menu/);
  assert.doesNotMatch(f.el.textContent, /registered Windows apps/);
  const toggle = f.el.find('.switch')[0];
  assert.ok(toggle, 'local commands switch must be present on Linux');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(f.writes(), 0, 'opening settings must not enable the microphone');
  toggle.fire('click');
  await new Promise(setImmediate);
  assert.equal(f.status.prefs.voiceCommands, true);
  assert.equal(f.status.prefs.voice, false);
  assert.equal(f.status.prefs.enabled, false);
  assert.deepEqual(f.navigations, ['voice']);
  toggle.fire('click');
  await new Promise(setImmediate);
  assert.equal(f.status.prefs.voiceCommands, false);
});

test('Windows keeps its existing app-launch help and local command switch', async () => {
  const f = await page('windows');
  assert.match(f.el.textContent, /registered Windows apps/);
  assert.doesNotMatch(f.el.textContent, /Linux application menu/);
  assert.equal(f.el.find('.switch')[0].getAttribute('aria-pressed'), 'false');
});

test('both native preference gates enable Linux, and Linux activates only GIO identities', () => {
  const voice = readFileSync(new URL('../src-tauri/src/voice/mod.rs', import.meta.url), 'utf8');
  assert.equal((voice.match(/\(store\.prefs\.voice, store\.prefs\.voice_commands\)/g) || []).length, 2);
  assert.doesNotMatch(voice, /voice_commands && cfg!\(windows\)/);
  assert.doesNotMatch(voice, /gtk-launch|fn find_app\(/);
  const linux = readFileSync(new URL('../src-tauri/src/voice/apps_linux.rs', import.meta.url), 'utf8');
  assert.match(linux, /gio::AppInfo::all\(\)/);
  assert.match(linux, /app\.should_show\(\)/);
  assert.match(linux, /matches_with_case\(wanted, names, false\)/);
  assert.doesNotMatch(linux, /std::process::Command|Command::new|\.arg\(wanted\)/);
});
