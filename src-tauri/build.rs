fn main() {
    // `npm run mac:build` fills this with the Next standalone server. An empty folder keeps
    // `cargo check` and `tauri dev` working before that (the app then explains it can't start).
    std::fs::create_dir_all("../build/app-server").expect("create ../build/app-server");
    tauri_build::build()
}
