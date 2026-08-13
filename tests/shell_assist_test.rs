use underclass::shell::assist::{endpoint_down_reason, mark_endpoint_down};
use underclass::shell::install::{detect_installed_shells, stage_assets, ShellType};
use underclass::shell::rules::suggest_install_hint;

#[test]
fn test_shell_type_parsing() {
    assert_eq!(ShellType::parse("zsh"), Some(ShellType::Zsh));
    assert_eq!(ShellType::parse("bash"), Some(ShellType::Bash));
    assert_eq!(ShellType::parse("fish"), Some(ShellType::Fish));
    assert_eq!(ShellType::parse("nu"), Some(ShellType::Nushell));
    assert_eq!(ShellType::parse("nushell"), Some(ShellType::Nushell));
    assert_eq!(ShellType::parse("unknown"), None);
}

#[test]
fn test_detect_installed_shells() {
    let shells = detect_installed_shells();
    assert!(!shells.is_empty());
}

#[test]
fn test_stage_assets_multi_shell() {
    let res = stage_assets();
    assert!(res.is_ok());

    let dir = underclass::shell::install::shell_dir();
    assert!(dir.join("danger.plugin.zsh").exists());
    assert!(dir.join("danger.plugin.bash").exists());
    assert!(dir.join("danger.fish").exists());
    assert!(dir.join("danger.nu").exists());
}

#[test]
fn test_suggest_install_hint_known_tools() {
    let rg_hint = suggest_install_hint("rg").expect("Missing rg hint");
    assert!(rg_hint.contains("repo_search"));

    let fastfetch_hint = suggest_install_hint("neofetch").expect("Missing neofetch hint");
    assert!(fastfetch_hint.contains("fastfetch"));

    let unknown_hint = suggest_install_hint("some-nonexistent-command-xyz");
    assert!(unknown_hint.is_none());
}

#[test]
fn test_endpoint_down_state_caching() {
    let unique_id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let test_url = format!("http://127.0.0.1:{unique_id}/v1");

    assert!(endpoint_down_reason(&test_url).is_none());

    mark_endpoint_down(&test_url, "Connection refused");
    let reason = endpoint_down_reason(&test_url);
    assert!(reason.is_some());
    assert_eq!(reason.unwrap(), "Connection refused");
}
