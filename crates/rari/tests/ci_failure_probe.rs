#[test]
fn deliberate_failure_probe() {
    assert!(
        std::env::var_os("RARI_CI_FAILURE_PROBE").is_some(),
        "deliberate failure to verify the pull request check"
    );
}
