use std::process::Command;

#[test]
fn help_lists_only_the_implemented_validator_command() {
    let output = Command::new(env!("CARGO_BIN_EXE_hz-eval"))
        .arg("--help")
        .output()
        .unwrap();

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("Validate HorizonCode evaluation records"));
    assert!(stdout.contains("validate"));
    assert!(!stdout.contains("run <"));
    assert!(!stdout.contains("compare <"));
}

#[test]
fn validation_cli_does_not_echo_untrusted_record_content() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("invalid.json");
    let marker = "credential-value-must-not-be-echoed";
    std::fs::write(&path, format!(r#"{{"api_key":"{marker}"}}"#)).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_hz-eval"))
        .arg("validate")
        .arg(path)
        .output()
        .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("failed schema or integrity validation"));
    assert!(!stderr.contains(marker));
}

#[test]
fn validation_cli_reads_at_most_one_megabyte_plus_one_byte() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("oversized.json");
    std::fs::write(&path, vec![b' '; 1_048_577]).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_hz-eval"))
        .arg("validate")
        .arg(path)
        .output()
        .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("exceeds the 1 MiB input limit"));
}
