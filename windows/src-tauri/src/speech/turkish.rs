//! Turkish Streaming Zipformer Transducer (CC-BY-NC-4.0), duxx/turkish-stt-zipformer.
//! Dictation only: installing/selecting this never changes calls or wake words.
//! Uses sherpa-onnx OnlineRecognizer (streaming) unlike Parakeet/OmniASR (offline).

use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use std::io::Write;
use sherpa_onnx::{OnlineRecognizer, OnlineRecognizerConfig, OnlineTransducerModelConfig};
use tauri::AppHandle;
use super::{ModelFile, ModelSet, ModelState, Transcript};

// Immutable upstream revision (main branch tip at time of pinning).
const MODELS: ModelSet = ModelSet {
    id: "turkish-zipformer-int8",
    files: &[
        ModelFile {
            name: "encoder-epoch-1-avg-1-chunk-32-left-128.int8.onnx",
            url: "https://huggingface.co/duxx/turkish-stt-zipformer/resolve/cebec199e0a9a1bdcd195b9124922b4a33e98bc8/encoder-epoch-1-avg-1-chunk-32-left-128.int8.onnx",
            size: 26_599_220,
            sha256: "f5a4b439cf0dd11d01774a97fd580c20ad944756c7e44f539cb6a46165013432",
        },
        ModelFile {
            name: "decoder-epoch-1-avg-1-chunk-32-left-128.int8.onnx",
            url: "https://huggingface.co/duxx/turkish-stt-zipformer/resolve/cebec199e0a9a1bdcd195b9124922b4a33e98bc8/decoder-epoch-1-avg-1-chunk-32-left-128.int8.onnx",
            size: 540_688,
            sha256: "28f4caee9c57dc22afc0967b7e81994b85c0b67f9980f1df0bb5648a7554b18b",
        },
        ModelFile {
            name: "joiner-epoch-1-avg-1-chunk-32-left-128.int8.onnx",
            url: "https://huggingface.co/duxx/turkish-stt-zipformer/resolve/cebec199e0a9a1bdcd195b9124922b4a33e98bc8/joiner-epoch-1-avg-1-chunk-32-left-128.int8.onnx",
            size: 259_417,
            sha256: "c1f4ebed5cbbed2fceefabca8c2657f157bcf2deead3ad067c8b2dc1d2c3bfb1",
        },
        ModelFile {
            name: "tokens.txt",
            url: "https://huggingface.co/duxx/turkish-stt-zipformer/resolve/cebec199e0a9a1bdcd195b9124922b4a33e98bc8/tokens.txt",
            size: 5_182,
            sha256: "1885ade359d5939dde820f0f0a1b31f43dad6e5bf8362ad66983fb78d24d65b6",
        },
    ],
};

#[derive(Default)]
struct State {
    running: bool,
    fraction: f64,
    error: Option<String>,
    recognizer: Option<Arc<OnlineRecognizer>>,
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

/// Free the model when it has been idle long enough. Returns whether it unloaded.
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

/// Transcribes 16 kHz mono audio using the streaming Zipformer recognizer.
/// The entire buffer is fed at once (offline-like usage of a streaming model).
pub fn transcribe(samples: &[f32]) -> Option<Transcript> {
    let rec = {
        let mut s = state().lock().unwrap();
        if s.running || !is_ready() { return None; }
        if s.recognizer.is_none() {
            let mut config = OnlineRecognizerConfig::default();
            config.model_config.transducer = OnlineTransducerModelConfig {
                encoder: MODELS.path("encoder-epoch-1-avg-1-chunk-32-left-128.int8.onnx"),
                decoder: MODELS.path("decoder-epoch-1-avg-1-chunk-32-left-128.int8.onnx"),
                joiner: MODELS.path("joiner-epoch-1-avg-1-chunk-32-left-128.int8.onnx"),
            };
            config.model_config.tokens = MODELS.path("tokens.txt");
            config.model_config.num_threads = super::threads();
            config.model_config.sample_rate = super::SAMPLE_RATE as i32;
            config.decoding_method = "modified_beam_search".into();
            config.max_active_paths = 12;
            s.recognizer = OnlineRecognizer::create(&config).map(Arc::new);
        }
        let rec = s.recognizer.clone()?;
        s.last_used = Some(Instant::now());
        rec
    };

    // Feed all samples, signal end, decode until done.
    let mut stream = rec.create_stream();
    stream.accept_waveform(super::SAMPLE_RATE as i32, samples);
    stream.input_finished();
    while rec.is_ready(&stream) {
        rec.decode_stream(&mut stream);
    }
    let text = rec.get_result(&stream).trim().to_string();
    Some(Transcript { text, words: Vec::new() })
}

#[tauri::command]
pub fn flow_turkish_download(app: AppHandle) {
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
pub fn flow_turkish_remove(app: AppHandle) -> Result<(), String> {
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
    fn turkish_model_has_an_independent_idle_deadline() {
        let start = Instant::now();
        assert!(!idle_expired(None, start, false));
        assert!(!idle_expired(Some(start), start, false));
        assert!(!idle_expired(Some(start), start + super::super::IDLE_UNLOAD, true));
        assert!(idle_expired(Some(start), start + super::super::IDLE_UNLOAD, false));
    }
}