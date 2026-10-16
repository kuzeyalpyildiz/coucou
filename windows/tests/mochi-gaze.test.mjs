import { test } from "node:test";
import assert from "node:assert/strict";
import { BotEngine, BOT_STATES } from "../src/mochi/engine.ts";
import { gaze } from "../src/mochi/desktop-logic.ts";

for (const state of ["idle", "working", "thinking", "approval", "question"]) {
  test(`${state}: the main Mochi can look into every pointer quadrant`, () => {
    const engine = new BotEngine();
    engine.state = state;
    engine.cfg = BOT_STATES[state];
    for (const x of [-1, 1]) {
      for (const y of [-1, 1]) {
        engine.lookX = x;
        engine.lookY = y;
        engine.update(1 / 60);
        assert.equal(Math.sign(engine.tgYaw), x, `horizontal ${x}`);
        assert.equal(Math.sign(engine.tgPitch), y, `vertical ${y}`);
        assert.ok(Number.isFinite(engine.yaw) && Number.isFinite(engine.pitch));
      }
    }
  });
}

test("thinking retains its expression at a neutral pointer position", () => {
  const engine = new BotEngine();
  engine.state = "thinking";
  engine.cfg = BOT_STATES.thinking;
  engine.update(1 / 60);
  assert.ok(engine.tgYaw > 0 && engine.tgPitch > 0);
});

test("gaze uses both window offsets and is invariant under moving the island", () => {
  for (const origin of [{ x: 0, y: 0 }, { x: 280, y: 160 }, { x: -720, y: -400 }]) {
    const bot = { x: origin.x + 60, y: origin.y + 45 };
    const center = gaze(bot, bot);
    assert.equal(Math.abs(center.lookX), 0);
    assert.equal(Math.abs(center.lookY), 0);
    for (const dx of [-1000, 1000]) {
      for (const dy of [-1000, 1000]) {
        const look = gaze(bot, { x: bot.x + dx, y: bot.y + dy });
        assert.deepEqual(look, gaze({ x: 60, y: 45 }, { x: 60 + dx, y: 45 + dy }));
        assert.equal(Math.sign(look.lookX), Math.sign(dx));
        assert.equal(Math.sign(look.lookY), -Math.sign(dy));
      }
    }
  }
});
