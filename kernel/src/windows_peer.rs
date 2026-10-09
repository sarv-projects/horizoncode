//! Windows same-logon named-pipe adapter with process-bound peer authentication.
//!
//! A pipe is returned only after the connected endpoint matches a process identity
//! captured from a supervisor-owned process handle. The identity includes PID, process
//! creation time, user SID, and an executable-path policy. The returned object owns the
//! exact pipe handle and authenticated process handle; a PID or `KernelHelloV1` nonce
//! alone is not authentication. The caller must still negotiate the hello on this pipe.
//!
//! This adapter is a bounded local-attach primitive, not process supervision. The DACL
//! permits the current logon SID, so another process in that logon session can still
//! occupy the single pipe and cause authentication to fail; the supervisor must rotate
//! the name and apply bounded retry policy. The listener blocks until a client connects;
//! it has no cancellation path and has not received native Windows runtime review.

const MAX_WINDOWS_IMAGE_PATH_CHARS: usize = 32 * 1024;

/// Require exact path spelling so case-sensitive Windows directories cannot make a
/// case-insensitive executable-policy comparison identify a different image.
fn same_windows_path_units(left: &[u16], right: &[u16]) -> bool {
    !left.is_empty()
        && !right.is_empty()
        && left.len() <= MAX_WINDOWS_IMAGE_PATH_CHARS
        && right.len() <= MAX_WINDOWS_IMAGE_PATH_CHARS
        && left == right
}

#[cfg(test)]
mod portable_tests {
    use super::*;

    #[test]
    fn executable_path_policy_requires_exact_bounded_spelling() {
        let expected: Vec<u16> = r"C:\Program Files\Horizon\Kernel.exe"
            .encode_utf16()
            .collect();
        let same_spelling: Vec<u16> = r"C:\Program Files\Horizon\Kernel.exe"
            .encode_utf16()
            .collect();
        let different_case: Vec<u16> = r"C:\Program Files\Horizon\kernel.exe"
            .encode_utf16()
            .collect();

        assert!(same_windows_path_units(&expected, &same_spelling));
        assert!(!same_windows_path_units(&expected, &different_case));
        assert!(!same_windows_path_units(&[], &same_spelling));
        assert!(!same_windows_path_units(
            &vec![b'a' as u16; MAX_WINDOWS_IMAGE_PATH_CHARS + 1],
            &vec![b'a' as u16; MAX_WINDOWS_IMAGE_PATH_CHARS + 1]
        ));
    }
}

use std::ffi::{OsStr, OsString, c_void};
use std::fmt;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::path::{Path, PathBuf};
use std::ptr;

use windows_sys::Win32::Foundation::{
    ERROR_PIPE_CONNECTED, FILETIME, GENERIC_READ, GENERIC_WRITE, GetLastError,
    INVALID_HANDLE_VALUE, LocalFree, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
};
use windows_sys::Win32::Security::Cryptography::{
    BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, SECURITY_ATTRIBUTES, SID_AND_ATTRIBUTES, TOKEN_GROUPS, TOKEN_QUERY,
    TOKEN_USER, TokenLogonSid, TokenSessionId, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ACCESS_RIGHTS, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_FIRST_PIPE_INSTANCE,
    FILE_GENERIC_READ, FILE_GENERIC_WRITE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX, SYNCHRONIZE,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, GetNamedPipeServerProcessId,
    PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetProcessId, GetProcessTimes, OpenProcess, OpenProcessToken,
    PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW, WaitForSingleObject,
};

const PIPE_BUFFER_BYTES: u32 = 64 * 1024;
const TOKEN_BUFFER_LIMIT: usize = 64 * 1024;
const PROCESS_IMAGE_BUFFER_CHARS: usize = MAX_WINDOWS_IMAGE_PATH_CHARS;
const SECURITY_DESCRIPTOR_REVISION: u32 = 1;
// FILE_GENERIC_READ | FILE_GENERIC_WRITE | SYNCHRONIZE. Generic write includes
// FILE_CREATE_PIPE_INSTANCE (0x4), required to create a pipe instance. The DACL grants
// this only to the current logon SID; nMaxInstances is fixed to one.
const PIPE_DACL_ACCESS: FILE_ACCESS_RIGHTS = FILE_GENERIC_READ | FILE_GENERIC_WRITE | SYNCHRONIZE;
const PIPE_PREFIX: &str = r"\\.\pipe\horizoncode-";
const SE_GROUP_LOGON_ID: u32 = 0xC000_0000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowsPeerErrorKind {
    RandomSourceFailed,
    InvalidExpectedImage,
    InvalidTokenData,
    DifferentSecurityContext,
    MissingExpectedPeer,
    PeerMismatch,
    OsCallFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WindowsPeerError {
    pub kind: WindowsPeerErrorKind,
    pub operation: &'static str,
    pub os_code: Option<u32>,
}

impl fmt::Display for WindowsPeerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.os_code {
            Some(code) => write!(
                formatter,
                "Windows peer authentication {:?} failed during {} (code {code})",
                self.kind, self.operation
            ),
            None => write!(
                formatter,
                "Windows peer authentication {:?} failed during {}",
                self.kind, self.operation
            ),
        }
    }
}

impl std::error::Error for WindowsPeerError {}

fn failed(operation: &'static str) -> WindowsPeerError {
    WindowsPeerError {
        kind: WindowsPeerErrorKind::OsCallFailed,
        operation,
        os_code: Some(unsafe { GetLastError() }),
    }
}

fn mismatch(operation: &'static str) -> WindowsPeerError {
    WindowsPeerError {
        kind: WindowsPeerErrorKind::PeerMismatch,
        operation,
        os_code: None,
    }
}

/// An unpredictable local endpoint name generated with the Windows system RNG.
/// Its debug representation intentionally omits the name.
#[derive(Clone, PartialEq, Eq)]
pub struct PrivatePipeName(String);

impl PrivatePipeName {
    pub fn generate() -> Result<Self, WindowsPeerError> {
        let mut random = [0_u8; 16];
        let status = unsafe {
            BCryptGenRandom(
                ptr::null_mut(),
                random.as_mut_ptr(),
                random.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status < 0 {
            return Err(WindowsPeerError {
                kind: WindowsPeerErrorKind::RandomSourceFailed,
                operation: "BCryptGenRandom",
                os_code: Some(status as u32),
            });
        }
        let mut suffix = String::with_capacity(random.len() * 2);
        for byte in random {
            use fmt::Write as _;
            write!(&mut suffix, "{byte:02x}").expect("writing to String cannot fail");
        }
        Ok(Self(format!("{PIPE_PREFIX}{suffix}")))
    }

    /// Return the generated endpoint only to the trusted process-launch path that must
    /// pass it to the intended child. Do not log it or accept it from an RPC caller.
    pub fn for_trusted_child_launch(&self) -> &OsStr {
        OsStr::new(&self.0)
    }

    fn wide(&self) -> Vec<u16> {
        OsStr::new(&self.0).encode_wide().chain(Some(0)).collect()
    }
}

impl fmt::Debug for PrivatePipeName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PrivatePipeName([redacted])")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowsPeerIdentity {
    process_id: u32,
    creation_time_100ns: u64,
    user_sid: String,
    session_id: u32,
    logon_sid: String,
    image_path: PathBuf,
}

impl WindowsPeerIdentity {
    pub const fn process_id(&self) -> u32 {
        self.process_id
    }

    pub const fn creation_time_100ns(&self) -> u64 {
        self.creation_time_100ns
    }

    pub fn user_sid(&self) -> &str {
        &self.user_sid
    }

    pub const fn session_id(&self) -> u32 {
        self.session_id
    }

    pub fn logon_sid(&self) -> &str {
        &self.logon_sid
    }

    pub fn image_path(&self) -> &Path {
        &self.image_path
    }
}

/// Identity snapshot from a process handle owned by the trusted supervisor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExpectedWindowsPeer(WindowsPeerIdentity);

impl ExpectedWindowsPeer {
    /// Capture the process instance behind a supervisor-owned process handle.
    /// `expected_image_path` must come from trusted executable policy, not RPC input;
    /// its UTF-16 spelling must exactly match the process image path.
    pub fn from_process_handle(
        process: BorrowedHandle<'_>,
        expected_image_path: &Path,
    ) -> Result<Self, WindowsPeerError> {
        if !expected_image_path.is_absolute() {
            return Err(WindowsPeerError {
                kind: WindowsPeerErrorKind::InvalidExpectedImage,
                operation: "validate expected executable path",
                os_code: None,
            });
        }
        let identity = read_process_identity(process.as_raw_handle() as _)?;
        if !same_windows_path(&identity.image_path, expected_image_path) {
            return Err(mismatch("expected executable path"));
        }
        Ok(Self(identity))
    }

    pub fn identity(&self) -> &WindowsPeerIdentity {
        &self.0
    }
}

/// A connected pipe that owns both the transport and authenticated process handle.
/// Fields are private so external callers cannot manufacture authentication evidence.
pub struct AuthenticatedNamedPipe {
    file: File,
    peer_process: OwnedHandle,
    peer: WindowsPeerIdentity,
}

/// A created, first-instance named-pipe listener. Bind before launching the intended
/// child so it cannot race pipe creation. `accept` is blocking and consumes the listener.
pub struct PrivatePipeListener {
    file: File,
    logon_sid: String,
    expected_client: Option<ExpectedWindowsPeer>,
}

impl AuthenticatedNamedPipe {
    pub fn peer(&self) -> &WindowsPeerIdentity {
        &self.peer
    }

    fn ensure_peer_alive(&self) -> io::Result<()> {
        match unsafe { WaitForSingleObject(self.peer_process.as_raw_handle() as _, 0) } {
            WAIT_TIMEOUT => Ok(()),
            WAIT_OBJECT_0 => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "authenticated pipe peer exited",
            )),
            WAIT_FAILED => Err(io::Error::last_os_error()),
            _ => Err(io::Error::other("unexpected process wait result")),
        }
    }
}

impl Read for AuthenticatedNamedPipe {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.ensure_peer_alive()?;
        self.file.read(buffer)
    }
}

impl Write for AuthenticatedNamedPipe {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.ensure_peer_alive()?;
        self.file.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.ensure_peer_alive()?;
        self.file.flush()
    }
}

struct LocalAllocation(*mut c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0 as _);
            }
        }
    }
}

/// Create a first-instance same-logon named pipe with an explicit protected DACL and
/// reject remote clients. Bind before launching the intended child, then call
/// [`PrivatePipeListener::expect_client`] with its supervisor-owned process handle.
pub fn bind_private_pipe(name: &PrivatePipeName) -> Result<PrivatePipeListener, WindowsPeerError> {
    let (_, _, logon_sid) = current_token_identity()?;
    let descriptor = security_descriptor(&logon_sid)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let raw_pipe = unsafe {
        CreateNamedPipeW(
            name.wide().as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            PIPE_BUFFER_BYTES,
            PIPE_BUFFER_BYTES,
            0,
            &attributes,
        )
    };
    if raw_pipe == INVALID_HANDLE_VALUE || raw_pipe.is_null() {
        return Err(failed("CreateNamedPipeW"));
    }
    Ok(PrivatePipeListener {
        file: unsafe { File::from_raw_handle(raw_pipe as RawHandle) },
        logon_sid,
        expected_client: None,
    })
}

impl PrivatePipeListener {
    /// Bind this listener to the exact process launched by the trusted supervisor.
    /// This is one-shot and must happen before `accept`.
    pub fn expect_client(
        &mut self,
        expected_client: &ExpectedWindowsPeer,
    ) -> Result<(), WindowsPeerError> {
        require_current_logon(&expected_client.0)?;
        if self.expected_client.is_some() || self.logon_sid != expected_client.0.logon_sid {
            return Err(mismatch("bind expected client to named-pipe listener"));
        }
        self.expected_client = Some(expected_client.clone());
        Ok(())
    }

    /// Wait for one connection, authenticate the peer, then return the bound byte stream.
    pub fn accept(self) -> Result<AuthenticatedNamedPipe, WindowsPeerError> {
        let Self {
            file,
            expected_client,
            ..
        } = self;
        let Some(expected_client) = expected_client else {
            return Err(WindowsPeerError {
                kind: WindowsPeerErrorKind::MissingExpectedPeer,
                operation: "accept without a supervisor-bound client process",
                os_code: None,
            });
        };
        let connected = unsafe { ConnectNamedPipe(file.as_raw_handle() as _, ptr::null_mut()) };
        if connected == 0 && unsafe { GetLastError() } != ERROR_PIPE_CONNECTED {
            return Err(failed("ConnectNamedPipe"));
        }
        authenticate_pipe(file, &expected_client, true)
    }
}

/// Connect to a named pipe and authenticate its server against a trusted process handle.
pub fn connect_private_pipe(
    name: &PrivatePipeName,
    expected_server: &ExpectedWindowsPeer,
) -> Result<AuthenticatedNamedPipe, WindowsPeerError> {
    require_current_logon(&expected_server.0)?;
    let raw_pipe = unsafe {
        CreateFileW(
            name.wide().as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            ptr::null_mut(),
        )
    };
    if raw_pipe == INVALID_HANDLE_VALUE || raw_pipe.is_null() {
        return Err(failed("CreateFileW(named pipe)"));
    }
    let file = unsafe { File::from_raw_handle(raw_pipe as RawHandle) };
    authenticate_pipe(file, expected_server, false)
}

fn authenticate_pipe(
    file: File,
    expected: &ExpectedWindowsPeer,
    server_side: bool,
) -> Result<AuthenticatedNamedPipe, WindowsPeerError> {
    let pipe = file.as_raw_handle() as _;
    let mut process_id = 0;
    let got_process_id = unsafe {
        if server_side {
            GetNamedPipeClientProcessId(pipe, &mut process_id)
        } else {
            GetNamedPipeServerProcessId(pipe, &mut process_id)
        }
    };
    if got_process_id == 0 {
        return Err(failed(if server_side {
            "GetNamedPipeClientProcessId"
        } else {
            "GetNamedPipeServerProcessId"
        }));
    }
    if process_id != expected.0.process_id {
        return Err(mismatch("pipe endpoint process ID"));
    }

    let raw_process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
            0,
            process_id,
        )
    };
    if raw_process.is_null() {
        return Err(failed("OpenProcess"));
    }
    let peer_process = unsafe { OwnedHandle::from_raw_handle(raw_process as RawHandle) };
    let actual = read_process_identity(peer_process.as_raw_handle() as _)?;
    if !same_process_identity(&actual, &expected.0) {
        return Err(mismatch("pipe peer process/token/image identity"));
    }

    Ok(AuthenticatedNamedPipe {
        file,
        peer_process,
        peer: actual,
    })
}

fn require_current_logon(expected: &WindowsPeerIdentity) -> Result<(), WindowsPeerError> {
    let current = current_token_identity()?;
    if current.0 != expected.user_sid
        || current.1 != expected.session_id
        || current.2 != expected.logon_sid
    {
        return Err(WindowsPeerError {
            kind: WindowsPeerErrorKind::DifferentSecurityContext,
            operation: "require same-user same-session logon attachment",
            os_code: None,
        });
    }
    Ok(())
}

fn read_process_identity(
    process: windows_sys::Win32::Foundation::HANDLE,
) -> Result<WindowsPeerIdentity, WindowsPeerError> {
    let process_id = unsafe { GetProcessId(process) };
    if process_id == 0 {
        return Err(failed("GetProcessId"));
    }

    let mut creation_time = FILETIME::default();
    let mut exit_time = FILETIME::default();
    let mut kernel_time = FILETIME::default();
    let mut user_time = FILETIME::default();
    if unsafe {
        GetProcessTimes(
            process,
            &mut creation_time,
            &mut exit_time,
            &mut kernel_time,
            &mut user_time,
        )
    } == 0
    {
        return Err(failed("GetProcessTimes"));
    }
    let creation_time_100ns =
        (u64::from(creation_time.dwHighDateTime) << 32) | u64::from(creation_time.dwLowDateTime);

    let (user_sid, session_id, logon_sid) = query_token_identity(process)?;
    Ok(WindowsPeerIdentity {
        process_id,
        creation_time_100ns,
        user_sid,
        session_id,
        logon_sid,
        image_path: query_image_path(process)?,
    })
}

fn query_image_path(
    process: windows_sys::Win32::Foundation::HANDLE,
) -> Result<PathBuf, WindowsPeerError> {
    let mut buffer = vec![0_u16; PROCESS_IMAGE_BUFFER_CHARS];
    let mut length = buffer.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) } == 0 {
        return Err(failed("QueryFullProcessImageNameW"));
    }
    if length == 0 || length as usize > buffer.len() {
        return Err(WindowsPeerError {
            kind: WindowsPeerErrorKind::InvalidTokenData,
            operation: "validate process image path length",
            os_code: None,
        });
    }
    Ok(PathBuf::from(OsString::from_wide(
        &buffer[..length as usize],
    )))
}

fn current_token_identity() -> Result<(String, u32, String), WindowsPeerError> {
    let process = unsafe { GetCurrentProcess() };
    query_token_identity(process)
}

fn query_token_identity(
    process: windows_sys::Win32::Foundation::HANDLE,
) -> Result<(String, u32, String), WindowsPeerError> {
    let mut token = ptr::null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(failed("OpenProcessToken"));
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token as RawHandle) };

    let mut session_id = 0_u32;
    let mut returned_bytes = 0_u32;
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle() as _,
            TokenSessionId,
            (&mut session_id as *mut u32).cast(),
            std::mem::size_of::<u32>() as u32,
            &mut returned_bytes,
        )
    } == 0
    {
        return Err(failed("GetTokenInformation(TokenSessionId)"));
    }
    if returned_bytes != std::mem::size_of::<u32>() as u32 {
        return Err(WindowsPeerError {
            kind: WindowsPeerErrorKind::InvalidTokenData,
            operation: "validate token session ID length",
            os_code: None,
        });
    }

    let (user_storage, user_bytes) = token_information(token.as_raw_handle() as _, TokenUser)?;
    if user_bytes < std::mem::size_of::<TOKEN_USER>() {
        return Err(invalid_token("validate token user information length"));
    }
    let token_user = unsafe { &*user_storage.as_ptr().cast::<TOKEN_USER>() };
    let user_sid = sid_to_string(token_user.User.Sid, "convert token user SID")?;

    let (logon_storage, logon_bytes) =
        token_information(token.as_raw_handle() as _, TokenLogonSid)?;
    let groups_offset = std::mem::offset_of!(TOKEN_GROUPS, Groups);
    if logon_bytes < groups_offset {
        return Err(invalid_token("validate token logon SID information length"));
    }
    let groups = unsafe { &*logon_storage.as_ptr().cast::<TOKEN_GROUPS>() };
    let group_count = groups.GroupCount as usize;
    let Some(groups_size) = group_count.checked_mul(std::mem::size_of::<SID_AND_ATTRIBUTES>())
    else {
        return Err(invalid_token("bound token logon SID count"));
    };
    let Some(required_bytes) = groups_offset.checked_add(groups_size) else {
        return Err(invalid_token("bound token logon SID buffer size"));
    };
    if group_count == 0 || required_bytes > logon_bytes {
        return Err(invalid_token("validate token logon SID group count"));
    }
    let groups = unsafe {
        std::slice::from_raw_parts(
            std::ptr::addr_of!(groups.Groups).cast::<SID_AND_ATTRIBUTES>(),
            group_count,
        )
    };
    let mut logon_sid = None;
    for group in groups {
        if group.Attributes & SE_GROUP_LOGON_ID == SE_GROUP_LOGON_ID {
            if logon_sid.is_some() {
                return Err(invalid_token("require exactly one token logon SID"));
            }
            logon_sid = Some(sid_to_string(group.Sid, "convert token logon SID")?);
        }
    }
    let Some(logon_sid) = logon_sid else {
        return Err(invalid_token("require one token logon SID"));
    };
    Ok((user_sid, session_id, logon_sid))
}

fn token_information(
    token: windows_sys::Win32::Foundation::HANDLE,
    information_class: windows_sys::Win32::Security::TOKEN_INFORMATION_CLASS,
) -> Result<(Vec<usize>, usize), WindowsPeerError> {
    let mut required_bytes = 0;
    unsafe {
        GetTokenInformation(
            token,
            information_class,
            ptr::null_mut(),
            0,
            &mut required_bytes,
        );
    }
    if required_bytes == 0 || required_bytes as usize > TOKEN_BUFFER_LIMIT {
        return Err(invalid_token("bound token information size"));
    }
    let word_count = (required_bytes as usize).div_ceil(std::mem::size_of::<usize>());
    let mut storage = vec![0_usize; word_count];
    let mut returned_bytes = 0;
    if unsafe {
        GetTokenInformation(
            token,
            information_class,
            storage.as_mut_ptr().cast(),
            required_bytes,
            &mut returned_bytes,
        )
    } == 0
    {
        return Err(failed("GetTokenInformation"));
    }
    if returned_bytes == 0 || returned_bytes as usize > storage.len() * std::mem::size_of::<usize>()
    {
        return Err(invalid_token("validate returned token information length"));
    }
    Ok((storage, returned_bytes as usize))
}

fn sid_to_string(sid: *mut c_void, operation: &'static str) -> Result<String, WindowsPeerError> {
    if sid.is_null() {
        return Err(invalid_token("read token SID"));
    }
    let mut sid_string = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut sid_string) } == 0 {
        return Err(failed("ConvertSidToStringSidW"));
    }
    let sid_allocation = LocalAllocation(sid_string.cast());
    let mut length = 0_usize;
    loop {
        if length > 256 {
            return Err(invalid_token("bound token SID string"));
        }
        if unsafe { *sid_string.add(length) } == 0 {
            break;
        }
        length += 1;
    }
    let Ok(value) = String::from_utf16(unsafe { std::slice::from_raw_parts(sid_string, length) })
    else {
        return Err(invalid_token(operation));
    };
    drop(sid_allocation);
    Ok(value)
}

fn invalid_token(operation: &'static str) -> WindowsPeerError {
    WindowsPeerError {
        kind: WindowsPeerErrorKind::InvalidTokenData,
        operation,
        os_code: None,
    }
}

fn security_descriptor(logon_sid: &str) -> Result<LocalAllocation, WindowsPeerError> {
    let sddl = wide(&format!("D:P(A;;0x{PIPE_DACL_ACCESS:08X};;;{logon_sid})"));
    let mut descriptor = ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SECURITY_DESCRIPTOR_REVISION,
            &mut descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(failed(
            "ConvertStringSecurityDescriptorToSecurityDescriptorW",
        ));
    }
    Ok(LocalAllocation(descriptor))
}

fn same_process_identity(left: &WindowsPeerIdentity, right: &WindowsPeerIdentity) -> bool {
    left.process_id == right.process_id
        && left.creation_time_100ns == right.creation_time_100ns
        && left.user_sid == right.user_sid
        && left.session_id == right.session_id
        && left.logon_sid == right.logon_sid
        && same_windows_path(&left.image_path, &right.image_path)
}

fn same_windows_path(left: &Path, right: &Path) -> bool {
    fn path_units(path: &Path) -> Option<Vec<u16>> {
        let mut units = Vec::new();
        for unit in path.as_os_str().encode_wide() {
            if units.len() == MAX_WINDOWS_IMAGE_PATH_CHARS {
                return None;
            }
            units.push(unit);
        }
        Some(units)
    }

    let Some(left) = path_units(left) else {
        return false;
    };
    let Some(right) = path_units(right) else {
        return false;
    };
    same_windows_path_units(&left, &right)
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use windows_sys::Win32::Storage::FileSystem::FILE_CREATE_PIPE_INSTANCE;

    fn current_peer() -> ExpectedWindowsPeer {
        let process = unsafe { GetCurrentProcess() };
        let borrowed = unsafe { BorrowedHandle::borrow_raw(process as RawHandle) };
        let image = query_image_path(process).unwrap();
        ExpectedWindowsPeer::from_process_handle(borrowed, &image).unwrap()
    }

    #[test]
    fn generated_pipe_name_is_redacted_and_distinct() {
        let first = PrivatePipeName::generate().unwrap();
        let second = PrivatePipeName::generate().unwrap();
        let value = first.for_trusted_child_launch().to_string_lossy();
        assert_ne!(first, second);
        assert_eq!(format!("{first:?}"), "PrivatePipeName([redacted])");
        let suffix = value.strip_prefix(PIPE_PREFIX).unwrap();
        assert_eq!(suffix.len(), 32);
        assert!(suffix.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(PIPE_DACL_ACCESS & FILE_CREATE_PIPE_INSTANCE, 0);
    }

    #[test]
    fn process_identity_includes_incarnation_and_token_scope() {
        let expected = current_peer().0;
        let mut changed = expected.clone();
        changed.creation_time_100ns += 1;
        assert!(!same_process_identity(&changed, &expected));

        let mut changed = expected.clone();
        changed.logon_sid.push_str("-different");
        assert!(!same_process_identity(&changed, &expected));

        let mut changed = expected.clone();
        changed.image_path = PathBuf::from(r"C:\different.exe");
        assert!(!same_process_identity(&changed, &expected));
    }

    #[test]
    fn path_policy_comparison_requires_exact_spelling() {
        assert!(same_windows_path(
            Path::new(r"C:\Program Files\Horizon\Kernel.exe"),
            Path::new(r"C:\Program Files\Horizon\Kernel.exe")
        ));
        assert!(!same_windows_path(
            Path::new(r"C:\Program Files\Horizon\Kernel.exe"),
            Path::new(r"C:\Program Files\Horizon\kernel.exe")
        ));
    }

    #[test]
    fn trusted_process_handle_must_match_executable_policy() {
        let process = unsafe { GetCurrentProcess() };
        let borrowed = unsafe { BorrowedHandle::borrow_raw(process as RawHandle) };
        assert!(matches!(
            ExpectedWindowsPeer::from_process_handle(
                borrowed,
                Path::new(r"C:\not-the-current-image.exe")
            ),
            Err(WindowsPeerError {
                kind: WindowsPeerErrorKind::PeerMismatch,
                ..
            })
        ));
    }

    #[test]
    fn pipe_stream_is_returned_only_for_the_expected_process() {
        let name = PrivatePipeName::generate().unwrap();
        let peer = current_peer();
        let mut listener = bind_private_pipe(&name).unwrap();
        listener.expect_client(&peer).unwrap();
        let server_peer = peer.clone();
        let server = thread::spawn(move || {
            let mut pipe = listener.accept().unwrap();
            let mut request = [0; 4];
            pipe.read_exact(&mut request).unwrap();
            assert_eq!(&request, b"ping");
            pipe.write_all(b"pong").unwrap();
            assert_eq!(pipe.peer().process_id(), server_peer.0.process_id);
        });

        let mut client = connect_private_pipe(&name, &peer).unwrap();
        client.write_all(b"ping").unwrap();
        let mut response = [0; 4];
        client.read_exact(&mut response).unwrap();
        assert_eq!(&response, b"pong");
        assert_eq!(client.peer().process_id(), peer.0.process_id);
        server.join().unwrap();
    }

    #[test]
    fn listener_cannot_accept_until_bound_to_an_expected_process() {
        let name = PrivatePipeName::generate().unwrap();
        let listener = bind_private_pipe(&name).unwrap();
        assert!(matches!(
            listener.accept(),
            Err(WindowsPeerError {
                kind: WindowsPeerErrorKind::MissingExpectedPeer,
                ..
            })
        ));
    }
}
