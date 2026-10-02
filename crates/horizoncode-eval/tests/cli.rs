use std::process::Command;

#[test]
fn help_lists_the_validator_and_offline_smoke_fixture() {
    let output = Command::new(env!("CARGO_BIN_EXE_hz-eval"))
        .arg("--help")
        .output()
        .unwrap();

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("Run a bounded deterministic offline fixture"));
    assert!(stdout.contains("validate"));
    assert!(stdout.contains("run"));
    assert!(!stdout.contains("run <"));
    assert!(!stdout.contains("compare <"));
}

#[cfg(unix)]
#[test]
fn smoke_fixture_writes_separate_sealed_artifacts_to_explicit_output_root() {
    let directory = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hz-eval"))
        .args(["run", "--fixture", "smoke", "--output-dir"])
        .arg(directory.path())
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.len() <= 1024);
    let summary: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let evaluation_id = summary["evaluation_id"].as_str().unwrap();
    assert_eq!(summary["outcome"], "completed");
    assert_eq!(summary["verifier_outcome"], "not_run");

    let attempt = directory.path().join(evaluation_id);
    let record_path = attempt.join("record.json");
    let record_bytes = std::fs::read(record_path).unwrap();
    let validated = horizoncode_eval::validate_bytes(&record_bytes).unwrap();
    assert_eq!(validated.evaluation_id, evaluation_id);
    assert_eq!(
        validated.verifier_outcome,
        horizoncode_eval::VerifierOutcome::NotRun
    );
    assert_eq!(
        validated.trajectory.completeness,
        horizoncode_eval::Completeness::Complete
    );
    let trajectory_path = attempt.join("trajectory.json");
    let trajectory = std::fs::read(&trajectory_path).unwrap();
    assert_eq!(
        validated.trajectory.digest,
        format!("blake3:{}", blake3::hash(&trajectory).to_hex())
    );
    assert!(validated.trajectory.reference.ends_with("-trajectory"));
    let events: serde_json::Value = serde_json::from_slice(&trajectory).unwrap();
    assert!(
        events
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["type"] == "tool_finished")
    );
    assert_eq!(
        events.as_array().unwrap().last().unwrap()["type"],
        "turn_finished"
    );

    let workspace_path = attempt.join("workspace.snapshot.json");
    let workspace = std::fs::read(&workspace_path).unwrap();
    assert_eq!(
        validated.workspace_snapshot.digest,
        format!("blake3:{}", blake3::hash(&workspace).to_hex())
    );
    assert!(
        validated
            .workspace_snapshot
            .reference
            .ends_with("-workspace")
    );
    let snapshot: serde_json::Value = serde_json::from_slice(&workspace).unwrap();
    assert_eq!(snapshot["files"][0]["path"], "hello.txt");
    assert!(
        snapshot["files"][0]["digest"]
            .as_str()
            .unwrap()
            .starts_with("blake3:")
    );
    let file_bytes = snapshot["files"][0]["bytes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|byte| u8::try_from(byte.as_u64().unwrap()).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(file_bytes, b"hello from HorizonCode fixture\n");
}

#[test]
fn smoke_fixture_rejects_extra_prompt_path_and_command_arguments() {
    let directory = tempfile::tempdir().unwrap();
    for extra in [
        ["--prompt", "run this"].as_slice(),
        ["--workspace", "/tmp"].as_slice(),
        ["--command", "id"].as_slice(),
        ["--split", "holdout"].as_slice(),
        ["--model", "real-model"].as_slice(),
        ["--provider", "https://example.invalid"].as_slice(),
    ] {
        let mut args = vec!["run", "--fixture", "smoke", "--output-dir"];
        args.push(directory.path().to_str().unwrap());
        args.extend(extra);
        let output = Command::new(env!("CARGO_BIN_EXE_hz-eval"))
            .args(args)
            .output()
            .unwrap();
        assert!(!output.status.success());
    }
}

#[cfg(unix)]
#[test]
fn smoke_fixture_rejects_output_symlinks_and_existing_attempts_are_never_replaced() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let link = directory.path().join("linked-output");
    symlink(target.path(), &link).unwrap();
    let rejected = Command::new(env!("CARGO_BIN_EXE_hz-eval"))
        .args(["run", "--fixture", "smoke", "--output-dir"])
        .arg(&link)
        .output()
        .unwrap();
    assert!(!rejected.status.success());
    assert_eq!(std::fs::read_dir(target.path()).unwrap().count(), 0);

    let first = Command::new(env!("CARGO_BIN_EXE_hz-eval"))
        .args(["run", "--fixture", "smoke", "--output-dir"])
        .arg(directory.path())
        .output()
        .unwrap();
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let first_id =
        serde_json::from_slice::<serde_json::Value>(&first.stdout).unwrap()["evaluation_id"]
            .as_str()
            .unwrap()
            .to_owned();
    let first_record = directory.path().join(&first_id).join("record.json");
    let first_digest = blake3::hash(&std::fs::read(&first_record).unwrap())
        .to_hex()
        .to_string();

    let second = Command::new(env!("CARGO_BIN_EXE_hz-eval"))
        .args(["run", "--fixture", "smoke", "--output-dir"])
        .arg(directory.path())
        .output()
        .unwrap();
    assert!(
        second.status.success(),
        "{}",
        String::from_utf8_lossy(&second.stderr)
    );
    let second_id =
        serde_json::from_slice::<serde_json::Value>(&second.stdout).unwrap()["evaluation_id"]
            .as_str()
            .unwrap()
            .to_owned();
    assert_ne!(first_id, second_id);
    assert_eq!(
        blake3::hash(&std::fs::read(first_record).unwrap())
            .to_hex()
            .to_string(),
        first_digest
    );
}

#[test]
fn unknown_fixture_is_rejected_without_execution() {
    let directory = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hz-eval"))
        .args(["run", "--fixture", "unknown", "--output-dir"])
        .arg(directory.path())
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("only the `smoke` fixture is supported")
    );
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}

#[cfg(not(unix))]
#[test]
fn fixture_reports_unsupported_private_publication_without_writing() {
    let directory = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hz-eval"))
        .args(["run", "--fixture", "smoke", "--output-dir"])
        .arg(directory.path())
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("private fixture artifact publication is unavailable on this platform")
    );
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
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
