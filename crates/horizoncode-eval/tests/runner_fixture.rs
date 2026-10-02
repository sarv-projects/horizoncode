use horizoncode_eval::fixture::{execute_smoke, run_smoke};
use horizoncode_runner::RunEvent;
use horizoncode_session::TurnEndStatus;

#[tokio::test]
async fn smoke_executes_the_fixed_task_through_the_production_runner() {
    let result = execute_smoke().await.unwrap();

    assert_eq!(result.status, TurnEndStatus::Completed);
    assert_eq!(result.steps, 2);
    assert_eq!(result.workspace_files.len(), 1);
    assert_eq!(result.workspace_files[0].path, "hello.txt");
    assert_eq!(
        result.workspace_files[0].bytes,
        b"hello from HorizonCode fixture\n"
    );
    assert!(
        result
            .trajectory
            .iter()
            .any(|event| matches!(event, RunEvent::ToolFinished { .. }))
    );
    assert!(matches!(
        result.trajectory.last(),
        Some(RunEvent::TurnFinished {
            status: TurnEndStatus::Completed,
            ..
        })
    ));
}

#[tokio::test]
async fn smoke_trajectory_and_workspace_snapshot_are_bounded() {
    let result = execute_smoke().await.unwrap();

    assert!(result.trajectory.len() <= 256);
    assert!(result.trajectory_bytes.len() <= 256 * 1024);
    assert!(
        result
            .workspace_files
            .iter()
            .map(|file| file.bytes.len())
            .sum::<usize>()
            <= 64 * 1024
    );
}

#[tokio::test]
async fn run_smoke_persists_three_separate_create_new_artifacts() {
    let output = tempfile::tempdir().unwrap();
    let report = run_smoke(output.path()).await.unwrap();
    let attempt = output.path().join(&report.attempt_directory);
    let mut names = std::fs::read_dir(&attempt)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(
        names,
        ["record.json", "trajectory.json", "workspace.snapshot.json"]
    );

    let record_bytes = std::fs::read(attempt.join("record.json")).unwrap();
    let record = horizoncode_eval::validate_bytes(&record_bytes).unwrap();
    assert_eq!(record.evaluation_id, report.evaluation_id);
    assert_eq!(
        record.evaluation_group_id,
        format!("group-{}", report.evaluation_id)
    );
    assert_eq!(record.attempt_number, 1);
    assert_eq!(record.retry_of, None);
    assert_eq!(
        record.verifier_outcome,
        horizoncode_eval::VerifierOutcome::NotRun
    );
    assert_eq!(record.outcome, horizoncode_eval::Outcome::Completed);
    assert_eq!(
        record.trajectory.reference,
        format!("artifact:{}-trajectory", report.evaluation_id)
    );
    assert_eq!(
        record.workspace_snapshot.reference,
        format!("artifact:{}-workspace", report.evaluation_id)
    );
    assert_ne!(
        record.trajectory.reference,
        record.workspace_snapshot.reference
    );

    let trajectory = std::fs::read(attempt.join("trajectory.json")).unwrap();
    let snapshot = std::fs::read(attempt.join("workspace.snapshot.json")).unwrap();
    assert_eq!(
        record.trajectory.digest,
        format!("blake3:{}", blake3::hash(&trajectory).to_hex())
    );
    assert_eq!(
        record.workspace_snapshot.digest,
        format!("blake3:{}", blake3::hash(&snapshot).to_hex())
    );
    let workspace: serde_json::Value = serde_json::from_slice(&snapshot).unwrap();
    assert_eq!(workspace["files"][0]["path"], "hello.txt");
    assert_eq!(
        workspace["files"][0]["bytes"].as_array().unwrap().len(),
        b"hello from HorizonCode fixture\n".len()
    );
}

#[tokio::test]
async fn run_smoke_refuses_symlinked_output_roots() {
    #[cfg(unix)]
    {
        let directory = tempfile::tempdir().unwrap();
        let actual = directory.path().join("actual");
        let link = directory.path().join("link");
        std::fs::create_dir(&actual).unwrap();
        std::os::unix::fs::symlink(&actual, &link).unwrap();
        assert!(run_smoke(&link).await.is_err());
        assert_eq!(std::fs::read_dir(actual).unwrap().count(), 0);
    }
}

#[tokio::test]
async fn run_smoke_requires_an_existing_real_output_directory() {
    #[cfg(unix)]
    {
        let parent = tempfile::tempdir().unwrap();
        let missing = parent.path().join("missing-output");
        assert!(run_smoke(&missing).await.is_err());
        assert!(!missing.exists());
    }
}
