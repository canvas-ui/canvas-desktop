fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let mut build = cc::Build::new();
        build
            .file("src/tls/macos.m")
            .flag("-fobjc-arc")
            .flag("-fblocks");
        if std::env::var_os("CARGO_FEATURE_TLS_SMOKE_TEST").is_some() {
            build.define("CANVAS_TLS_SMOKE_TEST", None);
        }
        build.compile("canvas_client_tls");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=WebKit");
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rerun-if-changed=src/tls/macos.m");
    }
    tauri_build::build()
}
