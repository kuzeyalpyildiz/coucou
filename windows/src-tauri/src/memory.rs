// Memory profiler: working-set size, model residency and voice state in one
// line for coucou.log, plus a `memory_profile` Tauri command for Settings →
// Diagnostics. No new dependencies: Windows reads its own process counters,
// Linux reads /proc/self.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryProfile {
    /// Resident working set, MiB.
    pub working_set_mb: u64,
    /// Whether the ~670 MB Parakeet model is currently loaded.
    pub model_loaded: bool,
    /// Whether « OK Coucou » listening thread is running.
    pub voice_listening: bool,
    /// Bounded audio queue depth is fixed at compile time (4 chunks).
    pub audio_queue_bound: usize,
}

pub fn working_set_mb() -> u64 {
    #[cfg(windows)]
    {
        use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
        use windows::Win32::System::Threading::GetCurrentProcess;
        unsafe {
            let mut counters = PROCESS_MEMORY_COUNTERS::default();
            let ok = GetProcessMemoryInfo(
                GetCurrentProcess(),
                &mut counters,
                std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            );
            if ok.is_ok() {
                return (counters.WorkingSetSize as u64) / (1024 * 1024);
            }
        }
        0
    }
    #[cfg(target_os = "linux")]
    {
        // /proc/self/statm resident pages × page size.
        if let Ok(text) = std::fs::read_to_string("/proc/self/statm") {
            let parts: Vec<&str> = text.split_whitespace().collect();
            if parts.len() >= 2 {
                if let (Ok(pages), Ok(size)) =
                    (parts[1].parse::<u64>(), page_size())
                {
                    return pages * size / (1024 * 1024);
                }
            }
        }
        0
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        0
    }
}

#[cfg(target_os = "linux")]
fn page_size() -> Result<u64, ()> {
    Ok(4096)
}

pub fn profile() -> MemoryProfile {
    MemoryProfile {
        working_set_mb: working_set_mb(),
        model_loaded: crate::speech::is_loaded(),
        voice_listening: crate::voice::is_listening(),
        audio_queue_bound: 4,
    }
}

/// One log line: `memory: 812 MB working set, model loaded, voice on`.
pub fn profile_line() -> String {
    let p = profile();
    format!(
        "memory: {} MB working set, model {}, voice {}",
        p.working_set_mb,
        if p.model_loaded { "loaded" } else { "unloaded" },
        if p.voice_listening { "listening" } else { "off" },
    )
}

#[tauri::command]
pub fn memory_profile() -> MemoryProfile {
    crate::log::line(profile_line());
    profile()
}
