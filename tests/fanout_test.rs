use std::fs::write;
use std::process::Command;
use tempfile::tempdir;
use underclass::fanout::{commit_and_clean_worktree, create_worktree};

fn init_git_repo(dir: &std::path::Path) {
    let _ = Command::new("git").arg("init").arg("-b").arg("main").current_dir(dir).output();
    let _ = Command::new("git").arg("config").arg("user.name").arg("Test User").current_dir(dir).output();
    let _ = Command::new("git").arg("config").arg("user.email").arg("test@example.com").current_dir(dir).output();
    write(dir.join("README.md"), "# Test Repo\n").unwrap();
    let _ = Command::new("git").arg("add").arg(".").current_dir(dir).output();
    let _ = Command::new("git").arg("commit").arg("-m").arg("initial commit").current_dir(dir).output();
}

#[test]
fn test_fanout_worktree_creation_and_clean() {
    let dir = tempdir().unwrap();
    init_git_repo(dir.path());

    let task_branch = "feature-test-1";
    let worktree_dir = create_worktree("main", task_branch, dir.path()).expect("Failed to create worktree");
    assert!(worktree_dir.exists());

    // Make an edit inside the worktree
    write(worktree_dir.join("feature.txt"), "New feature added\n").unwrap();

    let report = commit_and_clean_worktree(task_branch, "main", &worktree_dir, dir.path(), false, false);
    assert_eq!(report.branch, task_branch);
    assert!(report.success);

    // Verify main branch received the merged edit
    assert!(dir.path().join("feature.txt").exists());
}
