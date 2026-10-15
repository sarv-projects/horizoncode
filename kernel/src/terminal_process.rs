//! Bounded, owner-managed terminal process backends.
//!
//! Commands, arguments, working directories, and environment values are never logged. The
//! supplied environment replaces the inherited environment; an empty map means empty env.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::process::ExitStatus;
use std::time::{Duration, Instant};

pub const MAX_INPUT_BYTES: usize = 16 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug)]
pub struct TerminalLaunchSpec {
    pub executable: PathBuf,
    /// Argument vector excluding the executable (as with `Command::args`).
    pub argv: Vec<OsString>,
    pub cwd: PathBuf,
    /// Complete child environment; the ambient environment is never inherited.
    pub env: BTreeMap<OsString, OsString>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalBackend {
    LinuxPty,
    WindowsConPty,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProcessGuarantees {
    /// A successful `try_wait` is the only indication that exit was observed.
    pub observed_exit: bool,
    /// Owner/process-handle close is configured to kill the process tree.
    pub tree_kill_on_owner_close: bool,
    /// Whether process-group/job termination is available on this backend.
    pub process_tree_termination: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminationReason {
    Cancelled,
    TimedOut,
    OwnerLost,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaitOutcome {
    Exited(ExitStatus),
    TimedOut,
}

pub struct TerminalProcess {
    inner: platform::Process,
}

impl TerminalProcess {
    pub fn spawn(spec: TerminalLaunchSpec) -> io::Result<Self> {
        validate_size(spec.cols, spec.rows)?;
        Ok(Self {
            inner: platform::Process::spawn(spec)?,
        })
    }

    pub fn backend(&self) -> TerminalBackend {
        self.inner.backend()
    }
    pub fn guarantees(&self) -> ProcessGuarantees {
        self.inner.guarantees()
    }
    pub fn pid(&self) -> u32 {
        self.inner.pid()
    }
    pub fn owner_loss_tree_cleanup_supported() -> bool {
        platform::Process::owner_loss_tree_cleanup_supported()
    }
    /// Polls at most `max_bytes`; `WouldBlock` is represented as an empty vector.
    pub fn read_output(&mut self, max_bytes: usize) -> io::Result<Vec<u8>> {
        if max_bytes > MAX_OUTPUT_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "output read exceeds 64 KiB",
            ));
        }
        self.inner.read_output(max_bytes)
    }

    /// Writes one bounded input frame. A partial nonblocking write is reported as an error.
    pub fn write_input(&mut self, bytes: &[u8]) -> io::Result<()> {
        if bytes.len() > MAX_INPUT_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "input exceeds 16 KiB",
            ));
        }
        self.inner.write_input(bytes)
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> io::Result<()> {
        validate_size(cols, rows)?;
        self.inner.resize(cols, rows)
    }

    /// Requests process-tree termination; this does not assert that termination has occurred.
    pub fn request_terminate(&mut self, reason: TerminationReason) -> io::Result<()> {
        self.inner.request_terminate(reason)
    }

    /// `Some` means the operating system has reported process exit; `None` means unknown/running.
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.inner.try_wait()
    }

    /// Waits until exit or a deadline. At the deadline it requests kill and returns TimedOut;
    /// callers must continue polling `try_wait` before reporting termination.
    pub fn wait_timeout(&mut self, timeout: Duration) -> io::Result<WaitOutcome> {
        let deadline = Instant::now().checked_add(timeout);
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(WaitOutcome::Exited(status));
            }
            if deadline.is_none_or(|deadline| Instant::now() >= deadline) {
                self.request_terminate(TerminationReason::TimedOut)?;
                return Ok(WaitOutcome::TimedOut);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

fn validate_size(cols: u16, rows: u16) -> io::Result<()> {
    if !(1..=500).contains(&cols) || !(1..=300).contains(&rows) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "terminal size out of range",
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::fs::File;
    use std::io::{Read, Write};
    use std::os::fd::{FromRawFd, OwnedFd};
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command};

    pub struct Process {
        master: File,
        child: Child,
        pid: u32,
        exit: Option<ExitStatus>,
    }

    impl Process {
        pub fn spawn(spec: TerminalLaunchSpec) -> io::Result<Self> {
            let mut master = -1;
            let mut slave = -1;
            // SAFETY: both output pointers reference live integers; the kernel initializes them.
            let opened = unsafe {
                libc::openpty(
                    &mut master,
                    &mut slave,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    std::ptr::null(),
                )
            };
            if opened != 0 {
                return Err(io::Error::last_os_error());
            }
            // Keep both PTY descriptors out of unrelated execs; dup2 in the child
            // installs only the slave on stdin/stdout/stderr.
            for fd in [master, slave] {
                let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
                if flags < 0
                    || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0
                {
                    let error = io::Error::last_os_error();
                    unsafe {
                        libc::close(master);
                        libc::close(slave);
                    }
                    return Err(error);
                }
            }
            // Transfer each newly-created descriptor to RAII immediately.
            let master_fd = unsafe { OwnedFd::from_raw_fd(master) };
            let slave_fd = unsafe { OwnedFd::from_raw_fd(slave) };
            let mut winsize = libc::winsize {
                ws_row: spec.rows,
                ws_col: spec.cols,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            // SAFETY: slave descriptor is valid and winsize is initialized.
            if unsafe {
                libc::ioctl(
                    std::os::fd::AsRawFd::as_raw_fd(&slave_fd),
                    libc::TIOCSWINSZ,
                    &mut winsize,
                )
            } < 0
            {
                return Err(io::Error::last_os_error());
            }
            let slave_raw = std::os::fd::AsRawFd::as_raw_fd(&slave_fd);
            let mut command = Command::new(&spec.executable);
            command
                .args(&spec.argv)
                .current_dir(&spec.cwd)
                .env_clear()
                .envs(&spec.env);
            // SAFETY: this closure runs after fork and performs only async-signal-safe syscalls.
            unsafe {
                command.pre_exec(move || {
                    if libc::setsid() < 0 {
                        return Err(io::Error::last_os_error());
                    }
                    if libc::ioctl(slave_raw, libc::TIOCSCTTY, 0) < 0 {
                        return Err(io::Error::last_os_error());
                    }
                    for target in [libc::STDIN_FILENO, libc::STDOUT_FILENO, libc::STDERR_FILENO] {
                        if libc::dup2(slave_raw, target) < 0 {
                            return Err(io::Error::last_os_error());
                        }
                    }
                    Ok(())
                });
            }
            let child = command.spawn()?;
            drop(slave_fd);
            let flags =
                unsafe { libc::fcntl(std::os::fd::AsRawFd::as_raw_fd(&master_fd), libc::F_GETFL) };
            if flags < 0
                || unsafe {
                    libc::fcntl(
                        std::os::fd::AsRawFd::as_raw_fd(&master_fd),
                        libc::F_SETFL,
                        flags | libc::O_NONBLOCK,
                    )
                } < 0
            {
                let error = io::Error::last_os_error();
                let mut child = child;
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            let pid = child.id();
            // SAFETY: ownership of master_fd transfers to File exactly once.
            let master =
                unsafe { File::from_raw_fd(std::os::fd::IntoRawFd::into_raw_fd(master_fd)) };
            Ok(Self {
                master,
                child,
                pid,
                exit: None,
            })
        }

        pub fn pid(&self) -> u32 {
            self.pid
        }
        pub fn backend(&self) -> TerminalBackend {
            TerminalBackend::LinuxPty
        }
        pub fn guarantees(&self) -> ProcessGuarantees {
            ProcessGuarantees {
                observed_exit: true,
                tree_kill_on_owner_close: false,
                process_tree_termination: false,
            }
        }
        pub fn owner_loss_tree_cleanup_supported() -> bool {
            false
        }
        pub fn read_output(&mut self, max: usize) -> io::Result<Vec<u8>> {
            let mut bytes = vec![0; max];
            match self.master.read(&mut bytes) {
                Ok(count) => {
                    bytes.truncate(count);
                    Ok(bytes)
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(Vec::new()),
                Err(error) if error.raw_os_error() == Some(libc::EIO) => Ok(Vec::new()),
                Err(error) => Err(error),
            }
        }
        pub fn write_input(&mut self, bytes: &[u8]) -> io::Result<()> {
            match self.master.write(bytes) {
                Ok(count) if count == bytes.len() => Ok(()),
                Ok(_) => Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "partial nonblocking terminal write",
                )),
                Err(error) => Err(error),
            }
        }
        pub fn resize(&mut self, cols: u16, rows: u16) -> io::Result<()> {
            let winsize = libc::winsize {
                ws_row: rows,
                ws_col: cols,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            // SAFETY: master is valid and winsize is initialized.
            if unsafe {
                libc::ioctl(
                    std::os::fd::AsRawFd::as_raw_fd(&self.master),
                    libc::TIOCSWINSZ,
                    &winsize,
                )
            } < 0
            {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }
        pub fn request_terminate(&mut self, _reason: TerminationReason) -> io::Result<()> {
            // The PTY child called setsid, so its PID is also the process-group ID.
            if unsafe { libc::kill(-(self.pid as libc::pid_t), libc::SIGKILL) } == 0 {
                Ok(())
            } else {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ESRCH) {
                    Ok(())
                } else {
                    Err(error)
                }
            }
        }
        pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            if self.exit.is_none() {
                self.exit = self.child.try_wait()?;
            }
            Ok(self.exit)
        }
    }

    impl Drop for Process {
        fn drop(&mut self) {
            // Kill the complete PTY process group before reaping its leader. Do not
            // report termination to callers unless try_wait observed it.
            let _ = self.request_terminate(TerminationReason::OwnerLost);
            if self.exit.is_none() {
                self.exit = self.child.wait().ok();
            }
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::{OsStr, c_void};
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::process::ExitStatusExt;
    use std::ptr::{null, null_mut};
    use std::thread;

    type Handle = *mut c_void;
    type Hpc = *mut c_void;
    type Bool = i32;
    type Dword = u32;
    type SizeT = usize;
    #[repr(C)]
    struct Coord {
        x: i16,
        y: i16,
    }
    #[repr(C)]
    struct StartupInfo {
        cb: Dword,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        x: Dword,
        y: Dword,
        xsize: Dword,
        ysize: Dword,
        xchars: Dword,
        ychars: Dword,
        fill: Dword,
        flags: Dword,
        show: u16,
        reserved2_size: u16,
        reserved2: *mut u8,
        stdin: Handle,
        stdout: Handle,
        stderr: Handle,
    }
    #[repr(C)]
    struct StartupInfoEx {
        startup: StartupInfo,
        attributes: *mut c_void,
    }
    #[repr(C)]
    struct ProcessInfo {
        process: Handle,
        thread: Handle,
        pid: Dword,
        tid: Dword,
    }
    #[repr(C)]
    struct SecurityAttributes {
        length: Dword,
        descriptor: *mut c_void,
        inherit: Bool,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreatePipe(
            read: *mut Handle,
            write: *mut Handle,
            attrs: *const SecurityAttributes,
            size: Dword,
        ) -> Bool;
        fn SetHandleInformation(handle: Handle, mask: Dword, flags: Dword) -> Bool;
        fn CloseHandle(handle: Handle) -> Bool;
        fn CreatePseudoConsole(
            size: Coord,
            input: Handle,
            output: Handle,
            flags: Dword,
            console: *mut Hpc,
        ) -> i32;
        fn ResizePseudoConsole(console: Hpc, size: Coord) -> i32;
        fn ClosePseudoConsole(console: Hpc);
        fn InitializeProcThreadAttributeList(
            list: *mut c_void,
            count: Dword,
            flags: Dword,
            size: *mut SizeT,
        ) -> Bool;
        fn UpdateProcThreadAttribute(
            list: *mut c_void,
            flags: Dword,
            attribute: usize,
            value: *mut c_void,
            size: SizeT,
            previous: *mut c_void,
            returned: *mut SizeT,
        ) -> Bool;
        fn DeleteProcThreadAttributeList(list: *mut c_void);
        fn CreateProcessW(
            app: *const u16,
            command: *mut u16,
            proc_sec: *mut SecurityAttributes,
            thread_sec: *mut SecurityAttributes,
            inherit: Bool,
            flags: Dword,
            environment: *mut c_void,
            cwd: *const u16,
            startup: *mut StartupInfo,
            info: *mut ProcessInfo,
        ) -> Bool;
        fn CreateJobObjectW(attrs: *mut SecurityAttributes, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            info: *const c_void,
            length: Dword,
        ) -> Bool;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> Bool;
        fn TerminateProcess(process: Handle, code: Dword) -> Bool;
        fn ResumeThread(thread: Handle) -> Dword;
        fn TerminateJobObject(job: Handle, code: Dword) -> Bool;
        fn WaitForSingleObject(handle: Handle, millis: Dword) -> Dword;
        fn GetExitCodeProcess(process: Handle, code: *mut Dword) -> Bool;
        fn PeekNamedPipe(
            pipe: Handle,
            buffer: *mut c_void,
            size: Dword,
            read: *mut Dword,
            available: *mut Dword,
            left: *mut Dword,
        ) -> Bool;
        fn ReadFile(
            handle: Handle,
            buffer: *mut c_void,
            size: Dword,
            read: *mut Dword,
            overlapped: *mut c_void,
        ) -> Bool;
        fn WriteFile(
            handle: Handle,
            buffer: *const c_void,
            size: Dword,
            written: *mut Dword,
            overlapped: *mut c_void,
        ) -> Bool;
    }
    const HANDLE_FLAG_INHERIT: Dword = 1;
    const EXTENDED_STARTUPINFO_PRESENT: Dword = 0x0008_0000;
    const CREATE_UNICODE_ENVIRONMENT: Dword = 0x0000_0400;
    const CREATE_SUSPENDED: Dword = 0x0000_0004;
    const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x0002_0016;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: Dword = 0x0000_2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const INFINITE: Dword = 0xffff_ffff;
    #[repr(C)]
    struct BasicLimit {
        per_process_time: i64,
        per_job_time: i64,
        limit_flags: Dword,
        min_working_set: usize,
        max_working_set: usize,
        active_processes: Dword,
        affinity: usize,
        priority: Dword,
        scheduling: Dword,
    }
    #[repr(C)]
    struct IoCounters {
        read_ops: u64,
        write_ops: u64,
        other_ops: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }
    #[repr(C)]
    struct JobLimit {
        basic: BasicLimit,
        io: IoCounters,
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }
    fn wide(s: &OsStr) -> io::Result<Vec<u16>> {
        let mut out: Vec<u16> = s.encode_wide().collect();
        if out.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "NUL in process argument",
            ));
        }
        out.push(0);
        Ok(out)
    }
    fn last_error() -> io::Error {
        io::Error::last_os_error()
    }
    fn quote_arg(arg: &[u16], out: &mut Vec<u16>) {
        let needs_quotes = arg.is_empty() || arg.iter().any(|c| *c == 32 || *c == 9 || *c == 34);
        if !needs_quotes {
            out.extend_from_slice(arg);
            return;
        }
        out.push(34);
        let mut slashes = 0;
        for &ch in arg {
            if ch == 92 {
                slashes += 1;
                continue;
            }
            if ch == 34 {
                out.extend(std::iter::repeat_n(92, slashes * 2 + 1));
                out.push(ch);
                slashes = 0;
            } else {
                out.extend(std::iter::repeat_n(92, slashes));
                slashes = 0;
                out.push(ch);
            }
        }
        out.extend(std::iter::repeat_n(92, slashes * 2));
        out.push(34);
    }
    struct AttrList(Vec<usize>);
    impl Drop for AttrList {
        fn drop(&mut self) {
            unsafe {
                DeleteProcThreadAttributeList(self.0.as_mut_ptr().cast());
            }
        }
    }
    pub struct Process {
        input: Handle,
        output: Handle,
        console: Hpc,
        process: Handle,
        job: Handle,
        pid: u32,
        exit: Option<ExitStatus>,
    }
    impl Process {
        pub fn spawn(spec: TerminalLaunchSpec) -> io::Result<Self> {
            let app = wide(spec.executable.as_os_str())?;
            let cwd = wide(spec.cwd.as_os_str())?;
            let mut argv = Vec::with_capacity(spec.argv.len() + 1);
            argv.push(spec.executable.as_os_str().to_os_string());
            argv.extend(spec.argv);
            let mut line = Vec::new();
            for (i, arg) in argv.iter().enumerate() {
                if i != 0 {
                    line.push(32);
                }
                let w = wide(arg)?;
                quote_arg(&w[..w.len() - 1], &mut line);
            }
            line.push(0);
            let mut env_entries = Vec::new();
            for (k, v) in &spec.env {
                let mut e = wide(k.as_os_str())?;
                e.pop();
                if e.contains(&61) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "environment key contains '='",
                    ));
                }
                let mut val = wide(v.as_os_str())?;
                val.pop();
                e.extend([61]);
                e.extend(val);
                env_entries.push(e);
            }
            env_entries.sort_by(|a, b| {
                a.iter()
                    .map(|c| c.to_ascii_lowercase())
                    .cmp(b.iter().map(|c| c.to_ascii_lowercase()))
            });
            let mut env: Vec<u16> = env_entries
                .into_iter()
                .flatten()
                .chain(std::iter::once(0))
                .collect();
            if env.len() == 1 {
                env.push(0);
            }
            let mut sa = SecurityAttributes {
                length: size_of::<SecurityAttributes>() as u32,
                descriptor: null_mut(),
                inherit: 1,
            };
            let (mut input_read, mut input_write, mut output_read, mut output_write) =
                (null_mut(), null_mut(), null_mut(), null_mut());
            unsafe {
                if CreatePipe(&mut input_read, &mut input_write, &sa, 0) == 0 {
                    return Err(last_error());
                }
                if CreatePipe(&mut output_read, &mut output_write, &sa, 0) == 0 {
                    CloseHandle(input_read);
                    CloseHandle(input_write);
                    return Err(last_error());
                }
                if SetHandleInformation(input_write, HANDLE_FLAG_INHERIT, 0) == 0
                    || SetHandleInformation(output_read, HANDLE_FLAG_INHERIT, 0) == 0
                {
                    let error = last_error();
                    CloseHandle(input_read);
                    CloseHandle(input_write);
                    CloseHandle(output_read);
                    CloseHandle(output_write);
                    return Err(error);
                }
            }
            let mut console = null_mut();
            let hr = unsafe {
                CreatePseudoConsole(
                    Coord {
                        x: spec.cols as i16,
                        y: spec.rows as i16,
                    },
                    input_read,
                    output_write,
                    0,
                    &mut console,
                )
            };
            unsafe {
                CloseHandle(input_read);
                CloseHandle(output_write);
            }
            if hr < 0 {
                unsafe {
                    CloseHandle(input_write);
                    CloseHandle(output_read);
                }
                return Err(io::Error::from_raw_os_error(hr));
            }
            let mut attr_size = 0;
            unsafe {
                InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attr_size);
            }
            let mut storage = vec![0usize; attr_size.div_ceil(size_of::<usize>())];
            if unsafe {
                InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), 1, 0, &mut attr_size)
            } == 0
            {
                unsafe {
                    ClosePseudoConsole(console);
                    CloseHandle(input_write);
                    CloseHandle(output_read);
                }
                return Err(last_error());
            }
            let attrs = AttrList(storage);
            if unsafe {
                UpdateProcThreadAttribute(
                    attrs.0.as_mut_ptr().cast(),
                    0,
                    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                    console,
                    size_of::<Hpc>(),
                    null_mut(),
                    null_mut(),
                )
            } == 0
            {
                unsafe {
                    ClosePseudoConsole(console);
                    CloseHandle(input_write);
                    CloseHandle(output_read);
                }
                return Err(last_error());
            }
            let mut startup: StartupInfoEx = unsafe { zeroed() };
            startup.startup.cb = size_of::<StartupInfoEx>() as u32;
            startup.attributes = attrs.0.as_ptr().cast();
            let mut pi: ProcessInfo = unsafe { zeroed() };
            let created = unsafe {
                CreateProcessW(
                    app.as_ptr(),
                    line.as_mut_ptr(),
                    null_mut(),
                    null_mut(),
                    0,
                    EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
                    env.as_mut_ptr().cast(),
                    cwd.as_ptr(),
                    (&mut startup as *mut StartupInfoEx).cast(),
                    &mut pi,
                )
            };
            if created == 0 {
                unsafe {
                    ClosePseudoConsole(console);
                    CloseHandle(input_write);
                    CloseHandle(output_read);
                }
                return Err(last_error());
            }
            let job = unsafe { CreateJobObjectW(null_mut(), null()) };
            if job.is_null() {
                unsafe {
                    TerminateProcess(pi.process, 1);
                    WaitForSingleObject(pi.process, INFINITE);
                    CloseHandle(pi.thread);
                    CloseHandle(pi.process);
                    ClosePseudoConsole(console);
                    CloseHandle(input_write);
                    CloseHandle(output_read);
                }
                return Err(last_error());
            }
            let mut limits: JobLimit = unsafe { zeroed() };
            limits.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if unsafe {
                SetInformationJobObject(
                    job,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    &limits as *const _ as *const c_void,
                    size_of::<JobLimit>() as u32,
                )
            } == 0
                || unsafe { AssignProcessToJobObject(job, pi.process) } == 0
            {
                let error = last_error();
                unsafe {
                    TerminateProcess(pi.process, 1);
                    WaitForSingleObject(pi.process, INFINITE);
                    CloseHandle(job);
                    CloseHandle(pi.thread);
                    CloseHandle(pi.process);
                    ClosePseudoConsole(console);
                    CloseHandle(input_write);
                    CloseHandle(output_read);
                }
                return Err(error);
            }
            if unsafe { ResumeThread(pi.thread) } == u32::MAX {
                let error = last_error();
                unsafe {
                    TerminateJobObject(job, 1);
                    WaitForSingleObject(pi.process, INFINITE);
                    CloseHandle(job);
                    CloseHandle(pi.thread);
                    CloseHandle(pi.process);
                    ClosePseudoConsole(console);
                    CloseHandle(input_write);
                    CloseHandle(output_read);
                }
                return Err(error);
            }
            unsafe {
                CloseHandle(pi.thread);
            }
            Ok(Self {
                input: input_write,
                output: output_read,
                console,
                process: pi.process,
                job,
                pid: pi.pid,
                exit: None,
            })
        }
        pub fn pid(&self) -> u32 {
            self.pid
        }
        pub fn backend(&self) -> TerminalBackend {
            TerminalBackend::WindowsConPty
        }
        pub fn guarantees(&self) -> ProcessGuarantees {
            ProcessGuarantees {
                observed_exit: true,
                tree_kill_on_owner_close: true,
                process_tree_termination: true,
            }
        }
        pub fn owner_loss_tree_cleanup_supported() -> bool {
            true
        }
        pub fn read_output(&mut self, max: usize) -> io::Result<Vec<u8>> {
            let mut available = 0;
            if unsafe {
                PeekNamedPipe(
                    self.output,
                    null_mut(),
                    0,
                    null_mut(),
                    &mut available,
                    null_mut(),
                )
            } == 0
            {
                return Err(last_error());
            }
            let count = available.min(max as u32) as usize;
            let mut bytes = vec![0; count];
            if count == 0 {
                return Ok(bytes);
            }
            let mut got = 0;
            if unsafe {
                ReadFile(
                    self.output,
                    bytes.as_mut_ptr().cast(),
                    count as u32,
                    &mut got,
                    null_mut(),
                )
            } == 0
            {
                return Err(last_error());
            }
            bytes.truncate(got as usize);
            Ok(bytes)
        }
        pub fn write_input(&mut self, bytes: &[u8]) -> io::Result<()> {
            if bytes.is_empty() {
                return Ok(());
            }
            let mut n = 0;
            if unsafe {
                WriteFile(
                    self.input,
                    bytes.as_ptr().cast(),
                    bytes.len() as u32,
                    &mut n,
                    null_mut(),
                )
            } == 0
            {
                return Err(last_error());
            }
            if n as usize != bytes.len() {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "partial terminal input write",
                ));
            }
            Ok(())
        }
        pub fn resize(&mut self, cols: u16, rows: u16) -> io::Result<()> {
            let hr = unsafe {
                ResizePseudoConsole(
                    self.console,
                    Coord {
                        x: cols as i16,
                        y: rows as i16,
                    },
                )
            };
            if hr < 0 {
                Err(io::Error::from_raw_os_error(hr))
            } else {
                Ok(())
            }
        }
        pub fn request_terminate(&mut self, _reason: TerminationReason) -> io::Result<()> {
            if unsafe { TerminateJobObject(self.job, 1) } == 0 {
                let e = last_error();
                if self.try_wait()?.is_some() {
                    Ok(())
                } else {
                    Err(e)
                }
            } else {
                Ok(())
            }
        }
        pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            if let Some(s) = self.exit {
                return Ok(Some(s));
            }
            match unsafe { WaitForSingleObject(self.process, 0) } {
                0 => {
                    let mut code = 0;
                    if unsafe { GetExitCodeProcess(self.process, &mut code) } == 0 {
                        return Err(last_error());
                    }
                    self.exit = Some(ExitStatus::from_raw(code as i32));
                    Ok(self.exit)
                }
                0x102 => Ok(None),
                _ => Err(last_error()),
            }
        }
    }
    impl Drop for Process {
        fn drop(&mut self) {
            if self.request_terminate(TerminationReason::OwnerLost).is_ok() {
                // Job termination is asynchronous; wait for the leader before releasing
                // PTY resources, and observe its status rather than inferring exit from close.
                unsafe {
                    WaitForSingleObject(self.process, INFINITE);
                }
                let _ = self.try_wait();
            }
            // Closing the pseudoconsole can enqueue a final frame; keep the output
            // pipe alive and drain it before closing the inherited pipe handle.
            unsafe {
                ClosePseudoConsole(self.console);
            }
            self.console = null_mut();
            loop {
                let mut available = 0;
                if unsafe {
                    PeekNamedPipe(
                        self.output,
                        null_mut(),
                        0,
                        null_mut(),
                        &mut available,
                        null_mut(),
                    )
                } == 0
                    || available == 0
                {
                    break;
                }
                let mut buffer = [0_u8; 4096];
                let mut read = 0;
                if unsafe {
                    ReadFile(
                        self.output,
                        buffer.as_mut_ptr().cast(),
                        available.min(buffer.len() as u32),
                        &mut read,
                        null_mut(),
                    )
                } == 0
                    || read == 0
                {
                    break;
                }
            }
            unsafe {
                CloseHandle(self.input);
                CloseHandle(self.output);
                CloseHandle(self.process);
                CloseHandle(self.job);
            }
        }
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
mod platform {
    use super::*;
    pub struct Process;
    impl Process {
        pub fn spawn(_: TerminalLaunchSpec) -> io::Result<Self> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "terminal process backend unavailable on this target",
            ))
        }
        pub fn pid(&self) -> u32 {
            0
        }
        pub fn backend(&self) -> TerminalBackend {
            TerminalBackend::Unavailable
        }
        pub fn guarantees(&self) -> ProcessGuarantees {
            ProcessGuarantees {
                observed_exit: false,
                tree_kill_on_owner_close: false,
                process_tree_termination: false,
            }
        }
        pub fn owner_loss_tree_cleanup_supported() -> bool {
            false
        }
        pub fn read_output(&mut self, _: usize) -> io::Result<Vec<u8>> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "terminal process backend unavailable",
            ))
        }
        pub fn write_input(&mut self, _: &[u8]) -> io::Result<()> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "terminal process backend unavailable",
            ))
        }
        pub fn resize(&mut self, _: u16, _: u16) -> io::Result<()> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "terminal process backend unavailable",
            ))
        }
        pub fn request_terminate(&mut self, _: TerminationReason) -> io::Result<()> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "terminal process backend unavailable",
            ))
        }
        pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "terminal process backend unavailable",
            ))
        }
    }
}
#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::thread;

    fn launch(command: &str) -> TerminalLaunchSpec {
        TerminalLaunchSpec {
            executable: PathBuf::from("/bin/sh"),
            argv: vec![OsString::from("-c"), OsString::from(command)],
            cwd: std::env::current_dir().expect("current directory"),
            env: BTreeMap::new(),
            cols: 80,
            rows: 24,
        }
    }

    #[test]
    fn output_reads_obey_the_requested_bound() {
        let mut process =
            TerminalProcess::spawn(launch("printf 'terminal-output'")).expect("spawn shell");
        let mut output = Vec::new();
        for _ in 0..100 {
            let chunk = process.read_output(4).expect("read output");
            assert!(chunk.len() <= 4);
            output.extend(chunk);
            if output.len() == b"terminal-output".len() {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(2));
        }
        assert_eq!(output, b"terminal-output");
    }

    #[test]
    fn dropping_process_reaps_the_pty_leader() {
        let process = TerminalProcess::spawn(launch("sleep 30")).expect("spawn shell");
        let pid = process.pid() as libc::pid_t;
        drop(process);
        // The Drop path sends SIGKILL to the PTY process group and waits for its leader.
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
    }
}
