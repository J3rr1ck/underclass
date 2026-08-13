use std::fs::write;
use tempfile::tempdir;
use underclass::tools::repo_search::execute_repo_search;

#[test]
fn test_execute_repo_search_symbol_definition_and_callsite() {
    let dir = tempdir().unwrap();
    let file1 = dir.path().join("service.rs");
    let file2 = dir.path().join("main.rs");

    write(&file1, "pub fn process_task() {\n    println!(\"processing\");\n}\n").unwrap();
    write(&file2, "fn main() {\n    process_task();\n}\n").unwrap();

    let res = execute_repo_search("process_task", dir.path());
    assert!(!res.is_error);
    assert!(res.output.contains("service.rs"));
    assert!(res.output.contains("process_task"));
}
