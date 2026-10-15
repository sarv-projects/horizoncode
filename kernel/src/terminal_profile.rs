//! Host-controlled, deterministic and durable terminal shell profile resolution.
//!
//! The authenticated Core host registers configuration; terminal requests can refer only
//! to the returned shellProfileID and cannot provide executable paths or profile config.

use rusqlite::{Connection, OptionalExtension, params};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ShellProfileKind {
    PosixBash,
    WindowsPowerShell7,
    WindowsCmd,
    WslUbuntuBash,
    WslDebianBash,
}

impl ShellProfileKind {
    pub const fn profile_key(self) -> &'static str {
        match self {
            Self::PosixBash => "posix.bash",
            Self::WindowsPowerShell7 => "windows.powershell7",
            Self::WindowsCmd => "windows.cmd",
            Self::WslUbuntuBash => "wsl.ubuntu.bash",
            Self::WslDebianBash => "wsl.debian.bash",
        }
    }

    pub fn parse(kind: &str) -> Option<Self> {
        parse_kind(kind)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellProfileRegistration {
    pub profile_key: String,
    pub kind: ShellProfileKind,
    /// Trusted Core configuration value; never read from terminal operation bodies.
    pub executable: PathBuf,
    pub login: bool,
    /// Exact configured distro name, e.g. `Ubuntu-22.04` or `Debian`.
    pub distribution: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedShellProfile {
    pub profile_key: String,
    pub shell_profile_id: String,
    pub kind: ShellProfileKind,
    pub executable: PathBuf,
    pub config_digest: String,
    pub profile_digest: String,
    pub generation: u64,
    pub login: bool,
    pub distribution: Option<String>,
    pub availability: ShellProfileAvailability,
}

impl ResolvedShellProfile {
    /// Construct arguments from the registered profile after Guard admission.
    pub fn command_argv(&self, command: Option<&str>, wsl_cwd: Option<&str>) -> Vec<String> {
        match self.kind {
            ShellProfileKind::PosixBash => {
                let mut args = Vec::with_capacity(3);
                if self.login {
                    args.push("--login".to_owned());
                }
                if let Some(command) = command {
                    args.extend(["-c".to_owned(), command.to_owned()]);
                }
                args
            }
            ShellProfileKind::WindowsPowerShell7 => {
                let mut args = vec!["-NoLogo".to_owned(), "-NoProfile".to_owned()];
                if let Some(command) = command {
                    args.extend([
                        "-NonInteractive".to_owned(),
                        "-Command".to_owned(),
                        command.to_owned(),
                    ]);
                }
                args
            }
            ShellProfileKind::WindowsCmd => {
                let mut args = vec!["/D".to_owned()];
                if let Some(command) = command {
                    args.extend(["/S".to_owned(), "/C".to_owned(), command.to_owned()]);
                }
                args
            }
            ShellProfileKind::WslUbuntuBash | ShellProfileKind::WslDebianBash => {
                let mut args = vec![
                    "--distribution".to_owned(),
                    self.distribution
                        .clone()
                        .expect("registered WSL profile has a distribution"),
                ];
                if let Some(cwd) = wsl_cwd {
                    args.extend(["--cd".to_owned(), cwd.to_owned()]);
                }
                args.extend(["--exec".to_owned(), "bash".to_owned()]);
                if self.login {
                    args.push("--login".to_owned());
                }
                if let Some(command) = command {
                    args.extend(["-c".to_owned(), command.to_owned()]);
                }
                args
            }
        }
    }

    /// Translate a canonical Windows Location cwd through the selected WSL distribution.
    pub fn translate_wsl_cwd(
        &self,
        location_root: &Path,
        working_directory: &Path,
    ) -> Result<Option<String>, ShellProfileError> {
        if !matches!(
            self.kind,
            ShellProfileKind::WslUbuntuBash | ShellProfileKind::WslDebianBash
        ) {
            return Ok(None);
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            let root =
                std::fs::canonicalize(location_root).map_err(|_| ShellProfileError::Unavailable)?;
            let canonical = std::fs::canonicalize(working_directory)
                .map_err(|_| ShellProfileError::Unavailable)?;
            if !canonical.starts_with(&root)
                || !std::fs::metadata(&canonical)
                    .map_err(|_| ShellProfileError::Unavailable)?
                    .is_dir()
                || canonical.as_os_str().encode_wide().count() > 4096
            {
                return Err(ShellProfileError::InvalidConfiguration);
            }
            let output = std::process::Command::new(&self.executable)
                .args([
                    "--distribution",
                    self.distribution
                        .as_deref()
                        .ok_or(ShellProfileError::Unavailable)?,
                    "--exec",
                    "wslpath",
                    "-a",
                    canonical.to_str().ok_or(ShellProfileError::Unavailable)?,
                ])
                .env_clear()
                .output()
                .map_err(|_| ShellProfileError::Unavailable)?;
            if !output.status.success() || output.stdout.len() > 4096 {
                return Err(ShellProfileError::Unavailable);
            }
            let path = std::str::from_utf8(&output.stdout)
                .map_err(|_| ShellProfileError::Unavailable)?
                .trim_end_matches(['\r', '\n']);
            if !path.starts_with('/')
                || path.contains('\0')
                || path.contains('\n')
                || path.contains('\r')
            {
                return Err(ShellProfileError::Unavailable);
            }
            return Ok(Some(path.to_owned()));
        }
        #[cfg(not(windows))]
        {
            let _ = (location_root, working_directory);
            Err(ShellProfileError::Unavailable)
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellProfileError {
    InvalidConfiguration,
    Unavailable,
    StaleGeneration,
    CorruptRegistry,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellProfileAvailability {
    Available,
    Unavailable,
}

impl ShellProfileAvailability {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Debug)]
pub struct ShellProfileRegistry {
    connection: Connection,
    profiles: BTreeMap<String, ResolvedShellProfile>,
    default_profile_key: String,
}

impl ShellProfileRegistry {
    /// Open the durable registry file inside the owner's private state directory.
    pub fn open(path: &Path) -> Result<Self, ShellProfileError> {
        #[cfg(target_os = "linux")]
        secure_profile_database(path)?;
        let connection = Connection::open(path).map_err(|_| ShellProfileError::Unavailable)?;
        connection
            .pragma_update(None, "journal_mode", "DELETE")
            .map_err(|_| ShellProfileError::Unavailable)?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|_| ShellProfileError::Unavailable)?;
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS shell_profiles (
                profile_key TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                executable TEXT NOT NULL,
                config_digest TEXT NOT NULL,
                generation INTEGER NOT NULL,
                login INTEGER NOT NULL,
                distribution TEXT,
                shell_profile_id TEXT NOT NULL,
                profile_digest TEXT NOT NULL,
                active INTEGER NOT NULL CHECK(active IN (0,1))
            );
            CREATE TABLE IF NOT EXISTS shell_profile_default (
                singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                profile_key TEXT NOT NULL
            );",
            )
            .map_err(|_| ShellProfileError::CorruptRegistry)?;
        let default_profile_key = connection
            .query_row(
                "SELECT profile_key FROM shell_profile_default WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| ShellProfileError::CorruptRegistry)?
            .unwrap_or_default();
        let mut registry = Self {
            connection,
            profiles: BTreeMap::new(),
            default_profile_key,
        };
        registry.load_active()?;
        Ok(registry)
    }

    fn load_active(&mut self) -> Result<(), ShellProfileError> {
        let mut statement = self.connection.prepare(
            "SELECT profile_key,kind,executable,config_digest,generation,login,distribution,shell_profile_id,profile_digest FROM shell_profiles WHERE active=1 ORDER BY profile_key"
        ).map_err(|_| ShellProfileError::CorruptRegistry)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, bool>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            })
            .map_err(|_| ShellProfileError::CorruptRegistry)?;
        for row in rows {
            let (
                profile_key,
                kind,
                executable,
                config_digest,
                generation,
                login,
                distribution,
                shell_profile_id,
                stored_profile_digest,
            ) = row.map_err(|_| ShellProfileError::CorruptRegistry)?;
            let kind = parse_kind(&kind).ok_or(ShellProfileError::CorruptRegistry)?;
            let generation =
                u64::try_from(generation).map_err(|_| ShellProfileError::CorruptRegistry)?;
            if generation == 0 {
                return Err(ShellProfileError::CorruptRegistry);
            }
            let path = PathBuf::from(executable);
            let config_expected =
                shell_config_digest(&profile_key, kind, &path, login, distribution.as_deref());
            if config_expected != config_digest
                || profile_digest(
                    kind,
                    &path,
                    &config_digest,
                    generation,
                    login,
                    distribution.as_deref(),
                ) != stored_profile_digest
                || profile_id(&profile_key, &stored_profile_digest) != shell_profile_id
                || validate_profile_key(&profile_key, kind, distribution.as_deref()).is_err()
            {
                return Err(ShellProfileError::CorruptRegistry);
            }
            let availability = if validate_registration(
                kind,
                &path,
                &config_digest,
                generation,
                login,
                distribution.as_deref(),
            )
            .is_ok()
            {
                ShellProfileAvailability::Available
            } else {
                ShellProfileAvailability::Unavailable
            };
            self.profiles.insert(
                profile_key.clone(),
                ResolvedShellProfile {
                    profile_key,
                    shell_profile_id,
                    kind,
                    executable: path,
                    config_digest,
                    profile_digest: stored_profile_digest,
                    generation,
                    login,
                    distribution,
                    availability,
                },
            );
        }
        Ok(())
    }

    /// Replace the active registry from trusted Core configuration. Generations persist
    /// across restarts; identical config is idempotent and changed config advances once.
    pub fn register_profiles(
        &mut self,
        default_profile_key: &str,
        registrations: Vec<ShellProfileRegistration>,
    ) -> Result<ShellProfileList, ShellProfileError> {
        if default_profile_key.is_empty()
            || default_profile_key.len() > 128
            || registrations.is_empty()
        {
            return Err(ShellProfileError::InvalidConfiguration);
        }
        let mut unique = BTreeSet::new();
        if registrations.iter().any(|profile| {
            profile.profile_key.is_empty()
                || profile.profile_key.len() > 128
                || !unique.insert(profile.profile_key.clone())
        }) {
            return Err(ShellProfileError::InvalidConfiguration);
        }
        if !unique.contains(default_profile_key) {
            return Err(ShellProfileError::InvalidConfiguration);
        }

        let transaction = self
            .connection
            .transaction()
            .map_err(|_| ShellProfileError::Unavailable)?;
        transaction
            .execute("UPDATE shell_profiles SET active=0", [])
            .map_err(|_| ShellProfileError::Unavailable)?;
        let mut next_profiles = BTreeMap::new();
        for registration in registrations {
            let profile = build_registered_profile(&transaction, registration)?;
            transaction.execute(
                "INSERT INTO shell_profiles(profile_key,kind,executable,config_digest,generation,login,distribution,shell_profile_id,profile_digest,active)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,1)
                 ON CONFLICT(profile_key) DO UPDATE SET kind=excluded.kind,executable=excluded.executable,config_digest=excluded.config_digest,generation=excluded.generation,login=excluded.login,distribution=excluded.distribution,shell_profile_id=excluded.shell_profile_id,profile_digest=excluded.profile_digest,active=1",
                params![profile.profile_key, kind_name(profile.kind), profile.executable.to_string_lossy(), profile.config_digest,
                    i64::try_from(profile.generation).map_err(|_| ShellProfileError::StaleGeneration)?, profile.login,
                    profile.distribution, profile.shell_profile_id, profile.profile_digest],
            ).map_err(|_| ShellProfileError::Unavailable)?;
            next_profiles.insert(profile.profile_key.clone(), profile);
        }
        transaction.execute(
            "INSERT INTO shell_profile_default(singleton,profile_key) VALUES(1,?1) ON CONFLICT(singleton) DO UPDATE SET profile_key=excluded.profile_key",
            [default_profile_key],
        ).map_err(|_| ShellProfileError::Unavailable)?;
        transaction
            .commit()
            .map_err(|_| ShellProfileError::Unavailable)?;
        self.default_profile_key = default_profile_key.to_owned();
        self.profiles = next_profiles;
        Ok(self.list())
    }

    pub fn resolve(
        &self,
        shell_profile_id: &str,
    ) -> Result<&ResolvedShellProfile, ShellProfileError> {
        let profile = self
            .profiles
            .values()
            .find(|profile| profile.shell_profile_id == shell_profile_id)
            .ok_or(ShellProfileError::Unavailable)?;
        if profile.availability == ShellProfileAvailability::Available {
            Ok(profile)
        } else {
            Err(ShellProfileError::Unavailable)
        }
    }

    pub fn default_profile_id(&self) -> Result<&str, ShellProfileError> {
        let profile = self
            .profiles
            .get(&self.default_profile_key)
            .ok_or(ShellProfileError::Unavailable)?;
        if profile.availability == ShellProfileAvailability::Available {
            Ok(&profile.shell_profile_id)
        } else {
            Err(ShellProfileError::Unavailable)
        }
    }

    pub fn list(&self) -> ShellProfileList {
        ShellProfileList {
            default_profile_key: self.default_profile_key.clone(),
            default_shell_profile_id: self
                .profiles
                .get(&self.default_profile_key)
                .map(|p| p.shell_profile_id.clone()),
            profiles: self.profiles.values().cloned().collect(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellProfileList {
    pub default_profile_key: String,
    pub default_shell_profile_id: Option<String>,
    pub profiles: Vec<ResolvedShellProfile>,
}

fn build_registered_profile(
    connection: &Connection,
    registration: ShellProfileRegistration,
) -> Result<ResolvedShellProfile, ShellProfileError> {
    let distribution = validate_distribution(registration.kind, registration.distribution)?;
    validate_profile_key(
        &registration.profile_key,
        registration.kind,
        distribution.as_deref(),
    )?;
    let canonical = std::fs::canonicalize(&registration.executable).ok();
    let executable = canonical
        .clone()
        .unwrap_or_else(|| registration.executable.clone());
    let config_digest = shell_config_digest(
        &registration.profile_key,
        registration.kind,
        &executable,
        registration.login,
        distribution.as_deref(),
    );
    let availability = if canonical.is_some()
        && validate_registration(
            registration.kind,
            &executable,
            &config_digest,
            1,
            registration.login,
            distribution.as_deref(),
        )
        .is_ok()
    {
        ShellProfileAvailability::Available
    } else {
        ShellProfileAvailability::Unavailable
    };
    let previous: Option<(String, String, String, i64, bool, Option<String>, String, String)> = connection.query_row(
        "SELECT kind,executable,config_digest,generation,login,distribution,shell_profile_id,profile_digest FROM shell_profiles WHERE profile_key=?1",
        [&registration.profile_key], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?))
    ).optional().map_err(|_| ShellProfileError::CorruptRegistry)?;
    let same = previous
        .as_ref()
        .is_some_and(|(kind, path, digest, _, login, distro, _, _)| {
            kind == kind_name(registration.kind)
                && path == executable.to_string_lossy().as_ref()
                && digest == &config_digest
                && *login == registration.login
                && *distro == distribution
        });
    let generation = match previous.as_ref() {
        Some((_, _, _, generation, _, _, _, _)) if same => {
            u64::try_from(*generation).map_err(|_| ShellProfileError::CorruptRegistry)?
        }
        Some((_, _, _, generation, _, _, _, _)) => u64::try_from(*generation)
            .ok()
            .and_then(|value| value.checked_add(1))
            .ok_or(ShellProfileError::StaleGeneration)?,
        None => 1,
    };
    let profile_digest = profile_digest(
        registration.kind,
        &executable,
        &config_digest,
        generation,
        registration.login,
        distribution.as_deref(),
    );
    let shell_profile_id = profile_id(&registration.profile_key, &profile_digest);
    Ok(ResolvedShellProfile {
        profile_key: registration.profile_key,
        shell_profile_id,
        kind: registration.kind,
        executable,
        config_digest,
        profile_digest,
        generation,
        login: registration.login,
        distribution,
        availability,
    })
}

fn validate_registration(
    kind: ShellProfileKind,
    executable: &Path,
    digest: &str,
    generation: u64,
    _login: bool,
    distribution: Option<&str>,
) -> Result<(), ShellProfileError> {
    if generation == 0 || !is_blake3_digest(digest) || !host_supports(kind) {
        return Err(ShellProfileError::Unavailable);
    }
    validate_executable_name(kind, executable)?;
    validate_executable_permissions(kind, executable)?;
    validate_shell_backend(kind, executable)?;
    if matches!(
        kind,
        ShellProfileKind::WslUbuntuBash | ShellProfileKind::WslDebianBash
    ) != distribution.is_some()
    {
        return Err(ShellProfileError::InvalidConfiguration);
    }
    Ok(())
}

fn host_supports(kind: ShellProfileKind) -> bool {
    match kind {
        ShellProfileKind::PosixBash => cfg!(target_os = "linux"),
        _ => cfg!(windows),
    }
}

fn validate_distribution(
    kind: ShellProfileKind,
    distribution: Option<String>,
) -> Result<Option<String>, ShellProfileError> {
    match (kind, distribution) {
        (ShellProfileKind::WslUbuntuBash, Some(name))
            if name == "Ubuntu" || name.starts_with("Ubuntu-") =>
        {
            Ok(Some(name))
        }
        (ShellProfileKind::WslDebianBash, Some(name)) if name == "Debian" => Ok(Some(name)),
        (ShellProfileKind::WslUbuntuBash | ShellProfileKind::WslDebianBash, _) => {
            Err(ShellProfileError::Unavailable)
        }
        (_, None) => Ok(None),
        (_, Some(_)) => Err(ShellProfileError::InvalidConfiguration),
    }
}
fn validate_profile_key(
    key: &str,
    kind: ShellProfileKind,
    distro: Option<&str>,
) -> Result<(), ShellProfileError> {
    let expected = match kind {
        ShellProfileKind::PosixBash => "posix:bash".to_owned(),
        ShellProfileKind::WindowsPowerShell7 => "windows:powershell7".to_owned(),
        ShellProfileKind::WindowsCmd => "windows:cmd".to_owned(),
        ShellProfileKind::WslUbuntuBash | ShellProfileKind::WslDebianBash => {
            format!(
                "wsl:{}",
                distro.ok_or(ShellProfileError::InvalidConfiguration)?
            )
        }
    };
    if key == expected {
        Ok(())
    } else {
        Err(ShellProfileError::InvalidConfiguration)
    }
}

fn validate_shell_backend(
    kind: ShellProfileKind,
    executable: &Path,
) -> Result<(), ShellProfileError> {
    if kind == ShellProfileKind::WindowsPowerShell7 && powershell_major_version(executable)? < 7 {
        return Err(ShellProfileError::Unavailable);
    }
    Ok(())
}

#[cfg(windows)]
fn powershell_major_version(executable: &Path) -> Result<u16, ShellProfileError> {
    use std::ffi::OsStr;
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null_mut, read_unaligned};
    type Dword = u32;
    #[repr(C)]
    struct FixedFileInfo {
        signature: Dword,
        struct_version: Dword,
        file_version_ms: Dword,
        file_version_ls: Dword,
        product_version_ms: Dword,
        product_version_ls: Dword,
        file_flags_mask: Dword,
        file_flags: Dword,
        file_os: Dword,
        file_type: Dword,
        file_subtype: Dword,
        file_date_ms: Dword,
        file_date_ls: Dword,
    }
    #[link(name = "version")]
    unsafe extern "system" {
        fn GetFileVersionInfoSizeW(filename: *const u16, handle: *mut Dword) -> Dword;
        fn GetFileVersionInfoW(
            filename: *const u16,
            handle: Dword,
            size: Dword,
            data: *mut u8,
        ) -> i32;
        fn VerQueryValueW(
            data: *const u8,
            query: *const u16,
            value: *mut *mut core::ffi::c_void,
            length: *mut Dword,
        ) -> i32;
    }
    let path: Vec<u16> = executable
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut ignored = 0;
    let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), &mut ignored) };
    if size == 0 || size > 16 * 1024 * 1024 {
        return Err(ShellProfileError::Unavailable);
    }
    let mut data = vec![0_u8; size as usize];
    if unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size, data.as_mut_ptr()) } == 0 {
        return Err(ShellProfileError::Unavailable);
    }
    let query: [u16; 2] = [92, 0];
    let mut value = null_mut();
    let mut length = 0;
    if unsafe { VerQueryValueW(data.as_ptr(), query.as_ptr(), &mut value, &mut length) } == 0
        || value.is_null()
        || (length as usize) < size_of::<FixedFileInfo>()
    {
        return Err(ShellProfileError::Unavailable);
    }
    let info = unsafe { read_unaligned(value.cast::<FixedFileInfo>()) };
    if info.signature != 0xFEEF04BD {
        return Err(ShellProfileError::Unavailable);
    }
    Ok((info.file_version_ms >> 16) as u16)
}

#[cfg(not(windows))]
fn powershell_major_version(_: &Path) -> Result<u16, ShellProfileError> {
    Err(ShellProfileError::Unavailable)
}

fn validate_executable_name(
    kind: ShellProfileKind,
    executable: &Path,
) -> Result<(), ShellProfileError> {
    let name = executable
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(ShellProfileError::InvalidConfiguration)?;
    let valid = match kind {
        ShellProfileKind::PosixBash => name == "bash",
        ShellProfileKind::WindowsPowerShell7 => name.eq_ignore_ascii_case("pwsh.exe"),
        ShellProfileKind::WindowsCmd => name.eq_ignore_ascii_case("cmd.exe"),
        ShellProfileKind::WslUbuntuBash | ShellProfileKind::WslDebianBash => {
            name.eq_ignore_ascii_case("wsl.exe")
        }
    };
    if valid {
        Ok(())
    } else {
        Err(ShellProfileError::InvalidConfiguration)
    }
}

#[cfg(target_os = "linux")]
fn validate_executable_permissions(
    kind: ShellProfileKind,
    executable: &Path,
) -> Result<(), ShellProfileError> {
    use std::os::unix::fs::PermissionsExt;
    if kind == ShellProfileKind::PosixBash
        && std::fs::metadata(executable)
            .map_err(|_| ShellProfileError::Unavailable)?
            .permissions()
            .mode()
            & 0o111
            == 0
    {
        return Err(ShellProfileError::Unavailable);
    }
    Ok(())
}
#[cfg(not(target_os = "linux"))]
fn validate_executable_permissions(_: ShellProfileKind, _: &Path) -> Result<(), ShellProfileError> {
    Ok(())
}

fn kind_name(kind: ShellProfileKind) -> &'static str {
    match kind {
        ShellProfileKind::PosixBash => "posix.bash",
        ShellProfileKind::WindowsPowerShell7 => "windows.powershell7",
        ShellProfileKind::WindowsCmd => "windows.cmd",
        ShellProfileKind::WslUbuntuBash => "wsl.ubuntu.bash",
        ShellProfileKind::WslDebianBash => "wsl.debian.bash",
    }
}
fn parse_kind(kind: &str) -> Option<ShellProfileKind> {
    match kind {
        "posix.bash" => Some(ShellProfileKind::PosixBash),
        "windows.powershell7" => Some(ShellProfileKind::WindowsPowerShell7),
        "windows.cmd" => Some(ShellProfileKind::WindowsCmd),
        "wsl.ubuntu.bash" => Some(ShellProfileKind::WslUbuntuBash),
        "wsl.debian.bash" => Some(ShellProfileKind::WslDebianBash),
        _ => None,
    }
}
fn is_blake3_digest(digest: &str) -> bool {
    let Some(hex) = digest.strip_prefix("blake3:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn shell_config_digest(
    key: &str,
    kind: ShellProfileKind,
    executable: &Path,
    login: bool,
    distribution: Option<&str>,
) -> String {
    let mut hash = blake3::Hasher::new();
    hash.update(b"horizon.shell-config.v1\0");
    for value in [
        key.as_bytes(),
        kind_name(kind).as_bytes(),
        executable.to_string_lossy().as_bytes(),
    ] {
        hash.update(&(value.len() as u64).to_be_bytes());
        hash.update(value);
    }
    hash.update(&[u8::from(login)]);
    if let Some(distro) = distribution {
        hash.update(&[1]);
        hash.update(&(distro.len() as u64).to_be_bytes());
        hash.update(distro.as_bytes());
    } else {
        hash.update(&[0]);
    }
    format!("blake3:{}", hash.finalize().to_hex())
}
fn profile_digest(
    kind: ShellProfileKind,
    executable: &Path,
    config_digest: &str,
    generation: u64,
    login: bool,
    distribution: Option<&str>,
) -> String {
    let mut hash = blake3::Hasher::new();
    hash.update(b"horizon.shell-profile.v1\0");
    hash.update(kind.profile_key().as_bytes());
    hash.update(b"\0");
    hash.update(executable.to_string_lossy().as_bytes());
    hash.update(b"\0");
    hash.update(config_digest.as_bytes());
    hash.update(&generation.to_be_bytes());
    hash.update(&[u8::from(login)]);
    if let Some(distro) = distribution {
        hash.update(distro.as_bytes());
    }
    format!("blake3:{}", hash.finalize().to_hex())
}
fn profile_id(key: &str, digest: &str) -> String {
    let mut hash = blake3::Hasher::new();
    hash.update(b"horizon.shell-profile-id.v1\0");
    hash.update(key.as_bytes());
    hash.update(b"\0");
    hash.update(digest.as_bytes());
    format!("shp_{}", hash.finalize().to_hex())
}
#[cfg(target_os = "linux")]
fn secure_profile_database(path: &Path) -> Result<(), ShellProfileError> {
    use std::fs::OpenOptions;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    if !path.is_absolute() {
        return Err(ShellProfileError::InvalidConfiguration);
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| ShellProfileError::Unavailable)?;
    let metadata = file
        .metadata()
        .map_err(|_| ShellProfileError::Unavailable)?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o777 != 0o600
        || metadata.nlink() != 1
    {
        return Err(ShellProfileError::Unavailable);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_profile_keys_and_unknown_profiles_fail_closed() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE shell_profiles(profile_key TEXT PRIMARY KEY,kind TEXT NOT NULL,executable TEXT NOT NULL,config_digest TEXT NOT NULL,generation INTEGER NOT NULL,login INTEGER NOT NULL,distribution TEXT,shell_profile_id TEXT NOT NULL,profile_digest TEXT NOT NULL,active INTEGER NOT NULL); CREATE TABLE shell_profile_default(singleton INTEGER PRIMARY KEY,profile_key TEXT NOT NULL);").unwrap();
        let registry = ShellProfileRegistry {
            connection,
            profiles: BTreeMap::new(),
            default_profile_key: String::new(),
        };
        assert_eq!(ShellProfileKind::PosixBash.profile_key(), "posix.bash");
        assert_eq!(
            ShellProfileKind::WindowsPowerShell7.profile_key(),
            "windows.powershell7"
        );
        assert_eq!(ShellProfileKind::WindowsCmd.profile_key(), "windows.cmd");
        assert_eq!(
            ShellProfileKind::WslUbuntuBash.profile_key(),
            "wsl.ubuntu.bash"
        );
        assert_eq!(
            ShellProfileKind::WslDebianBash.profile_key(),
            "wsl.debian.bash"
        );
        assert_eq!(
            registry.resolve("unknown"),
            Err(ShellProfileError::Unavailable)
        );
    }

    #[test]
    fn native_windows_power_shell_name_rejects_legacy_powershell() {
        assert_eq!(
            validate_executable_name(ShellProfileKind::WindowsPowerShell7, Path::new("pwsh.exe")),
            Ok(())
        );
        assert_eq!(
            validate_executable_name(
                ShellProfileKind::WindowsPowerShell7,
                Path::new("powershell.exe")
            ),
            Err(ShellProfileError::InvalidConfiguration)
        );
    }
    #[test]
    fn profile_generation_is_durable_idempotent_and_fences_replacement() {
        let path = std::env::temp_dir().join(format!(
            "hz-shell-profile-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let registration = |login| ShellProfileRegistration {
            profile_key: "posix:bash".to_owned(),
            kind: ShellProfileKind::PosixBash,
            executable: PathBuf::from("/bin/bash"),
            login,
            distribution: None,
        };
        let mut registry = ShellProfileRegistry::open(&path).unwrap();
        let initial = registry
            .register_profiles("posix:bash", vec![registration(false)])
            .unwrap();
        let original_id = initial.profiles[0].shell_profile_id.clone();
        assert_eq!(initial.profiles[0].generation, 1);
        drop(registry);

        let mut registry = ShellProfileRegistry::open(&path).unwrap();
        let unchanged = registry
            .register_profiles("posix:bash", vec![registration(false)])
            .unwrap();
        assert_eq!(unchanged.profiles[0].generation, 1);
        assert_eq!(unchanged.profiles[0].shell_profile_id, original_id);
        let changed = registry
            .register_profiles("posix:bash", vec![registration(true)])
            .unwrap();
        assert_eq!(changed.profiles[0].generation, 2);
        assert_ne!(changed.profiles[0].shell_profile_id, original_id);
        assert_eq!(
            registry.resolve(&original_id),
            Err(ShellProfileError::Unavailable)
        );
        assert_eq!(
            changed.default_shell_profile_id.as_deref(),
            Some(changed.profiles[0].shell_profile_id.as_str())
        );
        drop(registry);
        std::fs::remove_file(path).unwrap();
    }
}
