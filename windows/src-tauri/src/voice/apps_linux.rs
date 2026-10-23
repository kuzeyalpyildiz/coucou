//! Launch registered applications through GIO, never by interpreting spoken
//! text as a command, executable path, URL, or desktop-entry ID.
//! GIO owns XDG precedence, Hidden/NoDisplay filtering and Exec field expansion.
use gtk::gio::{self, prelude::*};

use super::commands::{matches_with_case, AppName};

pub(super) fn launch(wanted: &str, may_launch: impl Fn() -> bool) -> String {
    if !may_launch() { return "Voice command cancelled.".into(); }
    let apps: Vec<_> = gio::AppInfo::all().into_iter()
        .filter(|app| app.should_show() && app.id().is_some())
        .collect();
    let names: Vec<_> = apps.iter().map(|app| AppName {
        label: app.display_name().to_string(),
        identity: app.id().unwrap().to_string(),
    }).collect();
    activate(wanted, &names, may_launch, |index| {
        apps[index].launch(&[], None::<&gio::AppLaunchContext>).is_ok()
    })
}

fn activate(wanted: &str, names: &[AppName], may_launch: impl Fn() -> bool, launch: impl FnOnce(usize) -> bool) -> String {
    if !may_launch() { return "Voice command cancelled.".into(); }
    let found = matches_with_case(wanted, names, false);
    let index = match found.as_slice() {
        [] => return "No matching installed app. Try its full application name.".into(),
        [index] => *index,
        _ => return "More than one app matches. Please use a more specific application name.".into(),
    };
    // Discovery may take time: recheck the user's current permission immediately
    // before the registered identity is activated. No preference grants persist.
    if !may_launch() { return "Voice command cancelled.".into(); }
    if launch(index) {
        format!("Launch requested: {}", names[index].label)
    } else {
        "Couldn't launch that app. Try opening it from your application menu.".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn app(label: &str, identity: &str) -> AppName {
        AppName { label: label.into(), identity: identity.into() }
    }

    #[test]
    fn activates_only_the_selected_registered_identity() {
        let apps = [app("Editor", "org.example.Editor.desktop"), app("Browser", "browser.desktop")];
        let result = activate("editor", &apps, || true, |index| { assert_eq!(index, 0); true });
        assert_eq!(result, "Launch requested: Editor");
    }

    #[test]
    fn ambiguous_unknown_and_compound_requests_never_launch() {
        let apps = [app("Editor", "one.desktop"), app("Editor", "two.desktop")];
        for wanted in ["editor", "not installed", "editor and delete files", "editor --help"] {
            assert!(!activate(wanted, &apps, || true, |_| panic!("must not launch")).starts_with("Launch requested:"));
        }
    }

    #[test]
    fn preference_is_checked_again_immediately_before_activation() {
        let checks = Cell::new(0);
        let result = activate("editor", &[app("Editor", "editor.desktop")], || {
            checks.set(checks.get() + 1);
            checks.get() == 1
        }, |_| panic!("disabled commands must not launch"));
        assert_eq!(result, "Voice command cancelled.");
        assert_eq!(checks.get(), 2);
    }

    #[test]
    fn launch_failure_is_not_reported_as_success() {
        let result = activate("editor", &[app("Editor", "editor.desktop")], || true, |_| false);
        assert!(!result.starts_with("Launch requested:"));
    }
}
