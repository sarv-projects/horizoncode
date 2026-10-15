use std::collections::HashSet;

const DEFAULT_MAX_PROCESSES: usize = 256;
const DEFAULT_MAX_WORK: usize = 4096;
const DEFAULT_MAX_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct ProcessIdentity {
    pub pid: u32,
    /// OS-issued start-time/generation value, not a caller-visible command-line identity.
    pub start_identity: u64,
    #[cfg(windows)]
    /// Live handle supplied by the owning runtime; this module never opens arbitrary PIDs.
    pub process_handle: isize,
}

impl ProcessIdentity {
    pub const fn new(pid: u32, start_identity: u64) -> Self {
        Self {
            pid,
            start_identity,
            #[cfg(windows)]
            process_handle: 0,
        }
    }

    #[cfg(windows)]
    pub const fn with_handle(pid: u32, start_identity: u64, process_handle: isize) -> Self {
        Self {
            pid,
            start_identity,
            process_handle,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UnknownReason {
    Unsupported,
    PermissionDenied,
    Exited,
    IdentityChanged,
    Unavailable,
    Malformed,
    BudgetExceeded,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Metric<T> {
    Measured(T),
    Unknown(UnknownReason),
}

impl<T> Metric<T> {
    pub const fn measured(value: T) -> Self {
        Self::Measured(value)
    }
    pub const fn unknown(reason: UnknownReason) -> Self {
        Self::Unknown(reason)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CounterSet {
    pub pss_bytes: Metric<u128>,
    pub rss_bytes: Metric<u128>,
    pub cpu_ns: Metric<u128>,
    pub thread_count: Metric<u128>,
    pub fd_count: Metric<u128>,
    pub private_bytes: Metric<u128>,
}

impl CounterSet {
    pub fn unknown(reason: UnknownReason) -> Self {
        Self {
            pss_bytes: Metric::unknown(reason.clone()),
            rss_bytes: Metric::unknown(reason.clone()),
            cpu_ns: Metric::unknown(reason.clone()),
            thread_count: Metric::unknown(reason.clone()),
            fd_count: Metric::unknown(reason.clone()),
            private_bytes: Metric::unknown(reason),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct SampleBudget {
    pub max_processes: usize,
    pub max_work: usize,
    pub max_bytes: usize,
}

impl Default for SampleBudget {
    fn default() -> Self {
        Self {
            max_processes: DEFAULT_MAX_PROCESSES,
            max_work: DEFAULT_MAX_WORK,
            max_bytes: DEFAULT_MAX_BYTES,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AggregateCounters {
    pub pss_bytes: Metric<u128>,
    pub rss_bytes: Metric<u128>,
    pub cpu_ns: Metric<u128>,
    pub thread_count: Metric<u128>,
    pub fd_count: Metric<u128>,
    pub private_bytes: Metric<u128>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TreeSample {
    pub process_count: usize,
    pub metrics: AggregateCounters,
    pub truncated: bool,
    /// Confirmed PID/start-time pairs only. No command-line or environment data is retained.
    pub processes: Vec<ProcessIdentity>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SampleError {
    InvalidBudget,
    IdentityUnavailable { pid: u32, reason: UnknownReason },
    IdentityChanged { pid: u32 },
}

/// OS adapter. Implementations must return only descendants of the supplied identity, verify
/// the owner's PID/start identity around discovery, and never infer ownership from process data.
/// A production backend must enforce the supplied cumulative source-byte and work-item limits
/// while reading, before allocating/iterating beyond them; the default accounting is for test backends.
pub trait ProcessBackend {
    fn identity(&mut self, pid: u32) -> Result<ProcessIdentity, UnknownReason>;
    fn children(&mut self, parent: &ProcessIdentity)
    -> Result<Vec<ProcessIdentity>, UnknownReason>;
    fn counters(&mut self, identity: &ProcessIdentity) -> CounterSet;
    fn begin_sample(&mut self, _max_bytes: usize, _max_work: usize) {}
    fn bytes_consumed(&self) -> usize {
        0
    }
    fn work_consumed(&self) -> usize {
        0
    }
}

pub fn sample_owned_process<B: ProcessBackend>(
    backend: &mut B,
    owner: ProcessIdentity,
) -> Result<CounterSet, SampleError> {
    backend.begin_sample(DEFAULT_MAX_BYTES, DEFAULT_MAX_WORK);
    let before =
        backend
            .identity(owner.pid)
            .map_err(|reason| SampleError::IdentityUnavailable {
                pid: owner.pid,
                reason,
            })?;
    if before != owner {
        return Err(SampleError::IdentityChanged { pid: owner.pid });
    }
    let counters = backend.counters(&owner);
    match backend.identity(owner.pid) {
        Ok(identity) if identity == owner => Ok(counters),
        Ok(_) => Ok(CounterSet::unknown(UnknownReason::IdentityChanged)),
        Err(reason) => Ok(CounterSet::unknown(reason)),
    }
}

pub fn sample_owned_tree<B: ProcessBackend>(
    backend: &mut B,
    owner: ProcessIdentity,
    budget: SampleBudget,
) -> Result<TreeSample, SampleError> {
    if budget.max_processes == 0
        || budget.max_work == 0
        || budget.max_bytes == 0
        || budget.max_processes > DEFAULT_MAX_PROCESSES
        || budget.max_work > DEFAULT_MAX_WORK
        || budget.max_bytes > DEFAULT_MAX_BYTES
    {
        return Err(SampleError::InvalidBudget);
    }
    backend.begin_sample(budget.max_bytes, budget.max_work);
    let actual =
        backend
            .identity(owner.pid)
            .map_err(|reason| SampleError::IdentityUnavailable {
                pid: owner.pid,
                reason,
            })?;
    if actual != owner {
        return Err(SampleError::IdentityChanged { pid: owner.pid });
    }
    let root_pid = owner.pid;
    let mut queue = vec![owner];
    let mut visited = HashSet::new();
    let mut processes = Vec::new();
    let mut metrics = AggregateCounters {
        pss_bytes: Metric::measured(0),
        rss_bytes: Metric::measured(0),
        cpu_ns: Metric::measured(0),
        thread_count: Metric::measured(0),
        fd_count: Metric::measured(0),
        private_bytes: Metric::measured(0),
    };
    let mut work = 0usize;
    let mut truncation_reason = None;
    let mut truncated = false;

    while let Some(expected) = queue.pop() {
        if !visited.insert(expected.clone()) {
            continue;
        }
        work = work.saturating_add(1);
        if work.saturating_add(backend.work_consumed()) > budget.max_work
            || processes.len() >= budget.max_processes
        {
            truncation_reason = Some(UnknownReason::BudgetExceeded);
            truncated = true;
            break;
        }
        let before =
            backend
                .identity(expected.pid)
                .map_err(|reason| SampleError::IdentityUnavailable {
                    pid: expected.pid,
                    reason,
                })?;
        if before != expected {
            if expected.pid == root_pid {
                return Err(SampleError::IdentityChanged { pid: expected.pid });
            }
            truncation_reason = Some(UnknownReason::IdentityChanged);
            truncated = true;
            continue;
        }
        let counters = backend.counters(&expected);
        if backend.bytes_consumed() > budget.max_bytes || backend.work_consumed() > budget.max_work
        {
            truncation_reason = Some(UnknownReason::BudgetExceeded);
            truncated = true;
            break;
        }
        match backend.identity(expected.pid) {
            Ok(identity) if identity == expected => {}
            Ok(_) if expected.pid == root_pid => {
                return Ok(unknown_tree(UnknownReason::IdentityChanged));
            }
            Err(reason) if expected.pid == root_pid => return Ok(unknown_tree(reason)),
            Ok(_) => {
                truncation_reason = Some(UnknownReason::IdentityChanged);
                truncated = true;
                continue;
            }
            Err(reason) => {
                truncation_reason = Some(reason);
                truncated = true;
                continue;
            }
        }
        merge(&mut metrics, counters);
        processes.push(expected.clone());
        match backend.children(&expected) {
            Ok(children) => {
                work = work.saturating_add(children.len());
                if work.saturating_add(backend.work_consumed()) > budget.max_work
                    || backend.bytes_consumed() > budget.max_bytes
                {
                    truncation_reason = Some(UnknownReason::BudgetExceeded);
                    truncated = true;
                    break;
                }
                for child in children.into_iter().rev() {
                    if !visited.contains(&child) {
                        queue.push(child);
                    }
                }
            }
            Err(reason) => {
                truncation_reason = Some(reason);
                truncated = true;
            }
        }
    }
    if truncated {
        set_all_unknown(
            &mut metrics,
            truncation_reason.unwrap_or(UnknownReason::BudgetExceeded),
        );
    }
    Ok(TreeSample {
        process_count: processes.len(),
        metrics,
        truncated,
        processes,
    })
}

fn unknown_tree(reason: UnknownReason) -> TreeSample {
    TreeSample {
        process_count: 0,
        metrics: AggregateCounters {
            pss_bytes: Metric::unknown(reason.clone()),
            rss_bytes: Metric::unknown(reason.clone()),
            cpu_ns: Metric::unknown(reason.clone()),
            thread_count: Metric::unknown(reason.clone()),
            fd_count: Metric::unknown(reason.clone()),
            private_bytes: Metric::unknown(reason),
        },
        truncated: false,
        processes: Vec::new(),
    }
}

fn set_all_unknown(metrics: &mut AggregateCounters, reason: UnknownReason) {
    metrics.pss_bytes = Metric::unknown(reason.clone());
    metrics.rss_bytes = Metric::unknown(reason.clone());
    metrics.cpu_ns = Metric::unknown(reason.clone());
    metrics.thread_count = Metric::unknown(reason.clone());
    metrics.fd_count = Metric::unknown(reason.clone());
    metrics.private_bytes = Metric::unknown(reason);
}

fn add_metric(target: &mut Metric<u128>, source: Metric<u128>) {
    let current = std::mem::replace(target, Metric::unknown(UnknownReason::Unavailable));
    *target = match (current, source) {
        (Metric::Measured(left), Metric::Measured(right)) => left
            .checked_add(right)
            .map(Metric::Measured)
            .unwrap_or(Metric::Unknown(UnknownReason::Malformed)),
        (Metric::Unknown(reason), _) | (_, Metric::Unknown(reason)) => Metric::Unknown(reason),
    };
}

fn merge(target: &mut AggregateCounters, source: CounterSet) {
    add_metric(&mut target.pss_bytes, source.pss_bytes);
    add_metric(&mut target.rss_bytes, source.rss_bytes);
    add_metric(&mut target.cpu_ns, source.cpu_ns);
    add_metric(&mut target.thread_count, source.thread_count);
    add_metric(&mut target.fd_count, source.fd_count);
    add_metric(&mut target.private_bytes, source.private_bytes);
}

#[cfg(target_os = "linux")]
pub struct LinuxProcBackend {
    proc_root: std::path::PathBuf,
    clock_ticks: u128,
    byte_limit: usize,
    bytes_read: usize,
    work_limit: usize,
    work_used: usize,
}

#[cfg(target_os = "linux")]
impl LinuxProcBackend {
    pub fn system() -> Self {
        Self {
            proc_root: "/proc".into(),
            clock_ticks: unsafe { libc::sysconf(libc::_SC_CLK_TCK) }.max(1) as u128,
            byte_limit: DEFAULT_MAX_BYTES,
            bytes_read: 0,
            work_limit: DEFAULT_MAX_WORK,
            work_used: 0,
        }
    }

    fn charge_work(&mut self) -> Result<(), UnknownReason> {
        if self.work_used >= self.work_limit {
            return Err(UnknownReason::BudgetExceeded);
        }
        self.work_used += 1;
        Ok(())
    }

    fn read_source(&mut self, path: &std::path::Path) -> Result<String, UnknownReason> {
        self.charge_work()?;
        let remaining = self.byte_limit.saturating_sub(self.bytes_read);
        if remaining == 0 {
            return Err(UnknownReason::BudgetExceeded);
        }
        let cap = remaining.min(DEFAULT_MAX_BYTES);
        let text = match bounded_read(path, cap) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                self.bytes_read = self.bytes_read.saturating_add(cap);
                return Err(UnknownReason::BudgetExceeded);
            }
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                return Err(UnknownReason::PermissionDenied);
            }
            Err(_) => return Err(UnknownReason::Unavailable),
        };
        self.bytes_read = self.bytes_read.saturating_add(text.len());
        Ok(text)
    }

    fn stat(&mut self, pid: u32) -> Result<(u32, u64, u128), UnknownReason> {
        let path = self.proc_root.join(pid.to_string()).join("stat");
        let text = self.read_source(&path)?;
        let close = text.rfind(')').ok_or(UnknownReason::Malformed)?;
        let fields: Vec<&str> = text
            .get(close + 2..)
            .ok_or(UnknownReason::Malformed)?
            .split_whitespace()
            .collect();
        if fields.len() <= 19 {
            return Err(UnknownReason::Malformed);
        }
        let parent = fields[1].parse().map_err(|_| UnknownReason::Malformed)?;
        let utime: u128 = fields[11].parse().map_err(|_| UnknownReason::Malformed)?;
        let stime: u128 = fields[12].parse().map_err(|_| UnknownReason::Malformed)?;
        let start = fields[19].parse().map_err(|_| UnknownReason::Malformed)?;
        let cpu_ns = (utime + stime).saturating_mul(1_000_000_000) / self.clock_ticks;
        Ok((parent, start, cpu_ns))
    }

    fn metric_file<T>(
        &mut self,
        path: &std::path::Path,
        parse: impl FnOnce(&str) -> Option<T>,
    ) -> Metric<T> {
        match self.read_source(path) {
            Ok(data) => parse(&data)
                .map(Metric::measured)
                .unwrap_or(Metric::Unknown(UnknownReason::Malformed)),
            Err(reason) => Metric::Unknown(reason),
        }
    }
}

#[cfg(target_os = "linux")]
impl ProcessBackend for LinuxProcBackend {
    fn identity(&mut self, pid: u32) -> Result<ProcessIdentity, UnknownReason> {
        let (_, start, _) = self.stat(pid)?;
        Ok(ProcessIdentity::new(pid, start))
    }

    fn children(
        &mut self,
        parent: &ProcessIdentity,
    ) -> Result<Vec<ProcessIdentity>, UnknownReason> {
        if self.identity(parent.pid)? != *parent {
            return Err(UnknownReason::IdentityChanged);
        }
        self.charge_work()?;
        let task_root = self.proc_root.join(parent.pid.to_string()).join("task");
        let tasks = std::fs::read_dir(&task_root).map_err(|error| {
            if error.kind() == std::io::ErrorKind::PermissionDenied {
                UnknownReason::PermissionDenied
            } else {
                UnknownReason::Unavailable
            }
        })?;
        let mut seen = HashSet::new();
        let mut result = Vec::new();
        let mut tasks = tasks;
        loop {
            if self.work_used >= self.work_limit {
                return Err(UnknownReason::BudgetExceeded);
            }
            let Some(task) = tasks.next() else { break };
            self.work_used += 1;
            let task = task.map_err(|_| UnknownReason::Unavailable)?;
            let tid = task
                .file_name()
                .to_string_lossy()
                .parse::<u32>()
                .map_err(|_| UnknownReason::Malformed)?;
            let path = task_root.join(tid.to_string()).join("children");
            let child_data = self.read_source(&path)?;
            let mut child_values = child_data.split_whitespace();
            loop {
                if self.work_used >= self.work_limit {
                    return Err(UnknownReason::BudgetExceeded);
                }
                let Some(value) = child_values.next() else {
                    break;
                };
                self.work_used += 1;
                let child: u32 = value.parse().map_err(|_| UnknownReason::Malformed)?;
                if seen.insert(child) {
                    let (actual_parent, start, _) = self.stat(child)?;
                    if actual_parent != parent.pid {
                        return Err(UnknownReason::IdentityChanged);
                    }
                    result.push(ProcessIdentity::new(child, start));
                }
            }
        }
        let verify_allowance = self.work_limit.saturating_sub(self.work_used);
        if result.len().saturating_add(1) > verify_allowance {
            return Err(UnknownReason::BudgetExceeded);
        }
        for child in &result {
            let (actual_parent, start, _) = self.stat(child.pid)?;
            if actual_parent != parent.pid || start != child.start_identity {
                return Err(UnknownReason::IdentityChanged);
            }
        }
        if self.identity(parent.pid)? != *parent {
            return Err(UnknownReason::IdentityChanged);
        }
        Ok(result)
    }

    fn counters(&mut self, identity: &ProcessIdentity) -> CounterSet {
        let base = self.proc_root.join(identity.pid.to_string());
        let pss = self.metric_file(&base.join("smaps_rollup"), |data| {
            data.lines()
                .find_map(|line| {
                    line.strip_prefix("Pss:")?
                        .split_whitespace()
                        .next()?
                        .parse::<u128>()
                        .ok()
                })
                .map(|kb| kb * 1024)
        });
        let status_path = base.join("status");
        let status = self.read_source(&status_path);
        let (rss, threads) = match status {
            Ok(data) => (
                data.lines()
                    .find_map(|line| {
                        line.strip_prefix("VmRSS:")?
                            .split_whitespace()
                            .next()?
                            .parse::<u128>()
                            .ok()
                    })
                    .map(|kb| Metric::measured(kb * 1024))
                    .unwrap_or(Metric::unknown(UnknownReason::Malformed)),
                data.lines()
                    .find_map(|line| {
                        line.strip_prefix("Threads:")?
                            .split_whitespace()
                            .next()?
                            .parse::<u128>()
                            .ok()
                    })
                    .map(Metric::measured)
                    .unwrap_or(Metric::unknown(UnknownReason::Malformed)),
            ),
            Err(reason) => (Metric::unknown(reason.clone()), Metric::unknown(reason)),
        };
        let fd_path = base.join("fd");
        let fd_count = match self.charge_work().and_then(|_| {
            std::fs::read_dir(fd_path).map_err(|error| {
                if error.kind() == std::io::ErrorKind::PermissionDenied {
                    UnknownReason::PermissionDenied
                } else {
                    UnknownReason::Unavailable
                }
            })
        }) {
            Ok(entries) => {
                let mut count = 0u128;
                let mut failure = None;
                let allowance = self.work_limit.saturating_sub(self.work_used);
                if allowance == 0 {
                    failure = Some(UnknownReason::BudgetExceeded);
                } else {
                    let mut item_count = 0usize;
                    for entry in entries.take(allowance) {
                        self.work_used += 1;
                        item_count += 1;
                        if entry.is_err() {
                            failure = Some(UnknownReason::Unavailable);
                            break;
                        }
                        count += 1;
                    }
                    if item_count == allowance {
                        failure = Some(UnknownReason::BudgetExceeded);
                    }
                }
                failure
                    .map(Metric::unknown)
                    .unwrap_or(Metric::measured(count))
            }
            Err(reason) => Metric::unknown(reason),
        };
        let cpu_ns = match self.stat(identity.pid) {
            Ok((_, _, ns)) => Metric::measured(ns),
            Err(reason) => Metric::Unknown(reason),
        };
        CounterSet {
            pss_bytes: pss,
            rss_bytes: rss,
            cpu_ns,
            thread_count: threads,
            fd_count,
            private_bytes: Metric::unknown(UnknownReason::Unsupported),
        }
    }

    fn begin_sample(&mut self, max_bytes: usize, max_work: usize) {
        self.byte_limit = max_bytes.min(DEFAULT_MAX_BYTES);
        self.bytes_read = 0;
        self.work_limit = max_work.min(DEFAULT_MAX_WORK);
        self.work_used = 0;
    }

    fn bytes_consumed(&self) -> usize {
        self.bytes_read
    }
    fn work_consumed(&self) -> usize {
        self.work_used
    }
}

#[cfg(target_os = "linux")]
fn bounded_read(path: &std::path::Path, limit: usize) -> std::io::Result<String> {
    use std::io::Read;
    let mut bytes = Vec::with_capacity(limit.min(16 * 1024));
    std::fs::File::open(path)?
        .take(limit as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() == limit {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "proc file reached sampler byte budget",
        ));
    }
    String::from_utf8(bytes)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

#[cfg(target_os = "windows")]
pub struct WindowsHandleBackend {
    owner: ProcessIdentity,
}

#[cfg(target_os = "windows")]
impl WindowsHandleBackend {
    pub fn new(owner: ProcessIdentity) -> Self {
        Self { owner }
    }
    fn handle_identity(&self) -> Result<ProcessIdentity, UnknownReason> {
        if self.owner.process_handle == 0 {
            return Err(UnknownReason::Unavailable);
        }
        let handle = self.owner.process_handle as *mut core::ffi::c_void;
        let mut creation = FileTime { low: 0, high: 0 };
        let mut exit = FileTime { low: 0, high: 0 };
        let mut kernel = FileTime { low: 0, high: 0 };
        let mut user = FileTime { low: 0, high: 0 };
        let ok =
            unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
        let pid = unsafe { GetProcessId(handle) };
        if ok == 0 || pid == 0 {
            return Err(UnknownReason::Exited);
        }
        Ok(ProcessIdentity::with_handle(
            pid,
            (u64::from(creation.high) << 32) | u64::from(creation.low),
            self.owner.process_handle,
        ))
    }
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct FileTime {
    low: u32,
    high: u32,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct ProcessMemoryCountersEx {
    cb: u32,
    page_fault_count: u32,
    peak_working_set_size: usize,
    working_set_size: usize,
    quota_peak_paged_pool_usage: usize,
    quota_paged_pool_usage: usize,
    quota_peak_non_paged_pool_usage: usize,
    quota_non_paged_pool_usage: usize,
    pagefile_usage: usize,
    peak_pagefile_usage: usize,
    private_usage: usize,
}

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetProcessId(process: *mut core::ffi::c_void) -> u32;
    fn GetProcessTimes(
        process: *mut core::ffi::c_void,
        creation: *mut FileTime,
        exit: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
}

#[cfg(target_os = "windows")]
#[link(name = "psapi")]
unsafe extern "system" {
    fn GetProcessMemoryInfo(
        process: *mut core::ffi::c_void,
        counters: *mut ProcessMemoryCountersEx,
        size: u32,
    ) -> i32;
}

#[cfg(target_os = "windows")]
impl ProcessBackend for WindowsHandleBackend {
    fn identity(&mut self, pid: u32) -> Result<ProcessIdentity, UnknownReason> {
        if pid != self.owner.pid {
            return Err(UnknownReason::Unsupported);
        }
        self.handle_identity()
    }
    fn children(
        &mut self,
        _parent: &ProcessIdentity,
    ) -> Result<Vec<ProcessIdentity>, UnknownReason> {
        Err(UnknownReason::Unsupported)
    }
    fn counters(&mut self, identity: &ProcessIdentity) -> CounterSet {
        let mut counters = ProcessMemoryCountersEx {
            cb: std::mem::size_of::<ProcessMemoryCountersEx>() as u32,
            page_fault_count: 0,
            peak_working_set_size: 0,
            working_set_size: 0,
            quota_peak_paged_pool_usage: 0,
            quota_paged_pool_usage: 0,
            quota_peak_non_paged_pool_usage: 0,
            quota_non_paged_pool_usage: 0,
            pagefile_usage: 0,
            peak_pagefile_usage: 0,
            private_usage: 0,
        };
        let handle = identity.process_handle as *mut core::ffi::c_void;
        let size = counters.cb;
        let ok = unsafe { GetProcessMemoryInfo(handle, &mut counters, size) };
        let mut result = CounterSet::unknown(if ok == 0 {
            UnknownReason::Unavailable
        } else {
            UnknownReason::Unsupported
        });
        if ok != 0 {
            result.private_bytes = Metric::measured(counters.private_usage as u128);
        }
        result
    }
}
