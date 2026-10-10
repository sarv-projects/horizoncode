//! Live read-only follower for OpenCode durable Session EventV2 tables.
//! Usage: cargo run --bin session_sync_probe -- <source-db> <projection-db> <session-id> [--follow] [--poll-ms=N] [--max-polls=N]
//! This process NEVER writes to OpenCode or loads provider/model credentials.
use horizoncode_kernel::session_projection::SessionProjection;
use rusqlite::{Connection, OpenFlags};
use std::path::Path;
use std::process::ExitCode;
use std::thread;
use std::time::Duration;

fn usage() -> ExitCode {
    eprintln!(
        "Usage: session_sync_probe <opencode-db> <projection-db> <session-id> [--follow] [--poll-ms=N] [--max-polls=N]"
    );
    ExitCode::from(2)
}

#[derive(Debug)]
struct Options {
    source: String,
    destination: String,
    session: String,
    follow: bool,
    poll_ms: u64,
    max_polls: Option<usize>,
}

fn parse(args: &[String]) -> Option<Options> {
    if args.len() < 3 {
        return None;
    }
    let (mut follow, mut poll_ms, mut max_polls) = (false, 250_u64, None);
    for option in args.iter().skip(3) {
        if option == "--follow" {
            follow = true;
        } else if let Some(value) = option.strip_prefix("--poll-ms=") {
            poll_ms = value.parse().ok()?;
            if !(50..=60_000).contains(&poll_ms) {
                return None;
            }
        } else {
            let value = option.strip_prefix("--max-polls=")?;
            let count: usize = value.parse().ok()?;
            if count == 0 {
                return None;
            }
            max_polls = Some(count);
        }
    }
    if !follow && (max_polls.is_some() || poll_ms != 250) {
        return None;
    }
    Some(Options {
        source: args[0].clone(),
        destination: args[1].clone(),
        session: args[2].clone(),
        follow,
        poll_ms,
        max_polls,
    })
}

fn sync_all(
    projection: &mut SessionProjection,
    source: &Connection,
    session: &str,
) -> Result<(usize, i64, u64), String> {
    let mut imported = 0_usize;
    loop {
        let report = projection
            .sync(source, session, 512)
            .map_err(|e| e.to_string())?;
        imported += report.imported;
        if report.imported < 512 {
            return Ok((imported, report.cursor.last_seq, report.cursor.count));
        }
    }
}

fn run() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let opts = parse(&args).ok_or_else(|| {
        "Invalid arguments (use --follow, --poll-ms=N, --max-polls=N)".to_string()
    })?;
    let source_path = std::fs::canonicalize(&opts.source)
        .map_err(|e| format!("Cannot locate OpenCode source database: {e}"))?;
    let dest_path = Path::new(&opts.destination);
    if dest_path.exists() {
        let target = std::fs::canonicalize(dest_path)
            .map_err(|e| format!("Cannot inspect destination: {e}"))?;
        if target == source_path {
            return Err("Source and destination SQLite files must be distinct".into());
        }
        // On Unix, two distinct paths may be hardlinks to the same inode.
        // Refuse to open the writable projection over the read-only source.
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let source_meta =
                std::fs::metadata(&source_path).map_err(|e| format!("Cannot stat source: {e}"))?;
            let target_meta = std::fs::metadata(dest_path)
                .map_err(|e| format!("Cannot stat destination: {e}"))?;
            if source_meta.dev() == target_meta.dev() && source_meta.ino() == target_meta.ino() {
                return Err("Source and destination are hardlinks to the same SQLite file".into());
            }
        }
    }
    let source = Connection::open_with_flags(
        &source_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("Cannot open OpenCode database read-only: {e}"))?;
    source
        .pragma_update(None, "query_only", "ON")
        .map_err(|e| format!("Cannot enforce source query-only mode: {e}"))?;
    let dest =
        Connection::open(dest_path).map_err(|e| format!("Cannot open projection database: {e}"))?;
    let mut projection =
        SessionProjection::open(dest).map_err(|e| format!("Cannot initialize projection: {e}"))?;

    let mut polls = 0_usize;
    loop {
        let (imported, cursor, receipts) = sync_all(&mut projection, &source, &opts.session)?;
        if imported > 0 || polls == 0 || !opts.follow {
            println!(
                "session={} imported={} committed_cursor={} total_receipts={}",
                opts.session, imported, cursor, receipts
            );
        }
        polls += 1;
        if !opts.follow || opts.max_polls.is_some_and(|max| polls >= max) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(opts.poll_ms));
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Session follower failed: {error}");
            usage();
            ExitCode::FAILURE
        }
    }
}
