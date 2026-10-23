//! Exact, bounded local intents. Never execute arbitrary recognized text.
use super::wake::normalize;

#[derive(Debug, PartialEq)]
pub enum Intent { Page(&'static str), Music(&'static str) }

pub fn parse(text: &str) -> Option<Intent> {
    let text = normalize(text);
    let text = text.strip_prefix("please ").unwrap_or(&text);
    let text = text.strip_suffix(" please").unwrap_or(text);
    Some(match text {
        "show my notes" | "open my notes" | "open notetaker" => Intent::Page("notes"),
        "open dictation" | "show dictation" => Intent::Page("dictation"),
        "open coucou settings" | "show coucou settings" => Intent::Page("flowsettings"),
        "show my agents" | "open agents" => Intent::Page("agents"),
        "show my statistics" | "open statistics" => Intent::Page("insights"),
        "next song" | "next track" | "skip song" | "skip track" => Intent::Music("next"),
        "previous song" | "previous track" | "go back a song" => Intent::Music("previous"),
        "toggle playback" | "toggle music" => Intent::Music("playPause"),
        _ => return None,
    })
}

pub fn respond(app: &tauri::AppHandle, text: &str) -> Option<String> {
    match parse(text)? {
        Intent::Page(page) => {
            crate::show_hub(app, Some(page));
            Some("Opened Coucou.".into())
        }
        Intent::Music(action) => {
            let ok = tauri::async_runtime::block_on(crate::spotify::spotify_control(app.clone(), action.into(), None));
            Some(if ok { "Playback updated." } else { "Couldn't control Spotify. Open Spotify and start playback first." }.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recognizes_polite_exact_requests() {
        assert_eq!(parse("Please, show my notes."), Some(Intent::Page("notes")));
        assert_eq!(parse("Skip track please"), Some(Intent::Music("next")));
    }
    #[test]
    fn never_guesses_destructive_or_compound_requests() {
        for text in ["delete my notes", "next song and delete files", "pause music", "open cmd and run stuff", "what is next song"] {
            assert_eq!(parse(text), None);
        }
    }
}
