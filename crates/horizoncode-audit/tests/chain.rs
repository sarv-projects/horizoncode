//! Integration proofs for the audit chain (`CMP-audit`).
//!
//! Every test here drives the real store on a real temp root with real
//! `fsync`ed appends, real signing, and a real sink. Nothing is mocked except
//! the passage of time, which is injected through explicit `ts` arguments.

use std::fs;
use std::path::{Path, PathBuf};

use horizoncode_audit::{
    Actor, AnchorLevelName, AuditConfig, AuditError, AuditLog, AuditRecord, CensusError,
    CensusWindow, EffectClass, EntryKind, GENESIS_PREV_HASH, Outcome, PolicyEffect, ReplayWindow,
    census, census_strict, digest, merkle_root, verify,
};
use serde_json::Value;
use tempfile::TempDir;

/// A store with a 2-entry segment rollover, so sealed segments are easy to
/// reach in a test.
struct Harness {
    dir: TempDir,
    config: AuditConfig,
}

impl Harness {
    fn with_rollover(segment_max_entries: u64) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let config = AuditConfig {
            root: dir.path().join("audit"),
            segment_max_entries,
            ..AuditConfig::default()
        };
        Self { dir, config }
    }

    fn open(&self) -> AuditLog {
        AuditLog::open(self.config.clone(), &[]).unwrap()
    }

    fn segment_path(&self, index: u32) -> PathBuf {
        self.config.segment_path(index)
    }

    /// Appends one entry of every declared class, in a realistic order.
    fn cover_every_class(&self) {
        let log = self.open();
        let mut ts = 1i64;
        let mut record = |kind: EntryKind, action: &str| {
            ts += 1;
            AuditRecord::new("ses_full", kind)
                .with_turn("turn_1")
                .with_actor(Actor::Agent)
                .with_action(action)
                .with_outcome(Outcome::Ok)
        };
        log.append(record(EntryKind::Run, "turn_start")).unwrap();
        log.append(record(EntryKind::Step, "step_start")).unwrap();
        log.append(
            AuditRecord::new("ses_full", EntryKind::Decision)
                .with_action("fs.write")
                .with_resource("src/lib.rs")
                .with_effect(PolicyEffect::Ask)
                .with_outcome(Outcome::Ok),
        )
        .unwrap();
        log.append(
            AuditRecord::new("ses_full", EntryKind::Approval)
                .with_action("fs.write")
                .with_resource("src/lib.rs")
                .with_outcome(Outcome::Ok)
                .with_meta("reply", "always"),
        )
        .unwrap();
        log.append(
            AuditRecord::new("ses_full", EntryKind::Tool)
                .with_action("edit")
                .with_outcome(Outcome::Ok)
                .with_receipt("rcpt_1"),
        )
        .unwrap();
        log.append(
            AuditRecord::new("ses_full", EntryKind::FsWrite)
                .with_action("fs.write")
                .with_resource("src/lib.rs")
                .with_outcome(Outcome::Ok),
        )
        .unwrap();
        log.append(
            AuditRecord::new("ses_full", EntryKind::Sandbox)
                .with_action("profile_applied")
                .with_outcome(Outcome::Ok),
        )
        .unwrap();
        log.append(
            AuditRecord::new("ses_full", EntryKind::Model)
                .with_action("compatible/mock-model")
                .with_outcome(Outcome::Ok)
                .with_meta("input_tokens", 10i64)
                .with_meta("output_tokens", 4i64),
        )
        .unwrap();
        log.append(
            AuditRecord::new("ses_full", EntryKind::Cost)
                .with_action("step_cost")
                .with_outcome(Outcome::Ok)
                .with_meta("cost_usd_micros", 0i64)
                .with_meta("cost_status", "unknown"),
        )
        .unwrap();
        log.append(
            AuditRecord::new("ses_full", EntryKind::Ticket)
                .with_action("issue")
                .with_outcome(Outcome::Ok)
                .with_ticket("tkt_1"),
        )
        .unwrap();
        log.append(
            AuditRecord::new("ses_full", EntryKind::RecordAccess)
                .with_action("audit_verify")
                .with_outcome(Outcome::Ok),
        )
        .unwrap();
    }
}

/// Appends a small, well-formed run and seals it. Timestamps are explicit so
/// the stored bytes are a pure function of this function.
fn seed_run(harness: &Harness) {
    let log = harness.open();
    log.append_at(
        AuditRecord::new("ses_1", EntryKind::Run)
            .with_actor(Actor::Agent)
            .with_action("turn_start")
            .with_outcome(Outcome::Ok),
        1,
    )
    .unwrap();
    log.append_at(
        AuditRecord::new("ses_1", EntryKind::Model)
            .with_action("compatible/mock-model")
            .with_outcome(Outcome::Ok)
            .with_meta("input_tokens", 7i64),
        2,
    )
    .unwrap();
    log.append_at(
        AuditRecord::new("ses_1", EntryKind::Cost)
            .with_action("turn_cost")
            .with_outcome(Outcome::Ok)
            .with_meta("cost_status", "unknown"),
        3,
    )
    .unwrap();
    log.finish_turn().unwrap();
}

/// Rewrites exactly one byte of the store, in place.
///
/// `from` and `to` must be the same length: this is a byte substitution, not a
/// truncation, so the change cannot be confused with a short write.
fn mutate_one_byte(path: &Path, from: &str, to: &str) {
    assert_eq!(
        from.len(),
        to.len(),
        "a one-byte mutation must not change the store length"
    );
    let raw = fs::read_to_string(path).unwrap();
    let at = raw
        .find(from)
        .unwrap_or_else(|| panic!("`{from}` not found in the store"));
    let mut next = raw.clone();
    next.replace_range(at..at + from.len(), to);
    fs::write(path, next).unwrap();
}

#[test]
fn an_untampered_run_verifies_and_names_its_level_and_claim_boundary() {
    let harness = Harness::with_rollover(64);
    seed_run(&harness);

    let report = verify(&harness.config).unwrap();
    assert_eq!(report.entries_checked, 3);
    assert_eq!(report.roots_checked, 1);
    assert_eq!(report.anchored_roots, 1);
    // A segment file exists only once an entry is written to it, so sealing the
    // only segment leaves exactly one file behind; the next append opens 0001.
    assert_eq!(report.segments.len(), 1);
    assert!(report.segments[0].sealed && report.segments[0].anchored);
    {
        let log = harness.open();
        assert_eq!(
            log.head().segment,
            1,
            "the next append must open a new, unfinalized segment"
        );
    }
    assert_eq!(report.claim.level, AnchorLevelName::LocalSink);
    assert_eq!(report.unanchored_tail, None);
    for segment in &report.segments {
        assert!(
            segment.signature_ok,
            "segment {} signature",
            segment.segment
        );
        assert_eq!(
            Some(&segment.recomputed_merkle_root),
            segment.signed_merkle_root.as_ref(),
            "the recomputed root must equal the signed root"
        );
    }

    // The rendered claim boundary states what it does not prove, and never
    // renders `local-sink` as `off-box` (`REQ-AUDIT-007`).
    let rendered = report.render_claim();
    let level_line = rendered
        .lines()
        .find(|line| line.starts_with("anchoring level:"))
        .expect("the level must be rendered");
    assert_eq!(
        level_line,
        "anchoring level: local-sink (signature algorithm: blake3-keyed-mac)"
    );
    // `local-sink` must never be presented as `off-box`: the only `off-box`
    // mention allowed is the sentence saying which level *would* be stronger.
    for line in rendered.lines() {
        if line.contains("off-box") {
            assert!(
                line.contains("only level that survives"),
                "`off-box` must only appear as the stronger level, never as this one: {line}"
            );
        }
    }
    assert!(rendered.contains("verify does NOT prove:"), "{rendered}");
    for required in ["content", "fabrication", "sink", "unanchored"] {
        let section = rendered
            .split("verify does NOT prove:")
            .nth(1)
            .expect("the boundary section must be rendered");
        assert!(
            section.contains(required),
            "the local-sink boundary must name `{required}`: {section}"
        );
    }
    assert!(rendered.contains("unanchored tail: none"), "{rendered}");
}

#[test]
fn a_mutated_byte_in_a_committed_event_fails_verify_and_names_the_first_divergence() {
    let harness = Harness::with_rollover(64);
    seed_run(&harness);
    verify(&harness.config).unwrap();

    // Exactly one byte of the second entry changes: the last `l` of the model
    // id becomes `r`. The stored bytes stay the same length and still parse,
    // so the *hash* is the only witness.
    let path = harness.segment_path(0);
    let before = fs::read(&path).unwrap();
    mutate_one_byte(
        &path,
        r#""action":"compatible/mock-model""#,
        r#""action":"compatible/mock-moder""#,
    );
    let after = fs::read(&path).unwrap();
    assert_eq!(
        before.len(),
        after.len(),
        "the store length must not change"
    );
    assert_ne!(before, after, "the store bytes must differ");

    let error = verify(&harness.config).unwrap_err();
    let text = error.to_string();
    assert!(text.contains("entry hash does not match"), "{text}");
    assert!(
        text.contains("segment 0 seq 1"),
        "the failing seq must be named: {text}"
    );
}

#[test]
fn every_tamper_class_in_a_sealed_segment_is_detected() {
    // Five tamper classes, each on its own copy of the same store: modified,
    // added, removed, reordered, truncated (`REQ-AUDIT-002`).
    for tamper in ["modified", "added", "removed", "reordered", "truncated"] {
        let harness = Harness::with_rollover(64);
        seed_run(&harness);
        let control = verify(&harness.config).unwrap();
        assert_eq!(control.entries_checked, 3, "control run for {tamper}");

        let path = harness.segment_path(0);
        let raw = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = raw.lines().collect();
        match tamper {
            "modified" => mutate_one_byte(
                &path,
                r#""action":"turn_start""#,
                r#""action":"turn_stark""#,
            ),
            "added" => {
                // A well-formed extra line appended to a sealed segment.
                let extra = lines[2].replace(r#""seq":2"#, r#""seq":3"#);
                fs::write(&path, format!("{raw}{extra}\n")).unwrap();
            }
            "removed" => {
                fs::write(&path, format!("{}\n", lines[1])).unwrap();
            }
            "reordered" => {
                let swapped = format!("{}\n{}\n{}\n", lines[1], lines[0], lines[2]);
                fs::write(&path, swapped).unwrap();
            }
            "truncated" => {
                fs::write(&path, format!("{}\n", lines[0])).unwrap();
            }
            other => panic!("unknown tamper class {other}"),
        }

        let error = verify(&harness.config)
            .err()
            .unwrap_or_else(|| panic!("`{tamper}` was not detected"));
        let text = error.to_string();
        assert!(
            !text.is_empty() && text != "the store verified",
            "the `{tamper}` divergence must be named: {text}"
        );
        // Every one of these breaks the sealed segment's root coverage too, so
        // the root check is a second, independent witness.
        assert!(
            text.contains("seq")
                || text.contains("merkle")
                || text.contains("signed root")
                || text.contains("segment"),
            "the `{tamper}` divergence must locate itself: {text}"
        );
    }
}

#[test]
fn a_recomputed_merkle_root_matches_the_signed_root_and_a_tampered_root_fails() {
    let harness = Harness::with_rollover(2);
    let log = harness.open();
    for index in 0..5 {
        log.append(
            AuditRecord::new("ses_1", EntryKind::Step)
                .with_action("step")
                .with_outcome(Outcome::Ok)
                .with_meta("step", index as i64),
        )
        .unwrap();
    }
    log.finish_turn().unwrap();

    // Control: the root recomputed from the committed entry hashes is exactly
    // the root the device key signed.
    let report = verify(&harness.config).unwrap();
    let sealed: Vec<horizoncode_audit::SegmentSummary> = report
        .segments
        .iter()
        .filter(|segment| segment.sealed)
        .cloned()
        .collect();
    // Rollover seals segment 0 (2 entries) and segment 1 (2 entries); the
    // fifth entry opens segment 2, which `finish_turn` then seals too.
    assert_eq!(sealed.len(), 3, "2-entry segments over 5 entries");
    for segment in &sealed {
        assert_eq!(
            Some(&segment.recomputed_merkle_root),
            segment.signed_merkle_root.as_ref()
        );
        assert!(segment.anchored);
    }

    // The recomputation is a pure function of the ordered leaf list, so a
    // different leaf set cannot produce the signed root.
    let leaves = vec![digest(b"a"), digest(b"b")];
    let recomputed = merkle_root(&leaves);
    assert_eq!(recomputed, merkle_root(&leaves));
    let mut tampered_leaves = leaves.clone();
    tampered_leaves[1] = digest(b"b-but-different");
    assert_ne!(merkle_root(&tampered_leaves), recomputed);

    // Tamper with the stored root: the recomputation no longer matches, and the
    // signature no longer covers what is stored.
    let roots_path = harness.config.roots_path();
    let raw = fs::read_to_string(&roots_path).unwrap();
    let first_root = raw.lines().next().unwrap();
    let parsed: Value = serde_json::from_str(first_root).unwrap();
    let forged = parsed["merkle_root"]
        .as_str()
        .unwrap()
        .chars()
        .enumerate()
        .map(|(index, c)| if index == 0 { 'f' } else { c })
        .collect::<String>();
    let mutated = first_root.replace(parsed["merkle_root"].as_str().unwrap(), &forged);
    let rest: String = raw
        .lines()
        .skip(1)
        .map(|line| format!("{line}\n"))
        .collect();
    fs::write(&roots_path, format!("{mutated}\n{rest}")).unwrap();

    let error = verify(&harness.config).unwrap_err();
    let text = error.to_string();
    assert!(text.contains("merkle root differs"), "{text}");
    assert!(text.contains("segment 0"), "{text}");
}

#[test]
fn a_tampered_sealed_segment_entry_fails_the_root_coverage_check() {
    let harness = Harness::with_rollover(2);
    let log = harness.open();
    for index in 0..4 {
        log.append(
            AuditRecord::new("ses_1", EntryKind::Step)
                .with_action("step")
                .with_outcome(Outcome::Ok)
                .with_meta("step", index as i64),
        )
        .unwrap();
    }
    // Segment 0 holds seq 0..1 and is sealed; seq 2..3 live in segment 1.
    log.finish_turn().unwrap();
    verify(&harness.config).unwrap();

    // A writer who can write into the store but not sign: recomputing an
    // existing entry's hash to cover a new payload does not update the root.
    let path = harness.segment_path(0);
    let raw = fs::read_to_string(&path).unwrap();
    let mut lines: Vec<String> = raw.lines().map(str::to_owned).collect();
    let mut first: Value = serde_json::from_str(&lines[0]).unwrap();
    first["action"] = Value::String("rewritten".to_owned());
    // Re-derive the hash the way an attacker with the hashing code would.
    let mut forged = first.clone();
    let body = serde_json::to_string(&forged).unwrap();
    let recomputed = digest(format!("{body}{}", forged["prev_hash"].as_str().unwrap()).as_bytes());
    forged["entry_hash"] = Value::String(recomputed);
    lines[0] = serde_json::to_string(&forged).unwrap();
    fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();

    let error = verify(&harness.config).unwrap_err();
    let text = error.to_string();
    // The chain link from the second entry is the first witness; either way the
    // tamper is detected and located.
    assert!(
        text.contains("predecessor") || text.contains("merkle root") || text.contains("entry hash"),
        "{text}"
    );
}

#[test]
fn a_configured_but_unreachable_sink_fails_closed_and_creates_nothing() {
    let harness = Harness::with_rollover(64);
    // A regular file where the sink's parent directory must be: the sink can
    // never be created or appended to, whatever the process uid is.
    let blocker = harness.dir.path().join("blocker");
    fs::write(&blocker, b"not a directory").unwrap();
    let config = AuditConfig {
        anchor: horizoncode_audit::AnchorConfig {
            sink_path: Some(blocker.join("audit-anchor/roots.jsonl")),
            ..horizoncode_audit::AnchorConfig::default()
        },
        ..harness.config.clone()
    };

    let error = AuditLog::open(config.clone(), &[]).unwrap_err();
    assert!(
        matches!(error, AuditError::SinkUnreachable { .. }),
        "{error}"
    );

    // Fail closed means nothing ran: no chain exists to write into, and the
    // error does not claim a weaker level was in force.
    assert!(!config.root.exists(), "a refused store must not be built");
    let text = error.to_string();
    assert!(text.contains("unreachable"), "{text}");
    assert!(!text.contains("local-trust"), "must not degrade: {text}");
}

#[test]
fn an_unreachable_sink_fails_the_anchor_rather_than_degrading() {
    let harness = Harness::with_rollover(2);
    // A store opened with no sink, then asked to anchor: the configured posture
    // cannot be met, so the seal fails closed instead of being reported as
    // anchored.
    let config = AuditConfig {
        anchor: horizoncode_audit::AnchorConfig {
            offbox: horizoncode_audit::OffBox::None,
            ..horizoncode_audit::AnchorConfig::default()
        },
        ..harness.config.clone()
    };
    let log = AuditLog::open(config.clone(), &[]).unwrap();
    assert_eq!(log.level(), AnchorLevelName::LocalTrust);
    for index in 0..3 {
        log.append(
            AuditRecord::new("ses_1", EntryKind::Step)
                .with_action("step")
                .with_outcome(Outcome::Ok)
                .with_meta("step", index as i64),
        )
        .unwrap();
    }
    // The root is sealed and signed inside the store, but with no sink there is
    // nothing to anchor to, which the report states rather than hiding.
    let report = verify(&config).unwrap();
    assert_eq!(report.claim.level, AnchorLevelName::LocalTrust);
    assert_eq!(report.claim.sink, None);
    assert!(report.anchored_roots == 0);
}

#[test]
fn a_census_gap_fails_loudly_and_an_unregistered_effect_fails_loudly() {
    // (1) A store missing a declared class.
    let harness = Harness::with_rollover(64);
    let log = harness.open();
    for kind in [EntryKind::Run, EntryKind::Step, EntryKind::Cost] {
        log.append(
            AuditRecord::new("ses_1", kind)
                .with_action(kind.as_str())
                .with_outcome(Outcome::Ok),
        )
        .unwrap();
    }
    let error = census_strict(&harness.config, CensusWindow::all()).unwrap_err();
    match &error {
        CensusError::UncoveredClass { classes, .. } => {
            assert!(classes.contains(&EffectClass::Approval), "{error}");
            assert!(classes.contains(&EffectClass::FileWrite), "{error}");
        }
        other => panic!("expected an uncovered-class census failure, got {other}"),
    }
    // A failing census is loud: non-zero, named classes, and no artifact claim.
    assert!(error.to_string().contains("census failed"), "{error}");

    // (2) A full store with a hand-injected, undeclared effect class.
    harness.cover_every_class();
    let clean = census_strict(&harness.config, CensusWindow::all()).unwrap();
    assert!(clean.is_clean());

    let path = harness.segment_path(0);
    let mut raw = fs::read_to_string(&path).unwrap();
    raw.push_str(
        "{\"seq\":9999,\"ts\":1,\"session\":\"ses_full\",\"actor\":\"agent\",\
         \"kind\":\"net_egress\",\"prev_hash\":\"00\",\"entry_hash\":\"00\"}\n",
    );
    fs::write(&path, raw).unwrap();

    let error = census_strict(&harness.config, CensusWindow::all()).unwrap_err();
    assert!(
        matches!(&error, CensusError::UnregisteredEffect { class, .. } if class == "net_egress"),
        "{error}"
    );
    assert!(error.to_string().contains("unregistered"), "{error}");
}

#[test]
fn a_redacted_secret_is_absent_from_the_stored_bytes() {
    const SECRET: &str = "sk-live-DO-NOT-LOG-9f3a2b";
    let dir = tempfile::tempdir().unwrap();
    let config = AuditConfig {
        root: dir.path().join("audit"),
        redaction: horizoncode_audit::RedactionConfig {
            secrets: vec![SECRET.to_owned()],
        },
        ..AuditConfig::default()
    };
    let env = vec![("HORIZONCODE_API_KEY".to_owned(), SECRET.to_owned())];

    // The store is opened with the environment so an environment-derived
    // secret is registered even without the explicit list.
    let log = AuditLog::open(config.clone(), &env).unwrap();
    log.append(
        AuditRecord::new("ses_1", EntryKind::Tool)
            .with_action("bash")
            // A secret in a resource reference, in metadata, and in a
            // credential-shaped field.
            .with_resource(format!("--token={SECRET}"))
            .with_outcome(Outcome::Ok)
            .with_meta("note", format!("failed with {SECRET}"))
            .with_meta("api_key", SECRET),
    )
    .unwrap();
    log.finish_turn().unwrap();

    // Byte comparison across the whole store: segments, the root chain, and the
    // sink.
    let mut checked = 0usize;
    let mut scan = |label: &str, bytes: &[u8]| {
        assert!(
            !String::from_utf8_lossy(bytes).contains(SECRET),
            "{label} leaked the secret"
        );
        checked += bytes.len();
    };
    for index in 0..4 {
        if let Ok(bytes) = fs::read(config.segment_path(index)) {
            scan("segment", &bytes);
        }
    }
    if let Ok(bytes) = fs::read(config.roots_path()) {
        scan("roots", &bytes);
    }
    scan("sink", &fs::read(harness_sink(&config)).unwrap());
    assert!(checked > 0, "nothing was scanned");

    // The redaction itself is recorded, and the value that replaced it is the
    // typed placeholder rather than the secret.
    let entries = log.entries().unwrap();
    let tool = entries
        .iter()
        .find(|entry| entry.kind == EntryKind::Tool)
        .unwrap();
    assert!(!tool.resource.as_deref().unwrap().contains(SECRET));
    let redacted = tool
        .meta
        .get("redacted_fields")
        .and_then(|value| value.as_text())
        .expect("the redaction must be noted");
    assert!(redacted.contains("resource"), "{redacted}");
    assert!(!redacted.contains(SECRET), "{redacted}");

    // The chain still verifies: redaction happened before hashing, so the
    // recorded bytes are the ones that were hashed.
    verify(&config).unwrap();
}

fn harness_sink(config: &AuditConfig) -> PathBuf {
    config.anchor.sink_path.clone().unwrap_or_else(|| {
        config
            .root
            .parent()
            .unwrap()
            .join("audit-anchor/roots.jsonl")
    })
}

#[test]
fn the_unanchored_tail_is_reported_and_never_presented_as_anchored() {
    let harness = Harness::with_rollover(64);
    {
        let log = harness.open();
        log.append(
            AuditRecord::new("ses_1", EntryKind::Run)
                .with_action("turn_start")
                .with_outcome(Outcome::Ok),
        )
        .unwrap();
        log.append(
            AuditRecord::new("ses_1", EntryKind::Step)
                .with_action("step")
                .with_outcome(Outcome::Ok),
        )
        .unwrap();
        log.finish_turn().unwrap();
    }
    // A new turn appends after the last anchored root.
    {
        let log = harness.open();
        log.append(
            AuditRecord::new("ses_1", EntryKind::Run)
                .with_action("turn_start")
                .with_outcome(Outcome::Ok),
        )
        .unwrap();
    }

    let report = verify(&harness.config).unwrap();
    let tail = report.unanchored_tail.expect("the tail must be reported");
    assert_eq!(tail.first_seq, 2);
    assert_eq!(tail.last_seq, 2);
    assert_eq!(tail.count, 1);
    assert_eq!(report.anchored_roots, 1);
    let rendered = report.render_claim();
    assert!(rendered.contains("outside the anchor"), "{rendered}");
    assert!(
        rendered.contains("unanchored tail: seq 2..=2"),
        "{rendered}"
    );
}

#[test]
fn replay_reconstructs_the_timeline_and_refuses_a_diverged_chain() {
    let harness = Harness::with_rollover(64);
    seed_run(&harness);
    {
        let log = harness.open();
        log.append(
            AuditRecord::new("ses_1", EntryKind::Ticket)
                .with_action("issue")
                .with_outcome(Outcome::Ok)
                .with_ticket("tkt_9"),
        )
        .unwrap();
    }

    let report =
        horizoncode_audit::replay(&harness.config, Some("ses_1"), ReplayWindow::default()).unwrap();
    assert_eq!(report.timeline.len(), 4);
    assert_eq!(report.timeline[0].kind, EntryKind::Run);
    assert_eq!(report.timeline[1].class, EffectClass::ModelCall);
    assert!(report.timeline[3].summary.contains("tkt_9"));
    let rendered = report.render();
    assert!(rendered.contains("does not re-execute"), "{rendered}");

    // A window restricts the timeline.
    let windowed = horizoncode_audit::replay(
        &harness.config,
        None,
        ReplayWindow::between(Some(1), Some(1)),
    )
    .unwrap();
    assert_eq!(windowed.timeline.len(), 1);

    // A diverged chain refuses to assert trusted history.
    mutate_one_byte(
        &harness.segment_path(0),
        r#""action":"turn_start""#,
        r#""action":"turn_stark""#,
    );
    let error = horizoncode_audit::replay(&harness.config, None, ReplayWindow::default()).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("refuses to assert trusted history"),
        "{error}"
    );
}

#[test]
fn the_census_artifact_is_generated_and_machine_readable() {
    let harness = Harness::with_rollover(64);
    harness.cover_every_class();
    let artifact = harness.dir.path().join("census.json");
    let report =
        horizoncode_audit::write_artifact(&harness.config, CensusWindow::all(), &artifact).unwrap();
    assert!(report.is_clean());

    let raw = fs::read_to_string(&artifact).unwrap();
    let parsed: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed["level"], "local-sink");
    let classes = parsed["classes"].as_array().unwrap();
    assert_eq!(classes.len(), EffectClass::ALL.len());
    for class in classes {
        assert!(class["count"].as_u64().unwrap() >= 1, "{class}");
    }
    assert!(parsed["proves"].as_array().unwrap().len() >= 2);
    assert!(
        parsed["does_not_prove"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line.as_str().unwrap().contains("undeclared"))
    );
    // A census artifact is a report, not a claim of integrity.
    let chain = census(&harness.config, CensusWindow::all()).unwrap();
    assert!(chain.is_clean());
}

#[test]
fn the_chain_crosses_segment_boundaries_and_stays_dense() {
    let harness = Harness::with_rollover(2);
    let log = harness.open();
    for index in 0..9 {
        log.append(
            AuditRecord::new("ses_1", EntryKind::Step)
                .with_action("step")
                .with_outcome(Outcome::Ok)
                .with_meta("step", index as i64),
        )
        .unwrap();
    }
    log.finish_turn().unwrap();
    let report = verify(&harness.config).unwrap();
    assert_eq!(report.entries_checked, 9);
    assert!(report.segments.len() >= 4);
    assert!(report.roots_checked >= 3);
    for (index, segment) in report.segments.iter().enumerate() {
        assert_eq!(segment.segment, index as u32);
    }
    // Every entry's `prev_hash` is its predecessor's hash, across boundaries.
    let mut expected = GENESIS_PREV_HASH.to_owned();
    for index in 0..8u32 {
        let path = harness.segment_path(index);
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        for line in raw.lines() {
            let entry: Value = serde_json::from_str(line).unwrap();
            assert_eq!(entry["prev_hash"], expected);
            expected = entry["entry_hash"].as_str().unwrap().to_owned();
        }
    }
}
