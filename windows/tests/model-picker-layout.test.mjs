import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { islandSize, chatPromptHeight, CHAT_MODEL_PICKER_H } from '../src/core/layout.ts';

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
  assert.match(rows, /flex-shrink:\s*0/);
  assert.match(rows, /min-height:\s*36px/);
  assert.match(list, /overflow-y:\s*auto/);
});
