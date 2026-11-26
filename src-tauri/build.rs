fn main() {
    // `npm run mac:build` fills these with the Next standalone server and the bundled Node runtime
    // (scripts/node-runtime.mjs). Empty folders keep `cargo check` and `tauri dev` working before
    // that: without a bundled Node the app uses the system's, and without a server it explains it
    // can't start.
    for dir in ["../build/app-server", "../build/node-runtime"] {
        std::fs::create_dir_all(dir).unwrap_or_else(|e| panic!("create {dir}: {e}"));
    }
    tauri_build::build()
}
