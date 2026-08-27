//! Path containment for file-operating tools.
//!
//! Mirrors `danger.ts`'s `edit()` (see `src/shell/assist.ts`): resolve the
//! requested path against the working directory, then check the relative path
//! back to `cwd` rather than doing a naive `startsWith` — a prefix test would
//! wrongly accept a sibling directory whose name happens to start with the same
//! characters (e.g. `cwd` = `/home/user`, target = `/home/user-evil`).
//!
//! This is a lexical check, same as the TS reference (`node:path`'s `relative`
//! does not touch the filesystem either) — it does not follow symlinks. A
//! symlink planted *inside* the working directory that points outside it can
//! still be walked through; that limitation is inherited from the TS version,
//! not introduced here.

use std::path::{Component, Path, PathBuf};

/// Resolve `path_str` against `cwd`, refusing any result that would land
/// outside `cwd`. Returns the joined (but not canonicalized — the target may
/// not exist yet, e.g. for `write`) path on success.
pub fn safe_join(cwd: &Path, path_str: &str) -> Result<PathBuf, String> {
    let requested = Path::new(path_str);
    let joined = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        cwd.join(requested)
    };

    let normalized = normalize_lexically(&joined);
    let cwd_normalized = normalize_lexically(cwd);

    // `Path::starts_with` compares components, not raw string prefixes, so
    // `/home/user-evil` does not spuriously match a `cwd` of `/home/user` the
    // way a naive string `startsWith` would (the .ts sibling's own `edit()`
    // warns about exactly this and uses `relative()` instead, for the same
    // reason).
    if normalized.starts_with(&cwd_normalized) {
        Ok(normalized)
    } else {
        Err(format!(
            "{path_str} is outside {}. Refusing to touch it.",
            cwd.display()
        ))
    }
}

/// Collapse `.` and `..` components without touching the filesystem
/// (`fs::canonicalize` requires the path to exist, which a `write` target may
/// not yet). A leading `..` that would climb above the root simply has
/// nowhere further to pop, same as `path.resolve` in Node.
fn normalize_lexically(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_paths_inside_cwd() {
        let cwd = Path::new("/home/user/project");
        assert_eq!(safe_join(cwd, "src/main.rs").unwrap(), PathBuf::from("/home/user/project/src/main.rs"));
        assert_eq!(safe_join(cwd, "./a/../b.rs").unwrap(), PathBuf::from("/home/user/project/b.rs"));
    }

    #[test]
    fn rejects_dotdot_escape() {
        let cwd = Path::new("/home/user/project");
        assert!(safe_join(cwd, "../secrets.env").is_err());
        assert!(safe_join(cwd, "../../etc/passwd").is_err());
        assert!(safe_join(cwd, "a/../../b").is_err());
    }

    #[test]
    fn rejects_absolute_escape() {
        let cwd = Path::new("/home/user/project");
        assert!(safe_join(cwd, "/etc/passwd").is_err());
    }

    #[test]
    fn rejects_sibling_prefix_collision() {
        // A naive `starts_with("/home/user")` string check would wrongly admit
        // this; the component-wise join must not.
        let cwd = Path::new("/home/user");
        assert!(safe_join(cwd, "../user-evil/x").is_err());
    }

    #[test]
    fn allows_cwd_itself() {
        let cwd = Path::new("/home/user/project");
        assert_eq!(safe_join(cwd, ".").unwrap(), PathBuf::from("/home/user/project"));
    }
}
