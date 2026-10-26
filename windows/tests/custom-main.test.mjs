import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

test("Custom updater uses the fork for release discovery and fallback", () => {
  const source = readFileSync(new URL("../src-tauri/src/update.rs", import.meta.url), "utf8");
  assert.match(source, /pub const RELEASES_URL: &str = "https:\/\/api.github.com\/repos\/kuzeyalpyildiz\/coucou\/releases\?per_page=30"/);
  assert.match(source, /pub const RELEASES_PAGE: &str = "https:\/\/github.com\/kuzeyalpyildiz\/coucou\/releases"/);
});

test("optional dictation controls are experimental with a saved-selection escape hatch", () => {
  const source = readFileSync(new URL("../src/hub/pages/flowsettings.ts", import.meta.url), "utf8");
  assert.match(source, /VITE_EXPERIMENTAL_DICTATION === "true"/);
  assert.match(source, /experimentalDictation \|\| prefs.dictationModel === "multilingual"/);
  assert.equal((source.match(/showExperimentalDictation \? \[divider\(\)/g) ?? []).length, 2);
  assert.equal(existsSync(new URL("../src-tauri/src/speech/turkish.rs", import.meta.url)), false);
});
