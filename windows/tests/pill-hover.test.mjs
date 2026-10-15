import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Run the real rendering method with a DOM that records capsule detachment.
const source = readFileSync(new URL('../src/pill/main.ts', import.meta.url), 'utf8');
const render = source.slice(source.indexOf('function render() {'), source.indexOf('\nfunction reportHot()'));

test('tooltip changes preserve the capsule and its clickable buttons', () => {
  let detachments = 0;
  class Element {
    children = [];
    style = {};
    parentElement = null;
    classList = { toggle() {} };
    constructor(className = '') { this.className = className; }
    append(node) { node.remove(); this.children.push(node); node.parentElement = this; }
    remove() {
      if (!this.parentElement) return;
      if (this.className === 'capsule') detachments++;
      this.parentElement.children = this.parentElement.children.filter(x => x !== this);
      this.parentElement = null;
    }
    insertBefore(node, before) {
      node.remove();
      this.children.splice(this.children.indexOf(before), 0, node);
      node.parentElement = this;
    }
    replaceChildren(...nodes) { for (const n of [...this.children]) n.remove(); for (const n of nodes) this.append(n); }
    querySelectorAll(cls) { return this.children.filter(n => `.${n.className}` === cls); }
  }
  const root = new Element();
  let tip = false;
  const buttons = ['dictate', 'note', 'hub'].map(name => new Element(name));
  const make = new Function('root', 'el', 'content', 'bubble', `
    const state = { edge: 'bottom', phase: 'idle', key: 'right_ctrl', noteStartedAt: null, voice: null };
    const platform = 'windows', RESTING_LENGTH = 44, OPEN_THICKNESS = 34, RESTING_THICKNESS = 8;
    const look = () => 'toolbar', vertical = () => false, openLength = () => 150;
    const mochi = { setState() {} }, wake = () => {}, reportHot = () => {};
    const requestAnimationFrame = fn => fn(), setTimeout = () => {};
    let capsule = null, lastKey = '';
    ${render}
    return { render, capsule: () => capsule };
  `);
  const ui = make(root, (_, cls) => new Element(cls), () => {
    const content = new Element('content');
    for (const b of buttons) content.append(b);
    return content;
  }, () => tip ? new Element('bubble') : null);
  ui.render();
  const original = ui.capsule();
  for (let i = 0; i < 10; i++) {
    tip = !tip;
    ui.render();
    assert.equal(ui.capsule(), original);
    assert.equal(original.parentElement, root);
    for (const button of buttons) assert.equal(button.parentElement.parentElement, original);
  }
  assert.equal(detachments, 0, 'hovering must not detach the pointer/click target');
});

test('side-mounted capsules stay at their edge when tooltips appear', () => {
  const css = readFileSync(new URL('../src/pill/pill.css', import.meta.url), 'utf8');
  assert.match(css, /\.vertical \.capsule\s*\{\s*order:\s*-1/);
});
