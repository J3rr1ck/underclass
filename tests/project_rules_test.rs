use std::fs::write;
use tempfile::tempdir;
use underclass::project_rules::{inspect_project, Severity};

#[test]
fn test_inspect_project_node_lockfile_missing() {
    let dir = tempdir().unwrap();
    let pkg_path = dir.path().join("package.json");
    write(&pkg_path, r#"{"name": "test-pkg", "scripts": {"test": "echo ok"}}"#).unwrap();

    let info = inspect_project(dir.path());
    let lockfile_finding = info.findings.iter().find(|f| f.id == "node-lockfile-missing");
    assert!(lockfile_finding.is_some());
    assert_eq!(lockfile_finding.unwrap().severity, Severity::Risk);
}

#[test]
fn test_inspect_project_no_test_command() {
    let dir = tempdir().unwrap();
    let pkg_path = dir.path().join("package.json");
    write(&pkg_path, r#"{"name": "test-pkg", "scripts": {"test": "no test specified"}}"#).unwrap();

    let info = inspect_project(dir.path());
    let no_test_finding = info.findings.iter().find(|f| f.id == "no-test-command");
    assert!(no_test_finding.is_some());
}

#[test]
fn test_inspect_project_python_unpinned() {
    let dir = tempdir().unwrap();
    let req_path = dir.path().join("requirements.txt");
    write(&req_path, "requests\nflask\n").unwrap();

    let info = inspect_project(dir.path());
    let py_finding = info.findings.iter().find(|f| f.id == "python-unpinned");
    assert!(py_finding.is_some());
}

#[test]
fn test_inspect_project_android_sdk_unset() {
    let dir = tempdir().unwrap();
    write(dir.path().join("build.gradle.kts"), "plugins { id(\"com.android.application\") }").unwrap();

    std::env::remove_var("ANDROID_HOME");
    std::env::remove_var("ANDROID_SDK_ROOT");

    let info = inspect_project(dir.path());
    let android_finding = info.findings.iter().find(|f| f.id == "android-sdk-unset");
    assert!(android_finding.is_some());
    assert_eq!(android_finding.unwrap().severity, Severity::Blocker);
}
