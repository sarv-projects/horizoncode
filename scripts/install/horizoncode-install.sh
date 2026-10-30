#!/usr/bin/env bash
# ============================================================================
# HorizonCode one-line installer (Linux / WSL)
#
# Install sources — pick ONE. Without an explicit source this script FAILS
# CLOSED and installs nothing (release signing is deferred beyond V1, see
# arch_V1/17-GOVERNANCE-DECISIONS.md DEC-V1-12, so no unsigned remote code
# is ever pulled into a secure path by default).
#
#   1) Local checkout (recommended while signing is pending):
#        curl -fsSL https://raw.githubusercontent.com/sarv-projects/horizoncode/main/scripts/install/horizoncode-install.sh \
#          | bash -s -- --from-repo "$HOME/business_Dev/agentx"
#
#   2) Local prebuilt CLI candidate (digest pin mandatory):
#        curl -fsSL <url> | bash -s -- --binary /path/to/horizoncode --sha256 <64-hex>
#
#   3) Remote release binary — EXPLICIT OPT-IN + digest pin required:
#        HORIZONCODE_INSTALL_SHA256=<64-hex> \
#          curl -fsSL <url> | bash -s -- --remote --version 1.18.35
#
# The script is idempotent: re-running with the same candidate is a verified
# no-op. Every install is staged, digest-verified, then atomically activated;
# a failure leaves the previous installation untouched (fails closed).
# ============================================================================
set -euo pipefail
export LC_ALL=C

COMMAND=horizoncode
ALIAS=hzcode
DEFAULT_ENDPOINT_BASE="https://github.com/sarv-projects/horizoncode/releases/download"

MUTED='\033[0;2m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

info()  { printf '%s\n' "$*" >&2; }
ok()    { printf "${GREEN}%s${NC}\n" "$*" >&2; }
warn()  { printf "${YELLOW}%s${NC}\n" "$*" >&2; }
die()   { printf "${RED}Error: %s${NC}\n" "$*" >&2; exit 1; }

usage() {
    cat <<'EOF'
HorizonCode Installer (one-line / curl|bash capable)

Installs the 'horizoncode' CLI with its 'hzcode' short alias. Linux/WSL only.

Install sources (choose one; none => fail closed):
    -b, --binary <path>      Install from a local executable candidate
        --sha256 <hex>       Candidate SHA-256 pin (64 hex, REQUIRED with --binary)
        --from-repo <dir>    Install from a local HorizonCode checkout
        --launcher           With --from-repo and no prebuilt binary: install a
                             dev launcher that runs the checkout via bun
        --remote             EXPLICIT OPT-IN remote download (unsigned until the
                             signing trust policy lands, DEC-V1-12). Requires a
                             digest pin via --sha256 or HORIZONCODE_INSTALL_SHA256
    -v, --version <version>  With --remote: release version (default: latest known)
        --asset-name <name>  With --remote: release asset file name

Options:
        --endpoint-base <url>  Remote base URL (default: GitHub releases)
    -d, --dir <path>         Install directory (default: $HOME/.opencode/bin,
                             override with HORIZONCODE_INSTALL_DIR)
        --no-modify-path      Do not touch shell configuration files
        --dry-run             Validate and print the plan; write nothing
    -h, --help                Show this help

Environment:
    HORIZONCODE_INSTALL_DIR       Install directory
    HORIZONCODE_INSTALL_SHA256    Digest pin for --remote installs
    HORIZONCODE_RELEASE_BASE      Same as --endpoint-base
    HORIZONCODE_RELEASE_ASSET     Same as --asset-name
EOF
}

binary_path=""
from_repo=""
remote=false
launcher=false
no_modify_path=false
dry_run=false
requested_version=""
expected_sha256=""
endpoint_base="${HORIZONCODE_RELEASE_BASE:-$DEFAULT_ENDPOINT_BASE}"
asset_name="${HORIZONCODE_RELEASE_ASSET:-}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        -b|--binary)
            [[ -n "${2:-}" ]] || die "--binary requires a path argument"
            binary_path="$2"; shift 2 ;;
        --sha256)
            [[ -n "${2:-}" ]] || die "--sha256 requires a 64-hex digest argument"
            expected_sha256="$2"; shift 2 ;;
        --from-repo)
            [[ -n "${2:-}" ]] || die "--from-repo requires a directory argument"
            from_repo="$2"; shift 2 ;;
        --launcher) launcher=true; shift ;;
        --remote) remote=true; shift ;;
        -v|--version)
            [[ -n "${2:-}" ]] || die "--version requires a version argument"
            requested_version="$2"; shift 2 ;;
        --asset-name)
            [[ -n "${2:-}" ]] || die "--asset-name requires a file name argument"
            asset_name="$2"; shift 2 ;;
        --endpoint-base)
            [[ -n "${2:-}" ]] || die "--endpoint-base requires a URL argument"
            endpoint_base="$2"; shift 2 ;;
        -d|--dir)
            [[ -n "${2:-}" ]] || die "--dir requires a path argument"
            HORIZONCODE_INSTALL_DIR="$2"; shift ;;
        --no-modify-path) no_modify_path=true; shift ;;
        --dry-run) dry_run=true; shift ;;
        *) die "unknown option '$1' (see --help)" ;;
    esac
done

# ---------------------------------------------------------------- platform --
# HZ_UNAME_S / HZ_UNAME_M exist only so the offline test-suite can exercise
# platform rejection; production runs always read the real kernel values.
raw_os="${HZ_UNAME_S:-$(uname -s)}"
case "$raw_os" in
    Linux*) ;;
    *) die "HorizonCode V1 installer supports Linux/WSL only (detected: ${raw_os})." ;;
esac

wsl=false
if grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
    wsl=true
    info "WSL detected ($(uname -r)); installing the Linux build."
fi

# ------------------------------------------------------------- source count --
sources=0
if [[ -n "$binary_path" ]]; then sources=$((sources + 1)); fi
if [[ -n "$from_repo" ]]; then sources=$((sources + 1)); fi
if [[ "$remote" == true ]]; then sources=$((sources + 1)); fi
if [[ "$sources" -eq 0 ]]; then
    die "no install source given. Provide --from-repo, --binary+--sha256, or explicit --remote. Nothing is downloaded or installed by default (DEC-V1-12)."
fi
[[ "$sources" -eq 1 ]] || die "provide exactly one install source (--binary, --from-repo, or --remote)."

if [[ -n "$binary_path" && "$remote" == true ]]; then
    die "--binary cannot be combined with --remote."
fi
if [[ -n "$from_repo" && ( -n "$binary_path" || "$remote" == true ) ]]; then
    die "--from-repo cannot be combined with --binary/--remote."
fi
if [[ "$launcher" == true && -z "$from_repo" ]]; then
    die "--launcher requires --from-repo."
fi

# -------------------------------------------------------------- sha helpers --
compute_sha256() {
    local output
    if command -v sha256sum >/dev/null 2>&1; then
        output=$(sha256sum -- "$1") || return 1
    elif command -v shasum >/dev/null 2>&1; then
        output=$(shasum -a 256 -- "$1") || return 1
    else
        return 1
    fi
    output=${output%%[[:space:]]*}
    [[ "$output" =~ ^[[:xdigit:]]{64}$ ]] || return 1
    printf '%s' "$output"
}

validate_digest_arg() {
    [[ "$1" =~ ^[0-9a-fA-F]{64}$ ]] || die "SHA-256 must be exactly 64 hexadecimal characters."
}

elf_machine_id() {
    local path=$1 magic class byte_order machine
    command -v od >/dev/null 2>&1 || return 1
    magic=$(od -An -tx1 -N4 -- "$path" | tr -d '[:space:]')
    [[ "$magic" == "7f454c46" ]] || return 1
    class=$(od -An -tu1 -j4 -N1 -- "$path" | tr -d '[:space:]')
    byte_order=$(od -An -tu1 -j5 -N1 -- "$path" | tr -d '[:space:]')
    [[ "$class" == "2" && "$byte_order" == "1" ]] || return 1
    machine=$(od -An -tu2 -j18 -N2 -- "$path" | tr -d '[:space:]')
    [[ "$machine" =~ ^[0-9]+$ ]] || return 1
    printf '%s' "$machine"
}

validate_candidate_architecture() {
    local path=$1 host_machine expected_machine observed_machine first_line interpreter extra
    host_machine="${HZ_UNAME_M:-$(uname -m)}"
    case "$host_machine" in
        x86_64|amd64) expected_machine=62 ;;
        aarch64|arm64) expected_machine=183 ;;
        *) die "Linux architecture '${host_machine}' is not a supported V1 installer target." ;;
    esac
    observed_machine=$(elf_machine_id "$path") || observed_machine=""
    if [[ -z "$observed_machine" ]]; then
        if ! IFS= read -r first_line < "$path" || [[ "$first_line" != '#!'* ]]; then
            die "candidate is not a supported ELF executable or direct-interpreter script."
        fi
        read -r interpreter extra <<< "${first_line#\#!}"
        if [[ -z "$interpreter" || -n "${extra:-}" || "$interpreter" != /* || "${interpreter##*/}" == "env" || ! -f "$interpreter" || ! -x "$interpreter" ]]; then
            die "candidate script must use one absolute executable ELF interpreter without env indirection."
        fi
        observed_machine=$(elf_machine_id "$interpreter") || observed_machine=""
        [[ -n "$observed_machine" ]] || die "candidate script interpreter is not a supported little-endian ELF executable."
    fi
    [[ "$observed_machine" == "$expected_machine" ]] || die "candidate architecture does not match host '${host_machine}' (ELF machine ${observed_machine})."
}

validate_regular_executable() {
    [[ -f "$1" && -x "$1" && ! -L "$1" ]] || die "candidate must be a regular executable file: $1"
}

# --------------------------------------------------------- resolve candidate --
mode=""
candidate=""
candidate_sha=""
launcher_repo=""

if [[ -n "$binary_path" ]]; then
    mode="local-binary"
    validate_regular_executable "$binary_path"
    [[ -n "$expected_sha256" ]] || die "--sha256 is required with --binary; every local install must be digest-pinned."
    validate_digest_arg "$expected_sha256"
    candidate="$binary_path"
    candidate_sha=$(compute_sha256 "$candidate") || die "no sha256sum/shasum available to verify the candidate."
    [[ "${candidate_sha,,}" == "${expected_sha256,,}" ]] || die "candidate SHA-256 mismatch (expected ${expected_sha256,,}, actual ${candidate_sha}); refusing to install."
    validate_candidate_architecture "$candidate"

elif [[ -n "$from_repo" ]]; then
    mode="local-repo"
    [[ -d "$from_repo" ]] || die "--from-repo directory does not exist: $from_repo"
    repo_dir=$(cd "$from_repo" && pwd -P)
    [[ -f "$repo_dir/package.json" ]] || die "--from-repo is not a HorizonCode checkout (no package.json): $repo_dir"
    found=""
    for rel in "packages/horizoncode/dist/horizoncode" "dist/horizoncode" "packages/horizoncode/dist/horizoncode-linux" "horizoncode"; do
        if [[ -f "$repo_dir/$rel" && -x "$repo_dir/$rel" && ! -L "$repo_dir/$rel" ]]; then
            found="$repo_dir/$rel"
            break
        fi
    done
    if [[ -n "$found" ]]; then
        candidate="$found"
        candidate_sha=$(compute_sha256 "$candidate") || die "no sha256sum/shasum available to verify the checkout candidate."
        validate_candidate_architecture "$candidate"
    elif [[ "$launcher" == true ]]; then
        mode="repo-launcher"
        launcher_repo="$repo_dir"
        command -v "${HORIZONCODE_BUN:-bun}" >/dev/null 2>&1 || [[ -x "$HOME/.bun/bin/bun" ]] || die "--launcher needs bun on PATH (or \$HOME/.bun/bin/bun)."
    else
        die "no prebuilt CLI found under $repo_dir (looked in packages/horizoncode/dist/). Build it first, or pass --launcher for a dev launcher."
    fi

elif [[ "$remote" == true ]]; then
    mode="remote"
    [[ -n "$requested_version" ]] || die "--remote requires an explicit --version; silent 'latest' upgrades are disabled (DEC-V1-12)."
    [[ "$requested_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || die "--version must look like semver (got: $requested_version)."
    if [[ -z "$expected_sha256" ]]; then
        expected_sha256="${HORIZONCODE_INSTALL_SHA256:-}"
    fi
    [[ -n "$expected_sha256" ]] || die "remote installs require a trusted digest pin (--sha256 or HORIZONCODE_INSTALL_SHA256); signing is deferred (DEC-V1-12) so unpinned remote code is refused."
    validate_digest_arg "$expected_sha256"
    [[ -n "$asset_name" ]] || asset_name="horizoncode-v${requested_version}-linux-$(uname -m)"
    warn "${YELLOW}REMOTE INSTALL: fetching UNSIGNED release '${asset_name}' v${requested_version}. Release signing is deferred beyond V1 (DEC-V1-12); the digest pin is your only trust anchor.${NC}"
    command -v curl >/dev/null 2>&1 || die "curl is required for --remote installs."
    tmpdir=$(mktemp -d) || die "could not create a temp directory."
    trap 'rm -rf -- "$tmpdir"' EXIT
    url="${endpoint_base%/}/v${requested_version}/${asset_name}"
    info "Downloading $url"
    curl -fsSL --proto '=https' --max-time 300 -o "$tmpdir/$asset_name" "$url" || die "download failed: $url"
    candidate="$tmpdir/$asset_name"
    candidate_sha=$(compute_sha256 "$candidate") || die "no sha256sum/shasum available to verify the download."
    [[ "${candidate_sha,,}" == "${expected_sha256,,}" ]] || die "downloaded artifact SHA-256 mismatch (expected ${expected_sha256,,}, actual ${candidate_sha}); refusing to install."
    validate_candidate_architecture "$candidate"
fi

# ------------------------------------------------------------ install target --
INSTALL_DIR=${HORIZONCODE_INSTALL_DIR:-$HOME/.opencode/bin}
validate_install_dir() {
    local value=$1
    [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "install directory must be non-empty and contain no CR/LF."
    [[ ! "$value" =~ [^a-zA-Z0-9_./\ -] ]] || die "install directory may contain only ASCII letters, digits, spaces, '_', '.', '/', and '-'."
}
validate_install_dir "$INSTALL_DIR"
[[ ! -L "$INSTALL_DIR" ]] || die "install directory must not be a symlink: $INSTALL_DIR"
for destination in "$COMMAND" "$ALIAS"; do
    current="${INSTALL_DIR}/${destination}"
    [[ ! ( -d "$current" && ! -L "$current" ) ]] || die "install destination must not be a directory: $current"
done

# -------------------------------------------------------------- idempotency --
if [[ "$mode" != "repo-launcher" && -f "${INSTALL_DIR}/${COMMAND}" && ! -L "${INSTALL_DIR}/${COMMAND}" ]]; then
    existing_sha=$(compute_sha256 "${INSTALL_DIR}/${COMMAND}" || true)
    if [[ -n "$existing_sha" && "$existing_sha" == "$candidate_sha" ]]; then
        ok "HorizonCode already installed and up to date in ${INSTALL_DIR} (sha256 ${existing_sha}). Nothing to do."
        exit 0
    fi
fi

# ------------------------------------------------------------------- plan --
if [[ "$dry_run" == true ]]; then
    echo "Dry run: no files will be written."
    echo "  mode:      ${mode}${wsl:+ (wsl)}"
    echo "  candidate: ${candidate:-<repo launcher: ${launcher_repo}>}"
    if [[ -n "$candidate_sha" ]]; then echo "  sha256:    ${candidate_sha}"; fi
    echo "  canonical: ${INSTALL_DIR}/${COMMAND}"
    echo "  alias:     ${INSTALL_DIR}/${ALIAS} -> ${COMMAND}"
    echo "  shell path: $([[ "$no_modify_path" == true ]] && echo unchanged || echo "add ${INSTALL_DIR} if absent")"
    exit 0
fi

mkdir -p "$INSTALL_DIR" || die "could not create install directory: $INSTALL_DIR"

install_launcher() {
    local staged
    staged=$(mktemp "${INSTALL_DIR}/.horizoncode-install.XXXXXX") || die "could not stage launcher."
    local bun_bin="${HORIZONCODE_BUN:-}"
    if [[ -z "$bun_bin" ]]; then
        if command -v bun >/dev/null 2>&1; then bun_bin=$(command -v bun)
        elif [[ -x "$HOME/.bun/bin/bun" ]]; then bun_bin="$HOME/.bun/bin/bun"
        else rm -f -- "$staged"; die "bun not found for launcher install."
        fi
    fi
    {
        printf '#!/usr/bin/env bash\n'
        printf '# HorizonCode dev launcher (installed by horizoncode-install.sh --launcher)\n'
        printf 'exec "%s" "%s/packages/horizoncode/src/index.ts" "$@"\n' "$bun_bin" "$launcher_repo"
    } > "$staged"
    chmod 755 "$staged"
    if ! mv -f -- "$staged" "${INSTALL_DIR}/${COMMAND}"; then
        rm -f -- "$staged"
        die "could not activate ${INSTALL_DIR}/${COMMAND}."
    fi
}

install_binary() {
    local staged
    staged=$(mktemp "${INSTALL_DIR}/.horizoncode-install.XXXXXX") || die "could not stage candidate."
    if ! cp -- "$candidate" "$staged" || ! chmod 755 "$staged"; then
        rm -f -- "$staged"
        die "could not copy candidate into ${INSTALL_DIR}."
    fi
    local staged_sha
    staged_sha=$(compute_sha256 "$staged") || { rm -f -- "$staged"; die "staged digest could not be verified."; }
    [[ "$staged_sha" == "$candidate_sha" ]] || { rm -f -- "$staged"; die "staged digest mismatch; refusing activation."; }
    if ! mv -f -- "$staged" "${INSTALL_DIR}/${COMMAND}"; then
        rm -f -- "$staged"
        die "could not activate ${INSTALL_DIR}/${COMMAND}."
    fi
}

if [[ "$mode" == "repo-launcher" ]]; then
    install_launcher
else
    install_binary
fi

# Short alias: symlink first, hard-link fallback; both names resolve together.
alias_tmp=$(mktemp "${INSTALL_DIR}/.${ALIAS}.install.XXXXXX") || die "could not stage alias."
rm -f -- "$alias_tmp"
if ! ln -s "$COMMAND" "$alias_tmp" 2>/dev/null; then
    if ! ln -- "${INSTALL_DIR}/${COMMAND}" "$alias_tmp" 2>/dev/null; then
        rm -f -- "$alias_tmp"
        warn "could not create ${ALIAS} alias; ${COMMAND} is installed."
        alias_tmp=""
    fi
fi
if [[ -n "$alias_tmp" ]]; then
    mv -f -- "$alias_tmp" "${INSTALL_DIR}/${ALIAS}" || { rm -f -- "$alias_tmp"; warn "could not activate ${ALIAS}."; }
fi

# ------------------------------------------------------------------- PATH --
add_to_path() {
    local config_file=$1 line=$2
    if grep -Fq "$line" "$config_file" 2>/dev/null; then
        return 0
    fi
    if [[ -w "$config_file" ]]; then
        printf '\n# HorizonCode CLI\n%s\n' "$line" >> "$config_file"
        return 0
    fi
    info "Add this to your shell configuration: $line"
}

if [[ "$no_modify_path" != true && ":${PATH:-}:" != *":${INSTALL_DIR}:"* ]]; then
    XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
    current_shell=$(basename "${SHELL:-sh}")
    case "$current_shell" in
        fish) config_files=("$HOME/.config/fish/config.fish") ;;
        zsh) config_files=("${ZDOTDIR:-$HOME}/.zshrc" "${ZDOTDIR:-$HOME}/.zshenv" "$XDG_CONFIG_HOME/zsh/.zshrc") ;;
        bash) config_files=("$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile") ;;
        *) config_files=("$HOME/.bashrc" "$HOME/.profile") ;;
    esac
    config_file=""
    for file in "${config_files[@]}"; do
        if [[ -f "$file" ]]; then config_file="$file"; break; fi
    done
    if [[ -n "$config_file" ]]; then
        case "$current_shell" in
            fish) add_to_path "$config_file" "fish_add_path '${INSTALL_DIR}'" ;;
            *) add_to_path "$config_file" "export PATH='${INSTALL_DIR}':\$PATH" ;;
        esac
    else
        info "Add ${INSTALL_DIR} to PATH in your shell configuration."
    fi
fi

# --------------------------------------------------------------- post-check --
[[ -x "${INSTALL_DIR}/${COMMAND}" ]] || die "post-install verification failed: ${INSTALL_DIR}/${COMMAND} is not executable."
if [[ "$mode" != "repo-launcher" ]]; then
    final_sha=$(compute_sha256 "${INSTALL_DIR}/${COMMAND}") || die "post-install digest could not be computed."
    [[ "$final_sha" == "$candidate_sha" ]] || die "post-install digest mismatch; installation is inconsistent."
fi

ok "Installed HorizonCode (${mode}) in ${INSTALL_DIR}"
info "Both '${COMMAND}' and '${ALIAS}' start the same CLI."
if [[ "$mode" == "remote" ]]; then
    warn "This install used the UNSIGNED remote path (signing deferred, DEC-V1-12)."
fi
info "Verify with: ${INSTALL_DIR}/${COMMAND} --version"
