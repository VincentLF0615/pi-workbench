fn main() {
    // The Windows resource compiler embeds the ICO in the executable. Track
    // the source directory so incremental builds cannot reuse an older icon.
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=windows.manifest.xml");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // Integration-test executables do not inherit the application's resource
        // manifest. Tauri imports TaskDialogIndirect from Common Controls v6.
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("windows.manifest.xml");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    // Let the linker embed one shared manifest for bins and tests. Embedding
    // a second copy through resource.lib produces duplicate MANIFEST resources.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
    )
    .expect("Tauri build setup failed");
}
