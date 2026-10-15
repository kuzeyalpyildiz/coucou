// Recognized text is a catalog lookup key, never an executable, URL or shell
// argument. App discovery and activation are native Rust/Windows Shell calls.
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
#[cfg(any(windows, test))]
pub(super) struct AppName {
    pub label: String,
    /// Windows' canonical parsing identity, not merely the shortcut's label.
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

#[cfg(any(windows, test))]
fn score(wanted: &str, label: &str) -> Option<u8> {
    let label = normalize(label);
    if label == wanted { return Some(0); }
    // Small, explicit aliases; no spelling guesses or AI model requests.
    let alias = match wanted {
        "vs code" | "vscode" => "visual studio code",
        "google chrome" => "chrome",
        _ => wanted,
    };
    if label == alias { return Some(1); }
    // Never confuse a requested app with its updater/uninstaller/help entry.
    if label.split_whitespace().any(|word| matches!(word,
        "uninstall" | "uninstaller" | "updater" | "installer" | "setup" | "repair" | "help")) {
        return None;
    }
    if label.starts_with(&format!("{alias} ")) || label.ends_with(&format!(" {alias}")) {
        return Some(2);
    }
    None
}

/// Return the best distinct identities. Duplicate shortcuts for one app must
/// not create ambiguity; different products/editions must not be guessed away.
#[cfg(any(windows, test))]
pub(super) fn matches(wanted: &str, apps: &[AppName]) -> Vec<usize> {
    let mut best = u8::MAX;
    let mut found = Vec::new();
    let mut identities = std::collections::HashSet::new();
    for (index, app) in apps.iter().enumerate() {
        if app.identity.is_empty() { continue; }
        let Some(rank) = score(wanted, &app.label) else { continue };
        if rank > best { continue; }
        if rank < best {
            best = rank;
            found.clear();
            identities.clear();
        }
        if identities.insert(app.identity.to_lowercase()) { found.push(index); }
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

#[cfg(not(windows))]
fn launch(_: &str, _: impl Fn() -> bool) -> String {
    "Local app commands are currently available on Windows only.".into()
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
    fn partial_names_do_not_select_maintenance_tools() {
        let apps = [app("Google Chrome", "chrome"), app("Chrome Uninstaller", "remove"), app("Chrome Updater", "update")];
        assert_eq!(matches("chrome", &apps), vec![0]);
        assert!(matches("chr", &apps).is_empty());
        assert!(matches("chrome and delete files", &apps).is_empty());
    }
    #[test]
    fn exact_match_beats_aliases_and_aliases_are_explicit() {
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
}
