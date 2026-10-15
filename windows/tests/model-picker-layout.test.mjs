import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { islandSize, chatPromptHeight, CHAT_MODEL_PICKER_H, PANEL_H, fitExpandedHeight, fitExpandedSize } from '../src/core/layout.ts';

test('the model picker grows vertically without widening the notch', () => {
  for (const count of [0, 1, 10]) {
    const chat = islandSize('expanded', 'prompt', count);
    const picker = islandSize('expanded', 'prompt', count, true);
    assert.equal(picker.w, chat.w);
    assert.equal(picker.h, CHAT_MODEL_PICKER_H);
    assert.ok(picker.h > chat.h);
    assert.equal(chatPromptHeight(count, false), chat.h);
  }
});

test('picker state does not enlarge compact or unrelated views', () => {
  for (const mode of ['hidden', 'compact']) {
    assert.deepEqual(islandSize(mode, 'prompt', 0, true), islandSize(mode, 'prompt'));
  }
  assert.deepEqual(islandSize('expanded', 'overview', 0, true), islandSize('expanded', 'overview'));
});

test('model rows cannot be flex-compressed and the list scrolls vertically', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  const rows = css.match(/\.picker-model\s*\{([^}]+)\}/)[1];
  const list = css.match(/\.picker-list\s*\{([^}]+)\}/)[1];
  const picker = css.match(/\.picker\s*\{([^}]+)\}/)[1];
  assert.match(rows, /flex-shrink:\s*0/);
  assert.match(rows, /min-height:\s*36px/);
  assert.match(list, /overflow-y:\s*auto/);
  assert.match(list, /min-height:\s*0/);
  assert.match(picker, /min-height:\s*0/);
  assert.match(picker, /overflow:\s*hidden/);
  assert.match(css, /\.chat-body\.picking > \.chat-bar\s*\{\s*flex-shrink:\s*0/);
  assert.equal(CHAT_MODEL_PICKER_H, 320, 'the picker stays at the requested height, regardless of model count');
});

test('native and frontend panels both have room for the taller picker', () => {
  const rust = readFileSync(new URL('../src-tauri/src/island.rs', import.meta.url), 'utf8');
  const nativeHeight = Number(rust.match(/pub const PANEL_H: f64 = ([\d.]+);/)[1]);
  assert.equal(nativeHeight, PANEL_H);
  assert.ok(nativeHeight >= CHAT_MODEL_PICKER_H + 32);
});

test('expanded content fits smaller viewports and recovers after the wake strip', () => {
  assert.equal(fitExpandedHeight(320, 360), 320);
  assert.equal(fitExpandedHeight(320, 320), 304);
  assert.equal(fitExpandedHeight(320, 240), 224);
  assert.equal(fitExpandedHeight(320, 6), 320);
  assert.equal(fitExpandedHeight(240, 480), 240);
});

test('picker stays inside narrow or short DPI-adjusted viewports', () => {
  for (const [width, height] of [[720, 360], [600, 300], [400, 240], [300, 180]]) {
    const fitted = fitExpandedSize(640, CHAT_MODEL_PICKER_H, width, height);
    assert.ok(fitted.w <= width - 16);
    assert.ok(fitted.h <= height - 16);
    assert.ok(fitted.h <= 320);
  }
  assert.deepEqual(fitExpandedSize(640, 320, 720, 360), { w: 640, h: 320 });
  assert.deepEqual(fitExpandedSize(640, 320, 240, 6), { w: 640, h: 320 });
  assert.deepEqual(fitExpandedSize(640, 320, NaN, NaN), { w: 640, h: 320 });
});

test('native panel sizing uses the selected monitor work area and scale', () => {
  const rust = readFileSync(new URL('../src-tauri/src/island.rs', import.meta.url), 'utf8');
  const geometry = rust.slice(rust.indexOf('pub fn apply_geometry('), rust.indexOf('// GTK never sizes'));
  assert.match(geometry, /m\.work_area\(\)/);
  assert.match(geometry, /wa\.size\.width as f64 \/ scale/);
  assert.match(geometry, /wa\.size\.height as f64 \/ scale/);
  assert.match(geometry, /PANEL_W\.min\(available_w\)/);
});
