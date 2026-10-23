import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/hub/pages/flowsettings.ts", import.meta.url), "utf8");

test("Flow settings has five ordered sections with keyboard-accessible jump targets", () => {
  const sections = [...source.matchAll(/section\("([a-z]+)",/g)].map((m) => m[1]);
  assert.deepEqual(sections, ["dictation", "recognition", "notetaker", "privacy", "app"]);
  assert.match(source, /"aria-labelledby": heading\.id/);
  assert.match(source, /tabindex: -1/);
  assert.match(source, /heading\.focus\(\{ preventScroll: true \}\)/);
});

test("model selection, both downloads and all persisted preferences remain reachable", () => {
  for (const pref of ["enabled", "key", "edge", "mic", "dictationModel", "summaryEngine", "openAtLaunch", "keepDays"]) {
    assert.ok(source.includes(`p.${pref} =`), pref);
  }
  assert.match(source, /modelsControl\(ctx\)/);
  assert.match(source, /modelsControl\(ctx, undefined, "multilingual"\)/);
  assert.match(source, /modelsControl\(ctx, undefined, "turkish"\)/);
});

test("deletion stays separate and erase-all keeps its confirmation", () => {
  assert.match(source, /const deletion = card\(confirmRow\)/);
  assert.match(source, /Erase the history and the statistics\?/);
  assert.match(source, /button\(t\("Cancel"\), erase/);
  assert.ok(source.indexOf('section("privacy"') < source.indexOf("const deletion"));
});
