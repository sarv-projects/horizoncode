//! Raw-syscall Landlock support (no external Landlock crate).
//!
//! Only what HorizonCode V1 needs is implemented: the ABI version probe and an
//! allowlist write-scoping ruleset applied to one forked child before `exec`.
//! Reads, execute and everything else stay unhandled, which Landlock treats as
//! allowed; only the write-class rights listed below are restricted.
//!
//! Everything here runs either in the parent (ABI probe) or in the forked
//! child inside `Command::pre_exec`, where only raw syscalls are permitted.

use std::io;

const LANDLOCK_CREATE_RULESET_VERSION: u32 = 1;
const LANDLOCK_RULE_PATH_BENEATH: u32 = 1;

// `include/uapi/linux/landlock.h` access-right bits.
const ACCESS_FS_WRITE_FILE: u64 = 1 << 1;
const ACCESS_FS_REMOVE_DIR: u64 = 1 << 4;
const ACCESS_FS_REMOVE_FILE: u64 = 1 << 5;
const ACCESS_FS_MAKE_DIR: u64 = 1 << 7;
const ACCESS_FS_MAKE_REG: u64 = 1 << 8;
const ACCESS_FS_MAKE_SOCK: u64 = 1 << 9;
const ACCESS_FS_MAKE_FIFO: u64 = 1 << 10;
const ACCESS_FS_MAKE_SYM: u64 = 1 << 12;
/// Available since ABI 2 (Linux 5.19).
const ACCESS_FS_REFER: u64 = 1 << 13;
/// Available since ABI 3 (Linux 6.2).
const ACCESS_FS_TRUNCATE: u64 = 1 << 14;
/// Available since ABI 4 (Linux 6.7).
const ACCESS_NET_BIND_TCP: u64 = 1 << 0;
const ACCESS_NET_CONNECT_TCP: u64 = 1 << 1;

/// `struct landlock_ruleset_attr` minus trailing fields the kernel zero-fills.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct RulesetAttr {
    handled_access_fs: u64,
    handled_access_net: u64,
}

/// `struct landlock_path_beneath_attr`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct PathBeneathAttr {
    allowed_access: u64,
    parent_fd: i32,
    reserved: u32,
}

/// Probe the supported Landlock ABI level via the documented version probe.
pub(crate) fn probe_abi() -> Result<u32, String> {
    // SAFETY: the version probe is documented to take a null attribute pointer,
    // zero size and the `LANDLOCK_CREATE_RULESET_VERSION` flag.
    let result = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<RulesetAttr>(),
            0usize,
            u64::from(LANDLOCK_CREATE_RULESET_VERSION),
        )
    };
    if result < 0 {
        let error = io::Error::last_os_error();
        return Err(format!(
            "{error} (errno {})",
            error.raw_os_error().unwrap_or(-1)
        ));
    }
    Ok(result as u32)
}

/// Write-class access rights handled by a write-scoping ruleset for this ABI.
///
/// `MAKE_CHAR`/`MAKE_BLOCK` are deliberately not handled: creating device
/// nodes needs `CAP_MKNOD` (dropped for bubblewrap-confined children and
/// unavailable to unprivileged users), and handling them would also block
/// device-tree setup.
pub(crate) fn write_scope_rights(abi: u32) -> u64 {
    let mut rights = ACCESS_FS_WRITE_FILE
        | ACCESS_FS_REMOVE_DIR
        | ACCESS_FS_REMOVE_FILE
        | ACCESS_FS_MAKE_DIR
        | ACCESS_FS_MAKE_REG
        | ACCESS_FS_MAKE_SOCK
        | ACCESS_FS_MAKE_FIFO
        | ACCESS_FS_MAKE_SYM;
    if abi >= 2 {
        rights |= ACCESS_FS_REFER;
    }
    if abi >= 3 {
        rights |= ACCESS_FS_TRUNCATE;
    }
    rights
}

/// Rights valid for a regular file / character-device rule target.
fn file_write_rights(abi: u32) -> u64 {
    let mut rights = ACCESS_FS_WRITE_FILE;
    if abi >= 3 {
        rights |= ACCESS_FS_TRUNCATE;
    }
    rights
}

/// Apply an allowlist write-scoping ruleset to the calling thread. Must run in
/// the forked child before `exec`; every target descriptor must already be open
/// and every mask pre-computed.
///
/// `targets` holds `(O_PATH descriptor, allowed rights)` pairs for the writable
/// roots; `device_targets` allows the same rights on specific device nodes
/// (`/dev/null`, `/dev/tty`). When `deny_tcp` is set and the ABI supports it,
/// all TCP `bind`/`connect` calls are denied.
pub(crate) fn apply_write_scope(
    abi: u32,
    targets: &[(i32, u64)],
    device_targets: &[i32],
    deny_tcp: bool,
) -> io::Result<()> {
    let handled_fs = write_scope_rights(abi);
    let handled_net = if deny_tcp && abi >= 4 {
        ACCESS_NET_BIND_TCP | ACCESS_NET_CONNECT_TCP
    } else {
        0
    };
    let attr = RulesetAttr {
        handled_access_fs: handled_fs,
        handled_access_net: handled_net,
    };
    // SAFETY: `attr` points to a valid `landlock_ruleset_attr` of the given size.
    let ruleset_fd = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            &attr as *const RulesetAttr,
            std::mem::size_of::<RulesetAttr>(),
            0u64,
        )
    };
    if ruleset_fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let ruleset_fd = ruleset_fd as i32;

    for (parent_fd, allowed) in targets {
        let rule = PathBeneathAttr {
            allowed_access: allowed & handled_fs,
            parent_fd: *parent_fd,
            reserved: 0,
        };
        // SAFETY: `rule` is a valid `landlock_path_beneath_attr`, `ruleset_fd`
        // is the ruleset just created and `parent_fd` is an O_PATH descriptor.
        // The fourth argument of `landlock_add_rule` is `__u32 flags` (must be
        // zero) — not an attribute size; passing the struct size yields EINVAL.
        let result = unsafe {
            libc::syscall(
                libc::SYS_landlock_add_rule,
                ruleset_fd,
                u64::from(LANDLOCK_RULE_PATH_BENEATH),
                &rule as *const PathBeneathAttr,
                0u64,
            )
        };
        if result < 0 {
            let error = io::Error::last_os_error();
            // SAFETY: closing the ruleset descriptor we own.
            unsafe { libc::close(ruleset_fd) };
            return Err(error);
        }
    }
    for parent_fd in device_targets {
        let rule = PathBeneathAttr {
            allowed_access: file_write_rights(abi),
            parent_fd: *parent_fd,
            reserved: 0,
        };
        // SAFETY: same contract as the root rules above; `flags` must be zero.
        let result = unsafe {
            libc::syscall(
                libc::SYS_landlock_add_rule,
                ruleset_fd,
                u64::from(LANDLOCK_RULE_PATH_BENEATH),
                &rule as *const PathBeneathAttr,
                0u64,
            )
        };
        if result < 0 {
            let error = io::Error::last_os_error();
            // SAFETY: closing the ruleset descriptor we own.
            unsafe { libc::close(ruleset_fd) };
            return Err(error);
        }
    }

    // `landlock_restrict_self` requires `no_new_privs` to be set first.
    // SAFETY: `prctl(PR_SET_NO_NEW_PRIVS)` with constant arguments.
    let result = unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
    if result != 0 {
        let error = io::Error::last_os_error();
        // SAFETY: closing the ruleset descriptor we own.
        unsafe { libc::close(ruleset_fd) };
        return Err(error);
    }
    // SAFETY: applying the ruleset to the calling thread; the ruleset
    // descriptor stays owned by this thread's setup code.
    let result = unsafe { libc::syscall(libc::SYS_landlock_restrict_self, ruleset_fd, 0u64) };
    let outcome = if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    };
    // SAFETY: closing the ruleset descriptor we own.
    unsafe { libc::close(ruleset_fd) };
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rights_are_monotonic_in_abi() {
        assert_eq!(write_scope_rights(1) & ACCESS_FS_REFER, 0);
        assert_eq!(write_scope_rights(1) & ACCESS_FS_TRUNCATE, 0);
        assert_ne!(write_scope_rights(2) & ACCESS_FS_REFER, 0);
        assert_eq!(write_scope_rights(2) & ACCESS_FS_TRUNCATE, 0);
        assert_ne!(write_scope_rights(3) & ACCESS_FS_TRUNCATE, 0);
        assert_eq!(write_scope_rights(7), write_scope_rights(3));
    }

    #[test]
    fn device_creation_rights_are_never_handled() {
        // MAKE_CHAR (1 << 6) and MAKE_BLOCK (1 << 11) must stay unhandled so
        // device-tree setup is unaffected and no device creation is implied.
        for abi in 1..=8 {
            let rights = write_scope_rights(abi);
            assert_eq!(rights & (1 << 6), 0, "MAKE_CHAR handled at ABI {abi}");
            assert_eq!(rights & (1 << 11), 0, "MAKE_BLOCK handled at ABI {abi}");
        }
    }

    #[test]
    fn abi_probe_reports_a_level_or_a_typed_error() {
        match probe_abi() {
            Ok(abi) => assert!(abi >= 1, "probed ABI must be >= 1, got {abi}"),
            Err(reason) => assert!(!reason.is_empty(), "unavailable probe must carry a reason"),
        }
    }
}
