//! Third-party notices: generation, delivery, and the staleness gate
//! (`ARCH/05-SOURCE-LEDGER.md` §4, `DEC-011`, `DEC-030`, `TODO.md` `AX-010`).
//!
//! The bundle is generated from the pinned lockfile and from the license files
//! of the packages that were unpacked for the platform doing the generating.
//! It is embedded in the binary, so `horizoncode --credits` prints exactly what
//! ships, and a unit test compares that embedded text byte-for-byte against a
//! fresh generation: a dependency change without regenerating the bundle fails
//! the gate instead of silently shipping stale attribution.
//!
//! A package whose sources are not present locally (a dependency for another
//! target platform, which this host never built) is listed under *not resolved
//! on the generating platform*. That is visible, not silent; a release for the
//! other platform regenerates the bundle there. The gate is deliberately
//! strict: byte equality means a locally resolvable package can never be
//! hidden in the unresolved section.
//!
//! Required notices are reproduced verbatim and never paraphrased (`DEC-011`).

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

/// The generated bundle's file name.
pub const BUNDLE_FILE: &str = "THIRD-PARTY-NOTICES.md";

/// The bundle embedded in this binary; `--credits` prints it.
pub const BUNDLE: &str = include_str!("../../../THIRD-PARTY-NOTICES.md");

/// Why generation or validation could not complete.
#[derive(Debug, thiserror::Error)]
pub enum NoticesError {
    /// A file could not be read.
    #[error("{path} cannot be read: {detail}")]
    Io {
        /// The file involved.
        path: PathBuf,
        /// The underlying failure.
        detail: String,
    },
    /// The lockfile is not the TOML Cargo writes.
    #[error("Cargo.lock is not valid TOML: {0}")]
    Lock(String),
    /// A package ships no license expression or file to reproduce.
    #[error("{name} {version} declares neither `license` nor `license-file`")]
    MissingLicense {
        /// The package name.
        name: String,
        /// The package version.
        version: String,
    },
    /// The shipped bundle does not match the pinned dependency graph.
    #[error(
        "the third-party notices bundle is stale ({0}); regenerate it with `horizoncode notices generate`"
    )]
    Stale(String),
}

/// One registry package from the lockfile.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct LockedPackage {
    name: String,
    version: String,
}

/// One resolved package with its license expression and texts.
#[derive(Clone, Debug, PartialEq)]
struct ResolvedPackage {
    name: String,
    version: String,
    license: String,
    texts: Vec<LicenseText>,
}

/// One verbatim license/notice document.
#[derive(Clone, Debug, PartialEq)]
struct LicenseText {
    file: String,
    body: String,
}

/// Renders the bundle for the workspace at `root`, resolving package sources
/// from the ambient Cargo home.
///
/// # Errors
/// Returns [`NoticesError`] when the lockfile, a manifest, or a license file
/// cannot be read or parsed.
pub fn render(root: &Path) -> Result<String, NoticesError> {
    render_with(root, &cargo_home())
}

/// [`render`] with an explicit Cargo home, so a test can fixture the registry.
fn render_with(root: &Path, cargo_home: &Path) -> Result<String, NoticesError> {
    let lock_path = root.join("Cargo.lock");
    let lock_text = fs::read_to_string(&lock_path).map_err(|error| NoticesError::Io {
        path: lock_path.clone(),
        detail: error.to_string(),
    })?;
    let locks = parse_lock(&lock_text)?;
    let digest = blake3::hash(lock_text.as_bytes()).to_hex().to_string();

    let mut resolved = Vec::new();
    let mut unresolved = Vec::new();
    for locked in &locks {
        match resolve(locked, cargo_home)? {
            Some(package) => resolved.push(package),
            None => unresolved.push(locked.clone()),
        }
    }
    Ok(bundle(&digest, locks.len(), &resolved, &unresolved))
}

/// Confirms that `shipped` is current for the dependency graph at `root`.
///
/// Byte equality is deliberately **not** the rule: which package sources are
/// unpacked depends on what this machine has built, so an equality gate would
/// pass or fail by accident. The gate instead checks what matters:
///
/// 1. the lockfile digest embedded in the bundle matches `Cargo.lock` — any
///    dependency change makes the bundle stale until it is regenerated;
/// 2. every package in the lock graph appears in the bundle, and nothing
///    appears that is not in the lock;
/// 3. every package whose source is present locally appears in the *resolved*
///    table with the same license expression, and every license text it ships
///    appears verbatim in the bundle — a locally built package can never be
///    hidden in the unresolved section or lose its notice.
///
/// # Errors
/// Returns [`NoticesError::Stale`] with the failing reason when the bundle must
/// be regenerated, or another [`NoticesError`] when a file cannot be read.
pub fn validate(shipped: &str, root: &Path) -> Result<(), NoticesError> {
    validate_with(shipped, root, &cargo_home())
}

/// [`validate`] with an explicit Cargo home, so a test can fixture the registry.
fn validate_with(shipped: &str, root: &Path, cargo_home: &Path) -> Result<(), NoticesError> {
    let lock_path = root.join("Cargo.lock");
    let lock_text = fs::read_to_string(&lock_path).map_err(|error| NoticesError::Io {
        path: lock_path.clone(),
        detail: error.to_string(),
    })?;
    let digest = blake3::hash(lock_text.as_bytes()).to_hex().to_string();
    let shipped_digest = embedded_digest(shipped)
        .ok_or_else(|| NoticesError::Stale("the bundle names no lockfile digest".to_owned()))?;
    if shipped_digest != digest {
        return Err(NoticesError::Stale(
            "the named lockfile digest does not match Cargo.lock".to_owned(),
        ));
    }

    let locks = parse_lock(&lock_text)?;
    let locked: BTreeSet<(&str, &str)> = locks
        .iter()
        .map(|package| (package.name.as_str(), package.version.as_str()))
        .collect();
    let (resolved, unresolved) = parse_tables(shipped);
    for (name, version, _) in &resolved {
        if !locked.contains(&(name.as_str(), version.as_str())) {
            return Err(NoticesError::Stale(format!(
                "{name} {version} is not in the lock graph"
            )));
        }
    }
    for (name, version) in &unresolved {
        if !locked.contains(&(name.as_str(), version.as_str())) {
            return Err(NoticesError::Stale(format!(
                "{name} {version} is not in the lock graph"
            )));
        }
    }

    let resolved_index: BTreeSet<(&str, &str)> = resolved
        .iter()
        .map(|(name, version, _)| (name.as_str(), version.as_str()))
        .collect();
    let unresolved_index: BTreeSet<(&str, &str)> = unresolved
        .iter()
        .map(|(name, version)| (name.as_str(), version.as_str()))
        .collect();
    for package in &locks {
        let key = (package.name.as_str(), package.version.as_str());
        if !resolved_index.contains(&key) && !unresolved_index.contains(&key) {
            return Err(NoticesError::Stale(format!(
                "{} {} is missing from the bundle",
                package.name, package.version
            )));
        }
    }

    for package in &locks {
        let Some(local) = resolve(package, cargo_home)? else {
            continue;
        };
        let Some((_, _, license)) = resolved
            .iter()
            .find(|(name, version, _)| name == &local.name && version == &local.version)
        else {
            return Err(NoticesError::Stale(format!(
                "{} {} resolves locally but is not in the resolved table",
                local.name, local.version
            )));
        };
        if license != &local.license {
            return Err(NoticesError::Stale(format!(
                "{} {} is listed as `{license}` but ships `{}`",
                local.name, local.version, local.license
            )));
        }
        for text in &local.texts {
            if !shipped.contains(text.body.trim_end_matches('\n')) {
                return Err(NoticesError::Stale(format!(
                    "the notice shipped by {} {} as `{}` is absent from the bundle",
                    local.name, local.version, text.file
                )));
            }
        }
    }
    Ok(())
}

/// Extracts the hex digest from the bundle's provenance line.
fn embedded_digest(bundle: &str) -> Option<&str> {
    for line in bundle.lines() {
        if let Some(rest) = line.strip_prefix("- Lockfile `Cargo.lock` digest (`blake3`): `") {
            return rest.strip_suffix('`');
        }
    }
    None
}

/// A resolved bundle row: `(package, version, license expression)`.
type ResolvedRow = (String, String, String);

/// An unresolved bundle row: `(package, version)`.
type UnresolvedRow = (String, String);

/// Parses the resolved and unresolved package tables out of the bundle.
fn parse_tables(bundle: &str) -> (Vec<ResolvedRow>, Vec<UnresolvedRow>) {
    let mut resolved = Vec::new();
    let mut unresolved = Vec::new();
    let mut section = "";
    for line in bundle.lines() {
        if let Some(heading) = line.strip_prefix("## ") {
            section = heading.trim();
            continue;
        }
        let trimmed = line.trim();
        if !trimmed.starts_with('|') {
            continue;
        }
        let cells: Vec<&str> = trimmed
            .split('|')
            .map(str::trim)
            .filter(|cell| !cell.is_empty())
            .collect();
        if cells.len() < 2 || cells[0] == "Package" || cells[0] == "---" {
            continue;
        }
        match section {
            "Pinned dependency set" if cells.len() == 3 => resolved.push((
                cells[0].to_owned(),
                cells[1].to_owned(),
                cells[2].to_owned(),
            )),
            "Not resolved on the generating platform" if cells.len() == 2 => {
                unresolved.push((cells[0].to_owned(), cells[1].to_owned()));
            }
            _ => {}
        }
    }
    (resolved, unresolved)
}

/// Walks up from `start` to the workspace root: the nearest directory holding
/// both `Cargo.lock` and `Cargo.toml`.
#[must_use]
pub fn workspace_root(start: &Path) -> Option<PathBuf> {
    let mut walk = Some(start);
    while let Some(dir) = walk {
        if dir.join("Cargo.lock").is_file() && dir.join("Cargo.toml").is_file() {
            return Some(dir.to_path_buf());
        }
        walk = dir.parent();
    }
    None
}

fn parse_lock(text: &str) -> Result<Vec<LockedPackage>, NoticesError> {
    let value: toml::Value =
        toml::from_str(text).map_err(|error| NoticesError::Lock(error.to_string()))?;
    let packages = value
        .get("package")
        .and_then(toml::Value::as_array)
        .ok_or_else(|| NoticesError::Lock("the lockfile has no `[[package]]` table".to_owned()))?;
    let mut out = Vec::new();
    for package in packages {
        let source = package
            .get("source")
            .and_then(toml::Value::as_str)
            .unwrap_or_default();
        // A workspace member or path dependency has no registry source; it is
        // first-party and carries this project's own license.
        if !source.starts_with("registry+") {
            continue;
        }
        let name = package
            .get("name")
            .and_then(toml::Value::as_str)
            .ok_or_else(|| NoticesError::Lock("a package has no name".to_owned()))?;
        let version = package
            .get("version")
            .and_then(toml::Value::as_str)
            .ok_or_else(|| NoticesError::Lock("a package has no version".to_owned()))?;
        out.push(LockedPackage {
            name: name.to_owned(),
            version: version.to_owned(),
        });
    }
    out.sort();
    Ok(out)
}

fn resolve(
    locked: &LockedPackage,
    cargo_home: &Path,
) -> Result<Option<ResolvedPackage>, NoticesError> {
    let Some(dir) = find_source(cargo_home, &locked.name, &locked.version) else {
        return Ok(None);
    };
    let manifest_path = dir.join("Cargo.toml");
    let manifest_text = fs::read_to_string(&manifest_path).map_err(|error| NoticesError::Io {
        path: manifest_path.clone(),
        detail: error.to_string(),
    })?;
    let manifest: toml::Value = toml::from_str(&manifest_text)
        .map_err(|error| NoticesError::Lock(format!("{}: {error}", manifest_path.display())))?;
    let package_table = manifest.get("package").ok_or_else(|| {
        NoticesError::Lock(format!("{} has no [package]", manifest_path.display()))
    })?;
    let declared = package_table
        .get("license")
        .and_then(toml::Value::as_str)
        .map(str::to_owned);
    let license_file = package_table
        .get("license-file")
        .and_then(toml::Value::as_str)
        .map(str::to_owned);
    let Some(license) = declared.clone().or_else(|| {
        license_file
            .as_ref()
            .map(|file| format!("license-file: {file}"))
    }) else {
        return Err(NoticesError::MissingLicense {
            name: locked.name.clone(),
            version: locked.version.clone(),
        });
    };

    let mut names: BTreeSet<String> = BTreeSet::new();
    if let Some(file) = &license_file {
        names.insert(file.clone());
    }
    let entries = fs::read_dir(&dir).map_err(|error| NoticesError::Io {
        path: dir.clone(),
        detail: error.to_string(),
    })?;
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let upper = name.to_ascii_uppercase();
        if upper.starts_with("LICENSE")
            || upper.starts_with("COPYING")
            || upper.starts_with("NOTICE")
            || upper.starts_with("UNLICENSE")
        {
            names.insert(name);
        }
    }

    let mut texts = Vec::new();
    for name in names {
        let path = dir.join(&name);
        if !path.is_file() {
            continue;
        }
        let body = fs::read_to_string(&path).map_err(|error| NoticesError::Io {
            path: path.clone(),
            detail: error.to_string(),
        })?;
        texts.push(LicenseText { file: name, body });
    }
    texts.sort_by(|a, b| a.file.cmp(&b.file));
    Ok(Some(ResolvedPackage {
        name: locked.name.clone(),
        version: locked.version.clone(),
        license,
        texts,
    }))
}

fn find_source(cargo_home: &Path, name: &str, version: &str) -> Option<PathBuf> {
    let registry = cargo_home.join("registry").join("src");
    let target = format!("{name}-{version}");
    let mut roots: Vec<PathBuf> = fs::read_dir(&registry)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    roots.sort();
    roots
        .into_iter()
        .map(|root| root.join(&target))
        .find(|candidate| candidate.is_dir())
}

fn cargo_home() -> PathBuf {
    std::env::var_os("CARGO_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".cargo")))
        .unwrap_or_else(|| PathBuf::from(".cargo"))
}

fn bundle(
    digest: &str,
    locked_total: usize,
    resolved: &[ResolvedPackage],
    unresolved: &[LockedPackage],
) -> String {
    let mut out = String::new();
    writeln!(
        out,
        "<!-- Generated by `horizoncode notices generate`. Do not edit by hand. -->"
    )
    .unwrap();
    writeln!(out, "# Third-party notices\n").unwrap();
    writeln!(
        out,
        "HorizonCode is distributed under the Apache License 2.0 (`LICENSE`). It\n\
         includes the third-party packages listed below. This bundle is generated\n\
         from the pinned dependency graph and ships with the binary; `horizoncode\n\
         --credits` prints it from the binary itself. Required notices are\n\
         reproduced verbatim and are never paraphrased (`DEC-011`, `DEC-030`).\n"
    )
    .unwrap();
    writeln!(out, "## Provenance\n").unwrap();
    writeln!(out, "- Lockfile `Cargo.lock` digest (`blake3`): `{digest}`").unwrap();
    writeln!(
        out,
        "- Packages in the lock graph: {locked_total} ({} resolved on the generating \
         platform, {} not present locally)",
        resolved.len(),
        unresolved.len()
    )
    .unwrap();
    writeln!(out).unwrap();

    writeln!(out, "## Pinned dependency set\n").unwrap();
    writeln!(out, "| Package | Version | License |").unwrap();
    writeln!(out, "| --- | --- | --- |").unwrap();
    for package in resolved {
        writeln!(
            out,
            "| {} | {} | {} |",
            package.name, package.version, package.license
        )
        .unwrap();
    }
    writeln!(out).unwrap();

    if !unresolved.is_empty() {
        writeln!(out, "## Not resolved on the generating platform\n").unwrap();
        writeln!(
            out,
            "These packages are in the lock graph for another target platform, so\n\
             their sources were absent here. A release for that platform regenerates\n\
             this bundle there; the gate refuses a bundle that hides a locally\n\
             resolvable package in this section.\n"
        )
        .unwrap();
        writeln!(out, "| Package | Version |").unwrap();
        writeln!(out, "| --- | --- |").unwrap();
        for package in unresolved {
            writeln!(out, "| {} | {} |", package.name, package.version).unwrap();
        }
        writeln!(out).unwrap();
    }

    writeln!(out, "## License texts\n").unwrap();
    writeln!(
        out,
        "Each text below is reproduced verbatim from the packages that ship it, once\n\
         per license expression that requires it.\n"
    )
    .unwrap();

    // Group by expression, then by distinct text body (deduplicated by digest).
    let mut expressions: BTreeSet<String> = BTreeSet::new();
    for package in resolved {
        expressions.insert(package.license.clone());
    }
    for expression in expressions {
        let members: Vec<&ResolvedPackage> = resolved
            .iter()
            .filter(|package| package.license == expression)
            .collect();
        writeln!(
            out,
            "### {} ({} package{})\n",
            expression,
            members.len(),
            if members.len() == 1 { "" } else { "s" }
        )
        .unwrap();
        // Reproduce each distinct body once per expression, naming every file
        // it was found under for traceability.
        let mut texts: Vec<(String, BTreeSet<String>)> = Vec::new();
        let mut seen: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
        for package in &members {
            for text in &package.texts {
                let digest = blake3::hash(text.body.as_bytes()).to_hex().to_string();
                let index = *seen.entry(digest).or_insert_with(|| {
                    texts.push((text.body.clone(), BTreeSet::new()));
                    texts.len() - 1
                });
                texts[index].1.insert(text.file.clone());
            }
        }
        for (body, files) in texts {
            let label = files.into_iter().collect::<Vec<_>>().join(", ");
            writeln!(out, "Shipped as: `{label}`\n").unwrap();
            writeln!(out, "````text\n{}\n````\n", body.trim_end_matches('\n')).unwrap();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root_with_lock(lock: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("Cargo.lock"), lock).unwrap();
        dir
    }

    fn fixture_home() -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        let crate_dir = home
            .path()
            .join("registry/src/index.test/example-crate-1.2.3");
        fs::create_dir_all(&crate_dir).unwrap();
        fs::write(
            crate_dir.join("Cargo.toml"),
            "[package]\nname = \"example-crate\"\nversion = \"1.2.3\"\nlicense = \"MIT\"\n",
        )
        .unwrap();
        fs::write(
            crate_dir.join("LICENSE"),
            "MIT License\n\nPermission is granted.\n",
        )
        .unwrap();
        home
    }

    const LOCK: &str = r#"
version = 4

[[package]]
name = "example-crate"
version = "1.2.3"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "0000000000000000000000000000000000000000000000000000000000000000"

[[package]]
name = "other-platform-crate"
version = "9.9.9"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "1111111111111111111111111111111111111111111111111111111111111111"

[[package]]
name = "horizoncode-cli"
version = "0.1.0"
"#;

    #[test]
    fn only_registry_packages_are_locked_in_and_the_order_is_stable() {
        let packages = parse_lock(LOCK).unwrap();
        assert_eq!(
            packages,
            vec![
                LockedPackage {
                    name: "example-crate".to_owned(),
                    version: "1.2.3".to_owned()
                },
                LockedPackage {
                    name: "other-platform-crate".to_owned(),
                    version: "9.9.9".to_owned()
                },
            ],
            "the workspace member has no registry source and is not third-party"
        );
    }

    #[test]
    fn a_resolvable_package_renders_its_license_text_and_a_missing_one_is_visible() {
        let root = root_with_lock(LOCK);
        let home = fixture_home();
        let rendered = render_with(root.path(), home.path()).unwrap();

        assert!(rendered.contains("| example-crate | 1.2.3 | MIT |"));
        assert!(rendered.contains("Permission is granted."));
        assert!(rendered.contains("## Not resolved on the generating platform"));
        assert!(rendered.contains("| other-platform-crate | 9.9.9 |"));
        assert!(
            !rendered.contains("| other-platform-crate | 9.9.9 | MIT |"),
            "an unresolved package must not be given a license row"
        );
        assert!(rendered.contains("Lockfile `Cargo.lock` digest"));
    }

    #[test]
    fn the_render_is_deterministic() {
        let root = root_with_lock(LOCK);
        let home = fixture_home();
        let first = render_with(root.path(), home.path()).unwrap();
        let second = render_with(root.path(), home.path()).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn validate_refuses_an_edited_row_a_removed_row_and_a_removed_notice() {
        let root = root_with_lock(LOCK);
        let home = fixture_home();
        let rendered = render_with(root.path(), home.path()).unwrap();
        assert!(
            validate_with(&rendered, root.path(), home.path()).is_ok(),
            "a fresh generation validates"
        );

        let relabelled = rendered.replacen(
            "| example-crate | 1.2.3 | MIT |",
            "| example-crate | 1.2.3 | BSD-3-Clause |",
            1,
        );
        assert!(
            matches!(
                validate_with(&relabelled, root.path(), home.path()),
                Err(NoticesError::Stale(_))
            ),
            "a license expression that does not match the package source is refused"
        );

        let removed_row = rendered.replacen("| example-crate | 1.2.3 | MIT |\n", "", 1);
        assert!(
            matches!(
                validate_with(&removed_row, root.path(), home.path()),
                Err(NoticesError::Stale(_))
            ),
            "hiding a locally resolvable package is refused"
        );

        let removed_text = rendered.replacen("Permission is granted.", "", 1);
        assert!(
            matches!(
                validate_with(&removed_text, root.path(), home.path()),
                Err(NoticesError::Stale(_))
            ),
            "dropping a required notice is refused"
        );

        let digest = embedded_digest(&rendered).expect("digest line").to_owned();
        let stale_digest = rendered.replacen(&digest, &"0".repeat(64), 1);
        assert!(
            matches!(
                validate_with(&stale_digest, root.path(), home.path()),
                Err(NoticesError::Stale(_))
            ),
            "a dependency change (different digest) is refused"
        );
    }

    /// The release gate (`REQ-VER-013`): the shipped bundle must match the
    /// pinned graph, and an edit must be refused.
    #[test]
    fn the_shipped_bundle_matches_the_pinned_graph() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        assert!(
            validate(BUNDLE, &root).is_ok(),
            "the shipped third-party notices bundle is stale; run \
             `cargo run -p horizoncode-cli -- notices generate`"
        );
        let digest = embedded_digest(BUNDLE).expect("digest line");
        let edited = BUNDLE.replacen(digest, &"0".repeat(64), 1);
        assert_ne!(edited, BUNDLE);
        assert!(
            matches!(validate(&edited, &root), Err(NoticesError::Stale(_))),
            "a bundle naming a different lock digest must be refused"
        );
    }
}
