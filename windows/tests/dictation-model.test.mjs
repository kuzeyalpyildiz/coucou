import { test } from "node:test";
import assert from "node:assert/strict";
import { dictationModelState } from "../src/core/flow.ts";

test("old preferences retain Parakeet even when optional model is installed", () => {
  assert.deepEqual(dictationModelState({ prefs: {}, models: {
    parakeet: { state: "missing" }, multilingual: { state: "ready" },
  } }), { state: "missing" });
});

test("Turkish selection uses only the optional model readiness", () => {
  assert.deepEqual(dictationModelState({ prefs: { dictationModel: "multilingual" }, models: {
    parakeet: { state: "missing" }, multilingual: { state: "ready" },
  } }), { state: "ready" });
});

test("missing Turkish model never silently falls back to Parakeet", () => {
  assert.deepEqual(dictationModelState({ prefs: { dictationModel: "multilingual" }, models: {
    parakeet: { state: "ready" },
  } }), { state: "missing" });
});

test("Turkish Zipformer selection uses only the turkish model readiness", () => {
  assert.deepEqual(dictationModelState({ prefs: { dictationModel: "turkish" }, models: {
    parakeet: { state: "missing" }, turkish: { state: "ready" },
  } }), { state: "ready" });
});

test("missing Turkish Zipformer model never silently falls back to Parakeet", () => {
  assert.deepEqual(dictationModelState({ prefs: { dictationModel: "turkish" }, models: {
    parakeet: { state: "ready" },
  } }), { state: "missing" });
});

test("Turkish Zipformer model progress and failures are surfaced", () => {
  for (const state of [{ state: "downloading", fraction: 0.5 }, { state: "failed", error: "network" }]) {
    assert.deepEqual(dictationModelState({ prefs: { dictationModel: "turkish" }, models: {
      parakeet: { state: "ready" }, turkish: state,
    } }), state);
  }
});

test("optional model progress and failures are surfaced", () => {
  for (const state of [{ state: "downloading", fraction: 0.3 }, { state: "failed", error: "checksum mismatch" }]) {
    assert.deepEqual(dictationModelState({ prefs: { dictationModel: "multilingual" }, models: {
      parakeet: { state: "ready" }, multilingual: state,
    } }), state);
  }
});
