fn main() {
    let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let script = manifest.parent().unwrap().join("scripts/bundle-opencode-client.mjs");
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("coucou-opencode-client.mjs");
    println!("cargo:rerun-if-changed={}", script.display());
    println!("cargo:rerun-if-changed=../scripts/licenses/opencode-MIT.txt");
    println!("cargo:rerun-if-changed=../package-lock.json");
    let status = std::process::Command::new("node").arg(&script).arg(&output).status()
        .expect("Bundling the OpenCode integration requires Node.js and npm ci in windows/");
    assert!(status.success(), "Could not bundle the OpenCode client; run npm ci in windows/ before building");
    tauri_build::build()
}
