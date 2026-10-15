// Local app commands: recognized text is only a lookup key, never a path,
// command line, URL or shell argument. No AI or network calls in this module.
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

/// Prefer an exact app name; never silently pick between several matches.
#[cfg(any(windows, test))]
fn matches(wanted: &str, labels: &[String]) -> Vec<usize> {
    let exact: Vec<_> = labels.iter().enumerate()
        .filter(|(_, label)| normalize(label) == wanted).map(|(i, _)| i).collect();
    if !exact.is_empty() { return exact; }
    labels.iter().enumerate().filter(|(_, label)| {
        let label = normalize(label);
        label.starts_with(&format!("{wanted} ")) || label.ends_with(&format!(" {wanted}"))
    }).map(|(i, _)| i).collect()
}

pub fn respond(text: &str, may_launch: impl Fn() -> bool) -> Option<String> {
    let wanted = app_name(text)?;
    Some(launch(&wanted, may_launch))
}

#[cfg(windows)]
fn launch(wanted: &str, may_launch: impl Fn() -> bool) -> String {
    use std::path::PathBuf;
    let mut stack = Vec::new();
    for variable in ["APPDATA", "ProgramData"] {
        if let Some(root) = std::env::var_os(variable) {
            let root = PathBuf::from(root);
            if root.is_absolute() {
                stack.push(root.join("Microsoft\\Windows\\Start Menu\\Programs"));
            }
        }
    }
    let mut apps = Vec::new();
    let mut visited = 0;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            visited += 1;
            if visited > 8192 {
                return "The app list is too large to search safely. Open the app manually.".into();
            }
            let Ok(kind) = entry.file_type() else { continue };
            // Do not follow directory links/junctions out of the Start menu.
            use std::os::windows::fs::MetadataExt;
            if entry.metadata().map(|m| m.file_attributes() & 0x400 != 0).unwrap_or(true) { continue; }
            let path = entry.path();
            if kind.is_dir() { stack.push(path); }
            else if kind.is_file() && path.extension().is_some_and(|x| x.eq_ignore_ascii_case("lnk")) {
                if let Some(label) = path.file_stem().map(|x| x.to_string_lossy().into_owned()) {
                    apps.push((label, path));
                }
            }
        }
    }
    apps.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let labels: Vec<_> = apps.iter().map(|(label, _)| label.clone()).collect();
    let found = matches(wanted, &labels);
    match found.as_slice() {
        [] => "No matching Start menu app found. Try its full installed name.".into(),
        [index] => {
            if !may_launch() { return "App command cancelled.".into(); }
            let (label, path) = &apps[*index];
            // Only the absolute shortcut collected above reaches Explorer.
            match std::process::Command::new("explorer.exe").arg(path).spawn() {
                Ok(_) => format!("Launch requested: {label}."),
                Err(_) => format!("Could not launch {label}. Open it manually."),
            }
        }
        _ => format!("Several apps match: {}. Say OK Coucou, open, then the full name. No app was opened.",
            found.iter().take(4).map(|i| labels[*i].as_str()).collect::<Vec<_>>().join(", ")),
    }
}

#[cfg(not(windows))]
fn launch(_: &str, _: impl Fn() -> bool) -> String {
    "Local app commands are currently available on Windows only.".into()
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn exact_name_wins_and_ambiguous_names_are_not_guessed() {
        let labels = vec!["Visual Studio".into(), "Visual Studio Code".into(), "Spotify".into()];
        assert_eq!(matches("visual studio", &labels), vec![0]);
        assert_eq!(matches("visual", &labels), vec![0, 1]);
        assert_eq!(matches("spotify", &labels), vec![2]);
        assert!(matches("spot", &labels).is_empty());
        assert!(matches("spotify and delete files", &labels).is_empty());
    }
    #[test]
    fn duplicate_shortcut_names_remain_ambiguous() {
        assert_eq!(matches("spotify", &["Spotify".into(), "Spotify".into()]), vec![0, 1]);
    }
}
