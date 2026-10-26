// Flow → Settings: the key, where the pill is, the microphone, the voice
// model, the Notetaker's summaries, the window and the history. Port of
// FlowHubSettings.swift.

import { h, clear } from "../../views/dom";
import { t } from "../../i18n/i18n";
import { onEvent } from "../../core/bridge";
import { FlowBridge, type Edge, type FlowKey, type ModelsStatus } from "../../core/flow";
import type { HubContext } from "../shell";
import { button, card, divider, keyKeycap, keycap, number, row, segmented, select, toggle } from "../ui";

// Optional speech models remain available to experimental builds only. Keep
// saved preferences and downloaded files intact for users returning from dev.
const experimentalDictation = import.meta.env?.VITE_EXPERIMENTAL_DICTATION === "true";

/** Download / progress / installed, for the voice model. Redraws itself. */
export function modelsControl(ctx: HubContext, onReady?: () => void, kind: "parakeet" | "multilingual" = "parakeet"): HTMLElement {
  const el = h("div", { style: "display:flex;align-items:center;gap:8px" });
  let confirming = false;
  const state = (models: ModelsStatus) => models[kind] ?? { state: "missing" as const };
  const download = () => kind === "parakeet" ? FlowBridge.download() : FlowBridge.downloadMultilingual();
  const remove = () => kind === "parakeet" ? FlowBridge.removeModels() : FlowBridge.removeMultilingual();
  const run = (action: () => Promise<unknown>) => { void action().catch((err: unknown) => { el.append(h("span", { class: "hub-note", text: String(err) })); }); };
  let lastState = state(ctx.status.models).state;
  const draw = (models: ModelsStatus) => {
    lastState = state(models).state;
    clear(el);
    const m = state(models);
    if (m.state === "missing") {
      el.append(button(t("Download"), () => run(download), "primary"));
    } else if (m.state === "downloading") {
      const bar = h("div", { class: "hub-progress" }, h("i", { style: `width:${Math.round(m.fraction * 100)}%` }));
      el.append(bar, h("span", { class: "hub-note", text: `${Math.round(m.fraction * 100)} %` }));
    } else if (m.state === "failed") {
      el.append(h("span", { class: "hub-note", text: m.error, title: m.error, style: "max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }));
      el.append(button(t("Retry"), () => run(download)));
    } else if (confirming) {
      el.append(
        button(t("Remove the models"), () => {
          confirming = false;
          run(remove);
        }, "danger", true),
        button(t("Cancel"), () => {
          confirming = false;
          draw(ctx.status.models);
        }, "", true),
      );
    } else {
      const ok = h("button", { class: "hub-link", style: "color:var(--hub-green)", text: `✓ ${t("Installed")}`, title: t("Remove the models") });
      ok.addEventListener("click", () => {
        confirming = true;
        draw(ctx.status.models);
      });
      el.append(ok);
    }
  };
  draw(ctx.status.models);
  void onEvent<ModelsStatus>("speech-models", (models) => {
    if (!el.isConnected) return;
    const wasReady = lastState === "ready";
    ctx.status.models = models;
    draw(models);
    if (!wasReady && state(models).state === "ready") onReady?.();
  });
  return el;
}

export async function flowSettingsPage(page: HTMLElement, ctx: HubContext) {
  const status = await ctx.refresh();
  const prefs = status.prefs;
  // Let existing experimental users switch back without rewriting preferences.
  const showExperimentalDictation = experimentalDictation || prefs.dictationModel === "multilingual";
  page.append(ctx.hero("flowsettings", t("Settings"), null));

  // In-page navigation only: keep the sidebar and saved page routes unchanged.
  const index = h("nav", { class: "hub-settings-index", "aria-label": t("Settings") });
  page.append(index);
  const section = (id: string, title: string) => {
    const heading = h("h2", { id: `flow-settings-${id}`, class: "hub-settings-heading", tabindex: -1, text: title });
    const group = h("section", { class: "hub-settings-section", "aria-labelledby": heading.id }, heading);
    const jump = button(title, () => {
      heading.scrollIntoView({ block: "start", behavior: "instant" });
      heading.focus({ preventScroll: true });
    });
    jump.setAttribute("aria-controls", heading.id);
    index.append(jump);
    page.append(group);
    return group;
  };

  // ── Keys ──
  const dictation = section("dictation", t("Dictation"));
  const keys: [FlowKey, string][] = [
    ["right_ctrl", t("Right {0}", { 0: "Ctrl" })],
    ["right_alt", t("Right {0}", { 0: "Alt" })],
    ["right_shift", t("Right {0}", { 0: "Shift" })],
    ["left_ctrl_super", status.platform === "windows" ? "Ctrl + Win" : "Ctrl + Super"],
  ];
  const edges: [Edge, string][] = [["bottom", t("Bottom")], ["left", t("Left")], ["right", t("Right")]];
  const keysCard = card(
    row(t("Hold a key to dictate anywhere"), null, toggle(prefs.enabled, (on) => void ctx.setPrefs((p) => (p.enabled = on)))),
    divider(),
    status.keys === "wayland"
      ? row(t("Hold to dictate"), null, keyKeycap("wayland", status.platform))
      : row(t("Hold to dictate"), prefs.key === "right_alt" ? t("On a keyboard with AltGr, the right Alt types characters: pick another key.") : null,
        select(keys, prefs.key, (key) => void ctx.setPrefs((p) => (p.key = key)).then(() => ctx.navigate("flowsettings")))),
    divider(),
    row(t("Hands-free"), t("Tap twice, speak as long as you like, tap once to paste."), keyKeycap(status.keys === "wayland" ? "wayland" : prefs.key, status.platform, true)),
    divider(),
    row(t("Paste the last dictation again"), t("When the words went to the wrong place."), button(t("Paste again"), () => void FlowBridge.pasteAgain(), "", true)),
    divider(),
    row(t("Cancel a dictation"), null, keycap(t("Esc"))),
  );
  if (status.keys === "wayland") {
    keysCard.append(h("div", {
      class: "hub-warn",
      text: t("On Wayland, the desktop holds the dictation key for Coucou: Ctrl+Alt+V, or the keys you picked when it asked. The first paste asks once to let Coucou type for you."),
    }));
  } else if (status.keys !== "ok") {
    keysCard.append(h("div", { class: "hub-warn", text: t("Coucou can't watch the keyboard here: use the pill's microphone to dictate.") }));
  }
  dictation.append(keysCard);

  // ── Audio input, active engine, then model downloads ──
  const recognition = section("recognition", t("Recognition"));
  const mics: [string, string][] = [["", t("System default")], ...status.mics.map((m): [string, string] => [m.name, m.name])];
  if (prefs.mic && !mics.some(([id]) => id === prefs.mic)) mics.push([prefs.mic, prefs.mic]);
  recognition.append(card(
    row(t("Microphone"), t("The one Coucou listens to for dictation and calls."), select(mics, prefs.mic, (mic) => void ctx.setPrefs((p) => (p.mic = mic)))),
    ...(showExperimentalDictation ? [divider(),
      row(t("Dictation model"), t("Only affects dictation. Calls and OK Coucou keep Parakeet."), select<"parakeet" | "multilingual">([["parakeet", "Parakeet (default)"], ["multilingual", "Omnilingual — Türkçe / Turkish"]], prefs.dictationModel ?? "parakeet", (model) => void ctx.setPrefs((p) => (p.dictationModel = model)))),
    ] : []),
  ));
  recognition.append(card(
    row(t("Parakeet, on your computer"), t("The most accurate, offline, 25 languages. Downloaded once (about {0} MB).", { 0: number(status.models.downloadMb) }), modelsControl(ctx)),
    h("div", { class: "hub-note", text: t("Your voice never leaves this computer: Parakeet turns it into text here, and the recording is dropped as soon as it is pasted.") }),
    ...(showExperimentalDictation ? [divider(),
      row(t("Omnilingual — Turkish dictation"), t("Optional offline model, about {0} MB. Supports Turkish; accuracy varies by language. Download separately, then select above.", { 0: status.models.multilingualDownloadMb ?? 366 }), modelsControl(ctx, undefined, "multilingual")),
    ] : []),
  ));

  // ── Notetaker ──
  const notetaker = section("notetaker", t("Notetaker"));
  notetaker.append(card(
    row(t("Summaries"), null, select([["claude", t("Claude (your key)")], ["off", t("No summary")]], prefs.summaryEngine, (engine) => void ctx.setPrefs((p) => (p.summaryEngine = engine)))),
    h("div", { class: "hub-note", text: t("With Claude, the transcript (never the audio) goes to Anthropic with your key from Notch → Chat.") }),
    h("div", { class: "hub-note", text: t("Tell the people in the call that you are recording.") }),
  ));

  // ── Privacy ──
  const privacy = section("privacy", t("Privacy"));
  const keep: [string, string][] = [["0", t("Don't keep")], ["7", t("7 days")], ["30", t("30 days")], ["365", t("1 year")], ["-1", t("Forever")]];
  const confirmRow = h("div", { class: "hub-row" });
  const erase = () => {
    clear(confirmRow);
    confirmRow.append(
      button(t("Erase the history"), () => void FlowBridge.clear(false), "", true),
      button(t("Erase everything"), () => {
        clear(confirmRow);
        confirmRow.append(
          h("span", { class: "hub-note", style: "flex:1", text: t("Erase the history and the statistics?") }),
          button(t("Erase everything"), () => {
            void FlowBridge.clear(true);
            erase();
          }, "danger", true),
          button(t("Cancel"), erase, "", true),
        );
      }, "", true),
    );
  };
  erase();
  privacy.append(card(
    row(t("Keep the history"), null, select(keep, String(prefs.keepDays), (v) => void ctx.setPrefs((p) => (p.keepDays = Number(v))))),
    h("div", { class: "hub-note", text: t("The history, the statistics and your notes stay on this computer, in Coucou's folder. Dictations are never saved as audio; a call's audio is deleted as soon as its transcript is written.") }),
  ));
  const deletion = card(confirmRow);
  deletion.classList.add("hub-settings-deletion");
  privacy.append(deletion);

  // ── Window and pill placement belong together, not among dictation keys ──
  const app = section("app", t("App"));
  app.append(card(
    row(t("Where the pill is"), null, segmented(edges, prefs.edge, (edge) => void ctx.setPrefs((p) => (p.edge = edge)))),
    divider(),
    row(t("Open this window when you open Coucou"), t("Not when Coucou starts with the computer."), toggle(prefs.openAtLaunch, (on) => void ctx.setPrefs((p) => (p.openAtLaunch = on)))),
  ));
}
