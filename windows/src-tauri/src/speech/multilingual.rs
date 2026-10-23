//! Optional omniASR CTC 300M (Apache-2.0), for Turkish and other languages.
//! Dictation only: installing/selecting this never changes calls or wake words.

use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use std::io::Write;
use sherpa_onnx::{OfflineOmnilingualAsrCtcModelConfig, OfflineRecognizer, OfflineRecognizerConfig};
use tauri::AppHandle;
use super::{ModelFile, ModelSet, ModelState, Transcript};

// Immutable upstream revision. Model hash/size from Hugging Face's LFS metadata;
// tokens independently downloaded and SHA-256 hashed at the same revision.
const MODELS: ModelSet = ModelSet {
    id: "omnilingual-300m-ctc-int8-2025-11-12",
    files: &[
        ModelFile {
            name: "model.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12/resolve/6abf1ece20cd2308bdb7d13cd78ec1c44fa4c094/model.int8.onnx",
            size: 365_352_120,
            sha256: "e7c4e54ee4c4c47829cc6667d5d00ed8ea7bef1dcfeef0fce766f77752a2726c",
        },
        ModelFile {
            name: "tokens.txt",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12/resolve/6abf1ece20cd2308bdb7d13cd78ec1c44fa4c094/tokens.txt",
            size: 86_423,
            sha256: "a7a044c52cb29cbe8b0dc1953e92cefd4ca16b0ed968177b6beab21f9a7d0b31",
        },
    ],
};

#[derive(Default)]
struct State {
    running: bool,
    fraction: f64,
    error: Option<String>,
    recognizer: Option<Arc<OfflineRecognizer>>,
    last_used: Option<Instant>,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State::default()))
}

pub fn download_mb() -> u64 { MODELS.total_size().div_ceil(1_000_000) }
pub fn is_ready() -> bool { MODELS.is_present() }
pub fn is_loaded() -> bool { state().lock().unwrap().recognizer.is_some() }
pub fn unload() {
    let mut s = state().lock().unwrap();
    s.recognizer = None;
    s.last_used = None;
}

fn idle_expired(last_used: Option<Instant>, now: Instant, busy: bool) -> bool {
    !busy && last_used.is_some_and(|last| now.saturating_duration_since(last) >= super::IDLE_UNLOAD)
}

/// Wake-word activity uses Parakeet and must not pin this optional model in RAM.
pub fn unload_if_idle(dictating: bool) -> bool {
    let mut s = state().lock().unwrap();
    if s.recognizer.is_none() || !idle_expired(s.last_used, Instant::now(), dictating) {
        return false;
    }
    s.recognizer = None;
    s.last_used = None;
    true
}

pub fn status() -> ModelState {
    let s = state().lock().unwrap();
    if s.running { ModelState::Downloading { fraction: s.fraction } }
    else if is_ready() { ModelState::Ready }
    else if let Some(error) = &s.error { ModelState::Failed { error: error.clone() } }
    else { ModelState::Missing }
}

pub fn transcribe(samples: &[f32]) -> Option<Transcript> {
    let rec = {
        // Serializes load/removal; an active decode keeps its own Arc alive.
        let mut s = state().lock().unwrap();
        if s.running || !is_ready() { return None; }
        if s.recognizer.is_none() {
            let mut config = OfflineRecognizerConfig::default();
            config.model_config.omnilingual = OfflineOmnilingualAsrCtcModelConfig {
                model: Some(MODELS.path("model.int8.onnx")),
            };
            config.model_config.tokens = Some(MODELS.path("tokens.txt"));
            config.model_config.num_threads = super::threads();
            s.recognizer = OfflineRecognizer::create(&config).map(Arc::new);
        }
        let rec = s.recognizer.clone()?;
        s.last_used = Some(Instant::now());
        rec
    };
    super::transcribe_with(&rec, samples)
}

#[tauri::command]
pub fn flow_multilingual_download(app: AppHandle) {
    {
        let mut s = state().lock().unwrap();
        if s.running { return; }
        s.running = true;
        s.fraction = 0.0;
        s.error = None;
    }
    super::emit_status(&app);
    tauri::async_runtime::spawn(async move {
        let result = download_files(&app).await;
        {
            let mut s = state().lock().unwrap();
            s.running = false;
            s.error = result.err();
        }
        super::emit_status(&app);
    });
}

async fn download_files(app: &AppHandle) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .build().map_err(|e| e.to_string())?;
    let dir = MODELS.dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut done = 0;
    let mut last_emit = std::time::Instant::now();
    for file in MODELS.files {
        let path = dir.join(file.name);
        if std::fs::metadata(&path).map(|m| m.len() == file.size).unwrap_or(false) {
            done += file.size;
            continue;
        }
        let part = dir.join(format!("{}.part", file.name));
        let result = async {
            let mut response = client.get(file.url).send().await.map_err(|e| e.to_string())?
                .error_for_status().map_err(|e| e.to_string())?;
            let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
            let mut hash = ring::digest::Context::new(&ring::digest::SHA256);
            let mut got = 0;
            while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
                got += chunk.len() as u64;
                if got > file.size { return Err("Model download exceeds expected size".to_string()); }
                out.write_all(&chunk).map_err(|e| e.to_string())?;
                hash.update(&chunk);
                if last_emit.elapsed() >= Duration::from_millis(250) {
                    state().lock().unwrap().fraction = (done + got) as f64 / MODELS.total_size() as f64;
                    super::emit_status(app);
                    last_emit = std::time::Instant::now();
                }
            }
            let hex: String = hash.finish().as_ref().iter().map(|b| format!("{b:02x}")).collect();
            if got != file.size || hex != file.sha256 {
                return Err(format!("{}: download failed integrity verification", file.name));
            }
            out.sync_all().map_err(|e| e.to_string())?;
            drop(out);
            std::fs::rename(&part, &path).map_err(|e| e.to_string())
        }.await;
        if result.is_err() { let _ = std::fs::remove_file(&part); }
        result?;
        done += file.size;
    }
    Ok(())
}

#[tauri::command]
pub fn flow_multilingual_remove(app: AppHandle) -> Result<(), String> {
    {
        let mut s = state().lock().unwrap();
        if s.running { return Err("Wait for the model download to finish".into()); }
        s.recognizer = None;
        s.last_used = None;
        if MODELS.dir().exists() {
            std::fs::remove_dir_all(MODELS.dir()).map_err(|e| e.to_string())?;
        }
        s.error = None;
    }
    super::emit_status(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_model_has_an_independent_idle_deadline() {
        let start = Instant::now();
        assert!(!idle_expired(None, start, false));
        assert!(!idle_expired(Some(start), start, false));
        assert!(!idle_expired(Some(start), start + super::super::IDLE_UNLOAD, true));
        assert!(idle_expired(Some(start), start + super::super::IDLE_UNLOAD, false));
    }
}
