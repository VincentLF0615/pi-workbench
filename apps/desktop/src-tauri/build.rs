fn main() {
    // The Windows resource compiler embeds the ICO in the executable. Track
    // the source directory so incremental builds cannot reuse an older icon.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
