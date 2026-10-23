import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (file) => readFileSync(new URL(`../src-tauri/src/${file}`, import.meta.url), 'utf8');

// Source-contract checks complement native lifecycle tests; they do not measure RAM.
test('dictation never preloads Parakeet in the optional-model branch', () => {
  const flow = source('flow/mod.rs');
  const begin = flow.slice(flow.indexOf('fn begin('), flow.indexOf('fn finish('));
  const preload = begin.slice(begin.indexOf('match model {', begin.indexOf('match capture {')));
  const optional = preload.slice(preload.indexOf('store::DictationModel::Multilingual =>'));
  assert.match(preload, /store::DictationModel::Parakeet =>[\s\S]*speech::preload\(\)/);
  assert.doesNotMatch(optional, /speech::preload\(\)/);
  assert.match(optional, /!crate::voice::is_listening\(\) && !crate::notes::is_recording\(app\)/);
  assert.match(optional, /speech::unload_parakeet\(\)/);
  assert.match(preload, /speech::multilingual::unload\(\)/);
  assert.match(preload, /speech::turkish::unload\(\)/);
});

test('optional model idleness is independent of wake-word activity', () => {
  const optional = source('speech/multilingual.rs');
  assert.match(optional, /last_used: Option<Instant>/);
  assert.doesNotMatch(optional, /super::mark_used\(\)/);
  const lib = source('lib.rs');
  assert.match(lib, /speech::multilingual::unload_if_idle\(flow::is_dictating\(\)\)/);
  assert.match(lib, /speech::turkish::unload_if_idle\(flow::is_dictating\(\)\)/);
  const speech = source('speech/mod.rs');
  const idle = speech.slice(speech.indexOf('pub fn unload_if_idle('), speech.indexOf('pub struct Transcript'));
  assert.match(idle, /unload_parakeet\(\)/);
  assert.doesNotMatch(idle, /\bunload\(\)/);
});

test('cache release cancels queued Parakeet preloads and diagnostics name both models', () => {
  const speech = source('speech/mod.rs');
  const release = speech.slice(speech.indexOf('pub fn unload_parakeet('), speech.indexOf('pub fn unload()'));
  assert.match(release, /preload_generation\(\)\.fetch_add/);
  assert.match(release, /load_lock\(\)\.lock\(\)/);
  assert.match(speech, /recognizer_for_preload\(Some\(generation\)\)/);
  const memory = source('memory.rs');
  assert.match(memory, /pub parakeet_loaded: bool/);
  assert.match(memory, /pub multilingual_loaded: bool/);
  assert.match(memory, /pub turkish_loaded: bool/);
});
