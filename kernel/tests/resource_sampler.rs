use horizoncode_kernel::resource_sampler::{
    CounterSet, Metric, ProcessBackend, ProcessIdentity, SampleBudget, SampleError, UnknownReason,
    sample_owned_process, sample_owned_tree,
};

#[derive(Clone)]
struct Process {
    identity: ProcessIdentity,
    parent: Option<u32>,
    counters: CounterSet,
}

#[derive(Default)]
struct FakeBackend {
    processes: Vec<Process>,
    mutate_after_read: Option<(u32, ProcessIdentity)>,
    parent_reuse_during_children: Option<(u32, ProcessIdentity)>,
    child_reparent_during_children: Option<(u32, u32)>,
    child_reparent_after_identity: Option<(u32, u32)>,
    reported_bytes: usize,
    reported_work: usize,
    reads: usize,
}

impl ProcessBackend for FakeBackend {
    fn identity(&mut self, pid: u32) -> Result<ProcessIdentity, UnknownReason> {
        let identity = self
            .processes
            .iter()
            .find(|process| process.identity.pid == pid)
            .map(|process| process.identity.clone());
        if self
            .child_reparent_after_identity
            .as_ref()
            .is_some_and(|(child_pid, _)| *child_pid == pid)
        {
            let (child_pid, new_parent) = self
                .child_reparent_after_identity
                .take()
                .expect("matching reparent race is present");
            if let Some(process) = self
                .processes
                .iter_mut()
                .find(|process| process.identity.pid == child_pid)
            {
                process.parent = Some(new_parent);
            }
        }
        identity.ok_or(UnknownReason::Exited)
    }

    fn children(
        &mut self,
        parent: &ProcessIdentity,
    ) -> Result<Vec<ProcessIdentity>, UnknownReason> {
        let children: Vec<_> = self
            .processes
            .iter()
            .filter(|process| process.parent == Some(parent.pid))
            .map(|process| process.identity.clone())
            .collect();
        if let Some((pid, replacement)) = self.parent_reuse_during_children.take() {
            if let Some(process) = self
                .processes
                .iter_mut()
                .find(|process| process.identity.pid == pid)
            {
                process.identity = replacement;
            }
        }
        if let Some((pid, new_parent)) = self.child_reparent_during_children.take() {
            if let Some(process) = self
                .processes
                .iter_mut()
                .find(|process| process.identity.pid == pid)
            {
                process.parent = Some(new_parent);
            }
        }
        if self
            .processes
            .iter()
            .find(|process| process.identity.pid == parent.pid)
            .is_none_or(|process| process.identity != *parent)
            || children.iter().any(|child| {
                self.processes
                    .iter()
                    .find(|process| process.identity.pid == child.pid)
                    .is_none_or(|process| {
                        process.parent != Some(parent.pid) || process.identity != *child
                    })
            })
        {
            return Err(UnknownReason::IdentityChanged);
        }
        Ok(children)
    }

    fn counters(&mut self, identity: &ProcessIdentity) -> CounterSet {
        self.reads += 1;
        let result = self
            .processes
            .iter()
            .find(|process| process.identity == *identity)
            .map(|process| process.counters.clone())
            .unwrap_or_else(|| CounterSet::unknown(UnknownReason::Exited));
        if let Some((pid, replacement)) = self.mutate_after_read.take() {
            if let Some(process) = self
                .processes
                .iter_mut()
                .find(|process| process.identity.pid == pid)
            {
                process.identity = replacement;
            }
        }
        result
    }

    fn bytes_consumed(&self) -> usize {
        self.reported_bytes
    }
    fn work_consumed(&self) -> usize {
        self.reported_work
    }
}

fn identity(pid: u32, start: u64) -> ProcessIdentity {
    ProcessIdentity::new(pid, start)
}

fn counters() -> CounterSet {
    CounterSet {
        pss_bytes: Metric::measured(80),
        rss_bytes: Metric::measured(100),
        cpu_ns: Metric::measured(20),
        thread_count: Metric::measured(2),
        fd_count: Metric::measured(3),
        private_bytes: Metric::unknown(UnknownReason::Unsupported),
    }
}

fn root_and_child() -> Vec<Process> {
    vec![
        Process {
            identity: identity(10, 1),
            parent: None,
            counters: counters(),
        },
        Process {
            identity: identity(11, 2),
            parent: Some(10),
            counters: counters(),
        },
    ]
}

#[test]
fn samples_only_the_explicit_owned_identity_and_descendants() {
    let mut processes = root_and_child();
    processes.push(Process {
        identity: identity(99, 8),
        parent: None,
        counters: counters(),
    });
    let mut backend = FakeBackend {
        processes,
        ..FakeBackend::default()
    };
    let result = sample_owned_tree(&mut backend, identity(10, 1), SampleBudget::default()).unwrap();
    assert_eq!(result.process_count, 2);
    assert_eq!(result.metrics.pss_bytes, Metric::measured(160));
    assert_eq!(backend.reads, 2);
}

#[test]
fn rejects_pid_start_identity_mismatch_before_reading_counters() {
    let mut backend = FakeBackend {
        processes: vec![Process {
            identity: identity(10, 2),
            parent: None,
            counters: counters(),
        }],
        ..FakeBackend::default()
    };
    assert!(matches!(
        sample_owned_tree(&mut backend, identity(10, 1), SampleBudget::default()),
        Err(SampleError::IdentityChanged { pid: 10 })
    ));
    assert_eq!(backend.reads, 0);
}

#[test]
fn detects_pid_reuse_after_counter_read_and_marks_sample_unknown() {
    let mut backend = FakeBackend {
        processes: vec![Process {
            identity: identity(10, 1),
            parent: None,
            counters: counters(),
        }],
        mutate_after_read: Some((10, identity(10, 2))),
        ..FakeBackend::default()
    };
    let result = sample_owned_tree(&mut backend, identity(10, 1), SampleBudget::default()).unwrap();
    assert_eq!(
        result.metrics.pss_bytes,
        Metric::unknown(UnknownReason::IdentityChanged)
    );
    assert_eq!(result.process_count, 0);
}

#[test]
fn single_process_reuse_after_counter_read_marks_sample_unknown() {
    let mut backend = FakeBackend {
        processes: vec![Process {
            identity: identity(10, 1),
            parent: None,
            counters: counters(),
        }],
        mutate_after_read: Some((10, identity(10, 2))),
        ..FakeBackend::default()
    };
    let counters = sample_owned_process(&mut backend, identity(10, 1)).unwrap();
    assert_eq!(
        counters.pss_bytes,
        Metric::unknown(UnknownReason::IdentityChanged)
    );
}

#[test]
fn single_process_owner_that_already_exited_is_an_error_not_a_sample() {
    let mut backend = FakeBackend::default();
    assert!(matches!(
        sample_owned_process(&mut backend, identity(10, 1)),
        Err(SampleError::IdentityUnavailable {
            pid: 10,
            reason: UnknownReason::Exited
        })
    ));
}

#[test]
fn parent_pid_reuse_during_child_enumeration_makes_tree_unknown() {
    let mut backend = FakeBackend {
        processes: root_and_child(),
        parent_reuse_during_children: Some((10, identity(10, 9))),
        ..FakeBackend::default()
    };
    let result = sample_owned_tree(&mut backend, identity(10, 1), SampleBudget::default()).unwrap();
    assert_eq!(
        result.metrics.pss_bytes,
        Metric::unknown(UnknownReason::IdentityChanged)
    );
    assert!(result.truncated);
}

#[test]
fn child_reparented_during_enumeration_is_not_attributed_to_owner() {
    let mut backend = FakeBackend {
        processes: root_and_child(),
        child_reparent_during_children: Some((11, 77)),
        ..FakeBackend::default()
    };
    let result = sample_owned_tree(&mut backend, identity(10, 1), SampleBudget::default()).unwrap();
    assert_eq!(
        result.metrics.pss_bytes,
        Metric::unknown(UnknownReason::IdentityChanged)
    );
    assert!(result.truncated);
}

#[test]
fn child_reparented_after_enumeration_is_not_attributed_to_owner() {
    let mut backend = FakeBackend {
        processes: root_and_child(),
        child_reparent_after_identity: Some((11, 77)),
        ..FakeBackend::default()
    };
    let result = sample_owned_tree(&mut backend, identity(10, 1), SampleBudget::default()).unwrap();
    assert_eq!(
        result.metrics.pss_bytes,
        Metric::unknown(UnknownReason::IdentityChanged)
    );
    assert!(result.truncated);
    assert!(!result.processes.contains(&identity(11, 2)));
}

#[test]
fn denied_and_unsupported_metrics_remain_unknown_and_propagate() {
    let mut denied = counters();
    denied.rss_bytes = Metric::unknown(UnknownReason::PermissionDenied);
    let mut backend = FakeBackend {
        processes: vec![Process {
            identity: identity(10, 1),
            parent: None,
            counters: denied,
        }],
        ..FakeBackend::default()
    };
    let result = sample_owned_tree(&mut backend, identity(10, 1), SampleBudget::default()).unwrap();
    assert_eq!(
        result.metrics.rss_bytes,
        Metric::unknown(UnknownReason::PermissionDenied)
    );
    assert_eq!(
        result.metrics.private_bytes,
        Metric::unknown(UnknownReason::Unsupported)
    );
}

#[test]
fn source_byte_budget_is_enforced_without_reporting_partial_aggregates() {
    let mut backend = FakeBackend {
        processes: vec![Process {
            identity: identity(10, 1),
            parent: None,
            counters: counters(),
        }],
        reported_bytes: 129,
        ..FakeBackend::default()
    };
    let result = sample_owned_tree(
        &mut backend,
        identity(10, 1),
        SampleBudget {
            max_processes: 2,
            max_work: 16,
            max_bytes: 128,
        },
    )
    .unwrap();
    assert_eq!(
        result.metrics.pss_bytes,
        Metric::unknown(UnknownReason::BudgetExceeded)
    );
    assert!(result.truncated);
}

#[test]
fn source_work_item_budget_is_enforced_without_partial_aggregates() {
    let mut backend = FakeBackend {
        processes: vec![Process {
            identity: identity(10, 1),
            parent: None,
            counters: counters(),
        }],
        reported_work: 17,
        ..FakeBackend::default()
    };
    let result = sample_owned_tree(
        &mut backend,
        identity(10, 1),
        SampleBudget {
            max_processes: 2,
            max_work: 16,
            max_bytes: 4096,
        },
    )
    .unwrap();
    assert_eq!(
        result.metrics.pss_bytes,
        Metric::unknown(UnknownReason::BudgetExceeded)
    );
    assert!(result.truncated);
}

#[test]
fn single_process_sampling_marks_over_budget_counters_unknown() {
    let mut backend = FakeBackend {
        processes: vec![Process {
            identity: identity(10, 1),
            parent: None,
            counters: counters(),
        }],
        reported_bytes: 1_048_577,
        ..FakeBackend::default()
    };
    let result = sample_owned_process(&mut backend, identity(10, 1)).unwrap();
    assert_eq!(
        result.pss_bytes,
        Metric::unknown(UnknownReason::BudgetExceeded)
    );

    let mut backend = FakeBackend {
        processes: vec![Process {
            identity: identity(10, 1),
            parent: None,
            counters: counters(),
        }],
        reported_work: 4097,
        ..FakeBackend::default()
    };
    let result = sample_owned_process(&mut backend, identity(10, 1)).unwrap();
    assert_eq!(
        result.pss_bytes,
        Metric::unknown(UnknownReason::BudgetExceeded)
    );
}

#[test]
fn traversal_is_bounded_and_truncation_makes_aggregates_unknown() {
    let processes = (10..15)
        .map(|pid| Process {
            identity: identity(pid, pid as u64),
            parent: if pid == 10 { None } else { Some(pid - 1) },
            counters: counters(),
        })
        .collect();
    let mut backend = FakeBackend {
        processes,
        ..FakeBackend::default()
    };
    let result = sample_owned_tree(
        &mut backend,
        identity(10, 10),
        SampleBudget {
            max_processes: 2,
            max_work: 16,
            max_bytes: 4096,
        },
    )
    .unwrap();
    assert_eq!(result.process_count, 2);
    assert!(result.truncated);
    assert_eq!(
        result.metrics.pss_bytes,
        Metric::unknown(UnknownReason::BudgetExceeded)
    );
}

#[cfg(target_os = "linux")]
#[test]
fn linux_proc_backend_samples_a_live_owned_process_generation() {
    use std::process::{Child, Command, Stdio};

    struct ChildGuard(Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    let child = ChildGuard(
        Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start bounded test-owned child"),
    );
    let mut backend = horizoncode_kernel::resource_sampler::LinuxProcBackend::system();
    let identity = backend
        .identity(child.0.id())
        .expect("read the child PID/start identity from /proc");
    let sample = sample_owned_tree(&mut backend, identity.clone(), SampleBudget::default())
        .expect("sample only the live child identity");

    assert_eq!(sample.process_count, 1);
    assert_eq!(sample.processes, vec![identity]);
    assert!(!sample.truncated);
    assert!(matches!(sample.metrics.pss_bytes, Metric::Measured(value) if value > 0));
    assert!(matches!(sample.metrics.rss_bytes, Metric::Measured(value) if value > 0));
    assert!(matches!(sample.metrics.cpu_ns, Metric::Measured(_)));
    assert!(matches!(sample.metrics.thread_count, Metric::Measured(value) if value > 0));
    assert!(matches!(sample.metrics.fd_count, Metric::Measured(_)));
}

/// Live capture readiness: the real Linux backend samples an owned process tree
/// with every required RC0 metric MEASURED and no unknown substitution. This is
/// harness/OS evidence for the `scripts/perf/rc0.py` capture path; it is not a
/// 1/5/10/20 Horizon baseline and never launches product workloads.
#[cfg(target_os = "linux")]
mod linux_capture_readiness {
    use horizoncode_kernel::resource_sampler::{
        AggregateCounters, LinuxProcBackend, Metric, ProcessBackend, SampleBudget, SampleError,
        TreeSample, sample_owned_tree,
    };

    // Both live tests spawn children of the test process. Serialize them so the
    // exited-owner negative cannot intentionally kill a sibling process while
    // the positive test is sampling that same test-process tree.
    static LIVE_SAMPLE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn assert_required_metrics_measured(counters: &AggregateCounters) {
        for (label, value) in [
            ("pss_bytes", &counters.pss_bytes),
            ("rss_bytes", &counters.rss_bytes),
            ("cpu_ns", &counters.cpu_ns),
            ("thread_count", &counters.thread_count),
            ("fd_count", &counters.fd_count),
        ] {
            assert!(
                matches!(value, Metric::Measured(_)),
                "required RC0 metric {label} must be MEASURED for an owned tree: {value:?}"
            );
        }
    }

    #[test]
    fn live_linux_tree_sampling_measures_every_required_metric() {
        let _lock = LIVE_SAMPLE_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn an owned test child");
        let mut backend = LinuxProcBackend::system();
        let owner = backend
            .identity(std::process::id())
            .expect("own process identity is readable");
        let result = sample_owned_tree(&mut backend, owner.clone(), SampleBudget::default())
            .expect("owned tree sampling");
        child.kill().expect("kill owned child");
        child.wait().expect("reap owned child");

        assert!(!result.truncated, "{result:?}");
        assert!(result.process_count >= 2, "{result:?}");
        assert!(
            result.processes.contains(&owner),
            "owner identity is present in its own owned tree"
        );
        assert!(
            result
                .processes
                .iter()
                .any(|process| process.pid == child.id()),
            "spawned child is attributed to the owned tree"
        );
        assert_required_metrics_measured(&result.metrics);
    }

    #[test]
    fn live_linux_sampling_never_fabricates_a_sample_for_an_exited_owner() {
        let _lock = LIVE_SAMPLE_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn an owned test child");
        let pid = child.id();
        let mut backend = LinuxProcBackend::system();
        let owner = backend.identity(pid).expect("child identity");
        child.kill().expect("kill owned child");
        child.wait().expect("reap owned child");
        match sample_owned_tree(&mut backend, owner.clone(), SampleBudget::default()) {
            Err(SampleError::IdentityUnavailable { .. }) => {}
            Err(other) => panic!("unexpected sampling error for an exited owner: {other:?}"),
            Ok(TreeSample {
                metrics, processes, ..
            }) => {
                // A recycled identity may still resolve, but the sample must
                // then carry the owner or an explicit UNKNOWN -- never a
                // fabricated measurement attributed to the dead process.
                let owner_present = processes.contains(&owner);
                let measured = matches!(metrics.pss_bytes, Metric::Measured(_));
                assert!(
                    !measured || owner_present,
                    "measured tree for an exited owner must include its identity: {processes:?}"
                );
            }
        }
    }
}
