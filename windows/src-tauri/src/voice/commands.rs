// Recognized text is a catalog lookup key, never an executable, URL or shell
// argument. Discovery and activation use Windows Shell identities or Linux GIO.
use super::wake::normalize;

fn app_name(text: &str) -> Option<String> {
    let normalized = normalize(text);
    for prefix in ["open ", "launch ", "start "] {
        if let Some(name) = normalized.strip_prefix(prefix) {
            if !name.is_empty() { return Some(name.to_string()); }
        }
    }
    None
}

#[derive(Debug, Clone)]
#[cfg(any(windows, target_os = "linux", test))]
pub(super) struct AppName {
    pub label: String,
    /// Canonical Windows parsing identity or case-sensitive Linux desktop ID,
    /// not merely the app's display label.
    pub identity: String,
}

/// Reserved system-app names use only these compiled-in OS targets. Never
/// search PATH or append recognized words to a process command line.
#[cfg(any(windows, test))]
pub(super) fn system_target(wanted: &str) -> Option<&'static str> {
    match wanted {
        "notepad" | "note pad" => Some("System32\\notepad.exe"),
        "calculator" | "calc" => Some("System32\\calc.exe"),
        "paint" | "microsoft paint" | "ms paint" => Some("System32\\mspaint.exe"),
        "task manager" => Some("System32\\Taskmgr.exe"),
        "command prompt" => Some("System32\\cmd.exe"),
        "file explorer" | "windows explorer" => Some("explorer.exe"),
        "settings" | "windows settings" => Some("ms-settings:"),
        _ => None,
    }
}

#[cfg(any(windows, target_os = "linux", test))]
fn joined_words(text: &str) -> String {
    text.split_whitespace().collect()
}

/// Match full words or their initials without a product-specific alias table.
/// Require at least two abbreviated words, so a single short prefix is not
/// treated as a guess. States are bounded by the requested name's length.
#[cfg(any(windows, target_os = "linux", test))]
fn abbreviated_name(wanted: &str, label: &str) -> bool {
    let mut states = std::collections::HashSet::from([(0usize, 0u8)]);
    for word in label.split_whitespace() {
        let initial = &word[..word.chars().next().unwrap().len_utf8()];
        let mut next = std::collections::HashSet::new();
        for (offset, count) in states {
            let rest = &wanted[offset..];
            if rest.starts_with(word) { next.insert((offset + word.len(), count)); }
            if word.len() > initial.len() && rest.starts_with(initial) {
                next.insert((offset + initial.len(), (count + 1).min(2)));
            }
        }
        if next.is_empty() { return false; }
        states = next;
    }
    states.contains(&(wanted.len(), 2))
}

#[cfg(any(windows, target_os = "linux", test))]
fn score(wanted: &str, label: &str) -> Option<u8> {
    let label = normalize(label);
    if label == wanted { return Some(0); }
    let joined = joined_words(wanted);
    if !joined.is_empty() && joined_words(&label) == joined { return Some(1); }
    // Never confuse a requested app with its updater/uninstaller/help entry.
    if label.split_whitespace().any(|word| matches!(word,
        "uninstall" | "uninstaller" | "updater" | "installer" | "setup" | "repair" | "help")) {
        return None;
    }
    if !joined.is_empty() && abbreviated_name(&joined, &label) {
        return Some(2);
    }
    if label.starts_with(&format!("{wanted} ")) || label.ends_with(&format!(" {wanted}")) {
        return Some(3);
    }
    None
}

/// Return the best distinct identities. Duplicate shortcuts for one app must
/// not create ambiguity; different products/editions must not be guessed away.
#[cfg(any(windows, target_os = "linux", test))]
pub(super) fn matches(wanted: &str, apps: &[AppName]) -> Vec<usize> {
    matches_with_case(wanted, apps, true)
}

#[cfg(any(windows, target_os = "linux", test))]
pub(super) fn matches_with_case(wanted: &str, apps: &[AppName], ignore_identity_case: bool) -> Vec<usize> {
    let wanted = normalize(wanted);
    if wanted.is_empty() { return Vec::new(); }
    let mut best = u8::MAX;
    let mut found = Vec::new();
    let mut identities = std::collections::HashSet::new();
    for (index, app) in apps.iter().enumerate() {
        if app.identity.is_empty() { continue; }
        let Some(rank) = score(&wanted, &app.label) else { continue };
        if rank > best { continue; }
        if rank < best {
            best = rank;
            found.clear();
            identities.clear();
        }
        let identity = if ignore_identity_case { app.identity.to_lowercase() } else { app.identity.clone() };
        if identities.insert(identity) { found.push(index); }
    }
    found
}

pub fn respond(text: &str, may_launch: impl Fn() -> bool) -> Option<String> {
    let wanted = app_name(text)?;
    Some(launch(&wanted, may_launch))
}

#[cfg(windows)]
fn launch(wanted: &str, may_launch: impl Fn() -> bool) -> String {
    super::apps_windows::launch(wanted, may_launch)
}

#[cfg(target_os = "linux")]
fn launch(wanted: &str, may_launch: impl Fn() -> bool) -> String {
    super::apps_linux::launch(wanted, may_launch)
}

#[cfg(not(any(windows, target_os = "linux")))]
fn launch(_: &str, _: impl Fn() -> bool) -> String {
    "Local app commands are not available on this platform.".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn app(label: &str, identity: &str) -> AppName {
        AppName { label: label.into(), identity: identity.into() }
    }
    #[test]
    fn explicit_commands_only() {
        assert_eq!(app_name("Open Spotify."), Some("spotify".into()));
        assert_eq!(app_name("launch Visual Studio Code"), Some("visual studio code".into()));
        assert_eq!(app_name("start Firefox"), Some("firefox".into()));
        for text in ["open", "", "write open Spotify in my email", "please tell me about Spotify"] {
            assert_eq!(app_name(text), None);
        }
    }
    #[test]
    fn exact_app_wins_over_other_editions() {
        let apps = [app("Discord Canary", "canary"), app("Discord", "stable"), app("Discord PTB", "ptb")];
        assert_eq!(matches("discord", &apps), vec![1]);
        assert_eq!(matches("discord canary", &apps), vec![0]);
    }
    #[test]
    fn duplicate_entries_with_the_same_app_identity_are_one_app() {
        let apps = [app("Discord", "Discord.App"), app("Discord", "discord.app")];
        assert_eq!(matches("discord", &apps), vec![0]);
    }
    #[test]
    fn genuinely_different_apps_remain_ambiguous() {
        let apps = [app("Discord", "first"), app("Discord", "second")];
        assert_eq!(matches("discord", &apps), vec![0, 1]);
    }

    #[test]
    fn linux_desktop_identities_are_case_sensitive() {
        let apps = [app("Editor", "Editor.desktop"), app("Editor", "editor.desktop")];
        assert_eq!(matches_with_case("editor", &apps, false), vec![0, 1]);
        let duplicates = [app("Editor", "editor.desktop"), app("Editor", "editor.desktop")];
        assert_eq!(matches_with_case("editor", &duplicates, false), vec![0]);
    }
    #[test]
    fn partial_names_do_not_select_maintenance_tools() {
        let apps = [app("Google Chrome", "chrome"), app("Chrome Uninstaller", "remove"), app("Chrome Updater", "update")];
        assert_eq!(matches("chrome", &apps), vec![0]);
        assert!(matches("chr", &apps).is_empty());
        assert!(matches("chrome and delete files", &apps).is_empty());
    }
    #[test]
    fn abbreviations_are_derived_from_the_catalog_and_exact_names_win() {
        let apps = [app("Visual Studio Code", "code"), app("Visual Studio", "vs")];
        assert_eq!(matches("vs code", &apps), vec![0]);
        assert_eq!(matches("visual studio", &apps), vec![1]);
        assert_eq!(matches("visual", &apps), vec![0, 1]);
        assert!(matches("some unknown app", &apps).is_empty());
    }
    #[test]
    fn system_apps_have_fixed_targets_not_spoken_paths_or_arguments() {
        assert_eq!(system_target("notepad"), Some("System32\\notepad.exe"));
        assert_eq!(system_target("calculator"), Some("System32\\calc.exe"));
        assert_eq!(system_target("settings"), Some("ms-settings:"));
        for name in ["notepad.exe", "notepad file.txt", "cmd /c anything", "https://example.com", "c windows notepad exe"] {
            assert_eq!(system_target(name), None);
        }
    }

    #[test]
    fn spoken_compound_names_match_registered_apps_generically() {
        let apps = [app("ChatGPT", "chatgpt"), app("OpenCode", "opencode"), app("Code", "code")];
        for spoken in ["chat gpt", "chat g p t", "chatgpt"] {
            assert_eq!(matches(spoken, &apps), vec![0]);
        }
        assert_eq!(matches("open code", &apps), vec![1]);
        assert_eq!(matches("opencode", &apps), vec![1]);
        assert_eq!(matches("code", &apps), vec![2]);
        assert!(matches("chat gpt and open code", &apps).is_empty());
        assert_eq!(matches("some app", &[app("SomeApp", "other")]), vec![0]);
        assert_eq!(app_name("Open Chat GPT."), Some("chat gpt".into()));
        assert_eq!(app_name("Open Open Code."), Some("open code".into()));
    }

    #[test]
    fn literal_compound_name_match_still_beats_a_spoken_alias() {
        let apps = [app("OpenCode", "opencode"), app("Open Code", "different")];
        assert_eq!(matches("open code", &apps), vec![1]);
        let duplicates = [app("ChatGPT", "first"), app("ChatGPT", "second")];
        assert_eq!(matches("chat gpt", &duplicates), vec![0, 1]);
    }

    #[test]
    fn unknown_product_names_support_arbitrary_word_boundaries_and_initials() {
        for (spoken, label) in [
            ("nebula note", "NebulaNote"), ("neb ulan ote", "NebulaNote"),
            ("nebulanote", "Nebula Note"), ("x y z studio", "XYZStudio"),
            ("n p studio", "Nebula Paper Studio"), ("nps", "Nebula Paper Studio"),
            ("é p studio", "Étoile Paper Studio"),
        ] { assert_eq!(matches(spoken, &[app(label, "app")]), vec![0], "{spoken} -> {label}"); }
    }

    #[test]
    fn generic_matching_does_not_guess_collisions_or_maintenance_entries() {
        let apps = [app("NebulaNote", "first"), app("Nebula Note", "second")];
        assert_eq!(matches("nebu la note", &apps), vec![0, 1]);
        assert_eq!(matches("nebula note", &apps), vec![1]);
        assert!(matches("nebula note", &[app("NebulaNote Updater", "update")]).is_empty());
        assert!(matches("n n updater", &[app("Nebula Note Updater", "update")]).is_empty());
        assert!(matches("nebula note and delete files", &apps).is_empty());
        assert!(matches("n", &[app("Nebula", "app")]).is_empty());
        assert!(matches("", &apps).is_empty());
    }

    #[test]
    fn every_word_partition_of_sample_names_matches_without_a_product_table() {
        for label in ["NebulaNote", "XYZStudio", "Orbit360", "ÉtoilePad", "工具箱"] {
            let letters: Vec<char> = label.chars().collect();
            let apps = [app(label, "target"), app("Unrelated Editor", "other")];
            for breaks in 0..(1usize << (letters.len() - 1)) {
                let mut spoken = String::new();
                for (i, letter) in letters.iter().enumerate() {
                    if i > 0 && breaks & (1 << (i - 1)) != 0 { spoken.push(' '); }
                    spoken.push(*letter);
                }
                assert_eq!(matches(&spoken, &apps), vec![0], "{spoken} -> {label}");
            }
        }
    }

    #[test]
    fn matching_priority_and_collisions_do_not_depend_on_catalog_order() {
        let entries = [app("NebulaNote", "joined"), app("Nebula Note", "spaced"), app("Nebula Note Pro", "pro")];
        for order in [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]] {
            let apps: Vec<_> = order.iter().map(|i| entries[*i].clone()).collect();
            for (spoken, expected) in [("nebula note", "spaced"), ("nebulanote", "joined")] {
                let found = matches(spoken, &apps);
                assert_eq!(found.len(), 1);
                assert_eq!(apps[found[0]].identity, expected);
            }
            let found = matches("nebu la note", &apps);
            let identities: std::collections::HashSet<_> = found.iter().map(|i| apps[*i].identity.as_str()).collect();
            assert_eq!(identities, std::collections::HashSet::from(["joined", "spaced"]));
        }
    }

    #[test]
    fn generated_abbreviations_preserve_ambiguity_and_identity_deduplication() {
        let apps = [app("Nebula Paper Studio", "one"), app("North Pixel Studio", "two")];
        assert_eq!(matches("n p studio", &apps), vec![0, 1]);
        let duplicates = [app("Nebula Paper Studio", "Same.App"), app("Nebula Paper Studio", "same.app")];
        assert_eq!(matches("nps", &duplicates), vec![0]);
        assert!(matches("n p s", &[app("Nebula Paper Studio Updater", "update")]).is_empty());
        assert!(matches("nps", &[app("Nebula Paper Studio", "")]).is_empty());
    }

    #[test]
    fn spacing_does_not_turn_extra_commands_paths_or_typos_into_app_matches() {
        let apps = [app("NebulaNote", "target")];
        for spoken in ["nebula", "nebula notes", "nebulx note", "nebula note and chrome",
            "nebula note delete files", "c tools nebula note exe", "https nebula note com", "   "] {
            assert!(matches(spoken, &apps).is_empty(), "{spoken}");
        }
        for spoken in ["  NEBULA    NOTE  ", "Nebula-Note", "n e b u l a n o t e"] {
            assert_eq!(matches(spoken, &apps), vec![0], "{spoken}");
        }
    }
}
