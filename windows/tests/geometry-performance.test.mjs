import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Exercise the actual frame-loop method without starting a native window.
const source = readFileSync(new URL('../src/island/island.ts', import.meta.url), 'utf8');
const start = source.indexOf('  private applyGeometry() {');
const body = source.slice(start + '  private applyGeometry() {'.length, source.indexOf('\n  }', start));

test('settled geometry avoids style writes but still tracks viewport changes', () => {
  let writes = 0;
  const node = () => ({ style: new Proxy({}, {
    set(target, key, value) { writes++; target[key] = value; return true; },
  }) });
  const calls = [];
  const viewport = { innerWidth: 720 };
  const apply = new Function('Bridge', 'window', 'PANEL_W', 'EXPANDED_W', body);
  const bridge = { setIslandRect: (...args) => calls.push(args) };
  const island = {
    width: { value: 640 }, height: { value: 320 }, radius: { value: 22 },
    drawnGeometry: { w: NaN, h: NaN, r: NaN },
    pushedRect: { x: -1, y: -1, w: -1, h: -1 },
    islandEl: node(), miniGrid: node(), greetingCanvas: node(), uploadCanvas: { el: node() },
  };
  const frame = () => apply.call(island, bridge, viewport, 720, 640);
  frame();
  assert.ok(writes > 0);
  writes = 0;
  for (let i = 0; i < 120; i++) frame();
  assert.equal(writes, 0, 'Mochi animation must not rewrite settled panel styles');
  assert.equal(calls.length, 1);
  viewport.innerWidth = 600;
  frame();
  assert.equal(writes, 0);
  assert.deepEqual(calls.at(-1), [-20, 0, 640, 320]);
  island.height.value = 280;
  frame();
  assert.equal(writes, 2, 'height updates only the panel height and mini-grid top');
  assert.equal(island.islandEl.style.height, '280px');
  assert.equal(calls.at(-1)[3], 280);
});
