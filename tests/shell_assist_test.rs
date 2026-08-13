use underclass::shell::assist::{endpoint_down_reason, mark_endpoint_down};
use underclass::shell::rules::suggest_install_hint;

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
