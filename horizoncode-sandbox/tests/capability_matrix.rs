//! Per-kernel containment matrix test (DEC-V1-03 evidence seed).
//!
//! Prints a deterministic capability record for this host and the
//! containment matrix of the canonical `workspace-write` profile, and writes
//! both to `CARGO_TARGET_TMPDIR/hz-sandbox-capability-record.txt` so the record
//! survives in the build output even when `--nocapture` is not used.

mod common;

use std::path::PathBuf;

use common::{capabilities, capability_gate};
use horizoncode_sandbox::{
    ConfinedProfile, ConfinementBackend, GuaranteeDimension, GuaranteeLevel, Sandbox,
    SandboxProfile, ScopedRoot,
};

fn record_path() -> PathBuf {
    PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("hz-sandbox-capability-record.txt")
}

#[test]
fn capability_matrix_prints_the_per_kernel_record() {
    let sandbox = Sandbox::probe();
    let record = sandbox.capability_record();
    let repeat = Sandbox::probe().capability_record();
    assert_eq!(record, repeat, "capability record must be deterministic");

    let workspace = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("capability-matrix-workspace");
    let _ = std::fs::create_dir_all(&workspace);
    let profile = SandboxProfile::workspace_write(&workspace);

    let matrix = match sandbox.prepare(&profile) {
        Ok(prepared) => {
            let matrix = prepared.guarantee_record();
            assert_eq!(prepared.backend(), "bubblewrap");
            for dimension in GuaranteeDimension::ALL {
                let assessment = prepared
                    .guarantee(dimension)
                    .unwrap_or_else(|| panic!("missing assessment for {dimension}"));
                if assessment.level != GuaranteeLevel::Enforced {
                    assert!(
                        !assessment.residuals.is_empty(),
                        "{dimension} is {} but states no residual",
                        assessment.level
                    );
                }
            }
            // Write scoping and network denial are the two dimensions the V1
            // workspace-write profile depends on; they must be enforced here or
            // the environment must be reported as insufficient in strict mode.
            let write_enforced = prepared
                .guarantee(GuaranteeDimension::FilesystemWrite)
                .map(|assessment| assessment.level == GuaranteeLevel::Enforced)
                .unwrap_or(false);
            let network_enforced = prepared
                .guarantee(GuaranteeDimension::NetworkEgress)
                .map(|assessment| assessment.level == GuaranteeLevel::Enforced)
                .unwrap_or(false);
            capability_gate(
                "capability_matrix_prints_the_per_kernel_record",
                write_enforced && network_enforced,
                "workspace-write filesystem_write/network_egress are not enforced on this host",
            );
            matrix
        }
        Err(error) => {
            let reason = format!("workspace-write preparation failed: {error}");
            capability_gate(
                "capability_matrix_prints_the_per_kernel_record",
                false,
                &reason,
            );
            format!("# workspace-write not preparable on this host\nreason={error}")
        }
    };

    let bundle = format!("{record}\n\n{matrix}\n");
    println!("{bundle}");
    let path = record_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, &bundle).expect("write capability record");
    eprintln!("capability record written to {}", path.display());
}

#[test]
fn landlock_backend_is_reported_truthfully() {
    let sandbox = Sandbox::probe();
    let capabilities = capabilities();
    let status = capabilities.confined_backend(ConfinementBackend::LandlockWriteScope);
    if !capability_gate(
        "landlock_backend_is_reported_truthfully",
        status.is_available(),
        status
            .reason()
            .unwrap_or("Landlock write scoping unavailable"),
    ) {
        return;
    }
    let abi = capabilities
        .landlock_abi
        .expect("available backend implies an ABI");
    println!("landlock write scope available, ABI {abi}");

    let workspace = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("capability-matrix-landlock");
    let _ = std::fs::create_dir_all(&workspace);

    // A Landlock profile that only declares a writable root: with ABI >= 3 the
    // write scoping is a fully enforced allowlist.
    let mut confined = ConfinedProfile::default();
    confined.backend = ConfinementBackend::LandlockWriteScope;
    confined.scoped_roots = vec![ScopedRoot::write(&workspace)];
    let prepared = sandbox
        .prepare(&SandboxProfile::Confined(confined))
        .expect("Landlock profile prepares when the probe reports availability");
    println!("{}", prepared.guarantee_record());
    // The Landlock backend must not claim read or process-tree enforcement.
    assert_eq!(
        prepared
            .guarantee(GuaranteeDimension::FilesystemRead)
            .map(|a| a.level),
        Some(GuaranteeLevel::Unsupported)
    );
    assert_eq!(
        prepared
            .guarantee(GuaranteeDimension::ProcessTree)
            .map(|a| a.level),
        Some(GuaranteeLevel::Unsupported)
    );
    let write_level = prepared
        .guarantee(GuaranteeDimension::FilesystemWrite)
        .map(|a| a.level)
        .expect("write assessment");
    if abi >= 3 {
        assert_eq!(write_level, GuaranteeLevel::Enforced);
    } else {
        assert_eq!(write_level, GuaranteeLevel::BestEffort);
    }

    // A workspace-write profile carries protected subpaths, which a Landlock
    // allowlist cannot express: the write guarantee must downgrade to
    // best-effort and name the unenforced carveouts instead of overclaiming.
    let mut guarded = match SandboxProfile::workspace_write(&workspace) {
        SandboxProfile::Confined(confined) => confined,
        SandboxProfile::FullAccess => unreachable!(),
    };
    guarded.backend = ConfinementBackend::LandlockWriteScope;
    let prepared = sandbox
        .prepare(&SandboxProfile::Confined(guarded))
        .expect("Landlock workspace-write prepares");
    let assessment = prepared
        .guarantee(GuaranteeDimension::FilesystemWrite)
        .expect("write assessment");
    assert_eq!(assessment.level, GuaranteeLevel::BestEffort);
    assert!(
        assessment
            .residuals
            .iter()
            .any(|residual| residual.contains("protected subpaths cannot be expressed")),
        "the downgrade must name the unprotected carveouts: {:?}",
        assessment.residuals
    );
}
