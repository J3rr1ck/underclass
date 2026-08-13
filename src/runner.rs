pub fn fanout_depth() -> usize {
    std::env::var("UNDER_FANOUT_DEPTH")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

pub fn max_fanout_depth() -> usize {
    3
}
