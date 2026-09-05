#!/usr/bin/env bash
#
# Test the current Electron macOS release path locally.
#
# Windows and Linux packaging run on native GitHub Actions runners. This script
# covers the macOS path that can be exercised on a Mac without release secrets.
#
# Usage:
#   ./scripts/test-release-build.sh [target] [options]
#
# Targets:
#   aarch64, arm64, arm    Build the Apple Silicon target
#   x86_64, intel, x86     Build the Intel target
#   all, both               Build both targets (default)
#
# Options:
#   --no-package, --no-bundle  Stop after compiling and rebuilding native modules
#   --dry-run                  Print commands without running them
#   --verbose, -v             Print shell tracing while commands run
#   --help, -h                Show this help

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ELECTRON_DIR="$REPO_ROOT/packages/electron"

TARGET="all"
NO_PACKAGE=false
DRY_RUN=false
VERBOSE=false

log_info() { printf '%b[INFO]%b %s\n' "$BLUE" "$NC" "$1"; }
log_success() { printf '%b[SUCCESS]%b %s\n' "$GREEN" "$NC" "$1"; }
log_warn() { printf '%b[WARN]%b %s\n' "$YELLOW" "$NC" "$1"; }
log_error() { printf '%b[ERROR]%b %s\n' "$RED" "$NC" "$1" >&2; }
log_step() {
  printf '\n%b============================================================%b\n' "$BLUE" "$NC"
  printf '%b  %s%b\n' "$BLUE" "$1" "$NC"
  printf '%b============================================================%b\n' "$BLUE" "$NC"
}

usage() {
  sed -n '1,30p' "$0"
}

run_root() {
  printf '+ '
  printf '%q ' "$@"
  printf '\n'
  if [[ "$DRY_RUN" != true ]]; then
    "$@"
  fi
}

run_electron() {
  local arch="$1"
  shift
  printf '+ (cd packages/electron && ELECTRON_BUILDER_ARCH=%q CSC_IDENTITY_AUTO_DISCOVERY=false' "$arch"
  printf ' %q' "$@"
  printf ')\n'
  if [[ "$DRY_RUN" != true ]]; then
    (
      cd "$ELECTRON_DIR"
      env ELECTRON_BUILDER_ARCH="$arch" CSC_IDENTITY_AUTO_DISCOVERY=false "$@"
    )
  fi
}

run_electron_common() {
  printf '+ (cd packages/electron &&'
  printf ' %q' "$@"
  printf ')\n'
  if [[ "$DRY_RUN" != true ]]; then
    (
      cd "$ELECTRON_DIR"
      "$@"
    )
  fi
}

check_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log_error "$1 is required"
    return 1
  fi
  log_info "$1: $(command -v "$1")"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    aarch64|arm64|arm)
      TARGET="aarch64"
      shift
      ;;
    x86_64|intel|x86)
      TARGET="x86_64"
      shift
      ;;
    all|both)
      TARGET="all"
      shift
      ;;
    --no-package|--no-bundle)
      NO_PACKAGE=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --verbose|-v)
      VERBOSE=true
      shift
      ;;
    --native)
      # Kept as a harmless compatibility flag for older local instructions.
      shift
      ;;
    --act)
      log_error "--act is not supported for Electron packaging. Use GitHub Actions for CI runner tests."
      exit 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      log_error "Unknown argument: $1"
      usage >&2
      exit 2
      ;;
  esac
done

case "$TARGET" in
  aarch64)
    TARGETS=(arm64)
    ;;
  x86_64)
    TARGETS=(x64)
    ;;
  all)
    TARGETS=(arm64 x64)
    ;;
esac

cd "$REPO_ROOT"
check_command node
check_command bun
VERSION="$(node -p "require('./packages/electron/package.json').version")"

log_step "Electron release build test"
log_info "Repository root: $REPO_ROOT"
log_info "Version: $VERSION"
log_info "Target(s): ${TARGETS[*]}"
log_info "Package installer: $([[ "$NO_PACKAGE" == true ]] && printf 'no' || printf 'yes')"
log_info "Dry run: $DRY_RUN"

if [[ "$VERBOSE" == true ]]; then
  set -x
fi

if [[ "$DRY_RUN" != true && "$(uname -s)" != "Darwin" ]]; then
  log_error "Native macOS Electron packaging must run on macOS. Use the desktop smoke workflow for Windows and Linux."
  exit 1
fi

log_step "Install and validate"
run_root bun install --frozen-lockfile
run_root bun run --cwd packages/electron test:architecture
run_root bun run --cwd packages/electron test:updater
run_electron_common bun run build:web-assets
run_electron_common bun run bundle:main

for arch in "${TARGETS[@]}"; do
  log_step "Build macOS $arch"
  run_electron "$arch" bun run rebuild:native

  if [[ "$NO_PACKAGE" == true ]]; then
    continue
  fi

  run_electron "$arch" bunx electron-builder --mac "--$arch" --publish=never -c.mac.identity=null -c.mac.notarize=false

  if [[ "$DRY_RUN" != true ]]; then
    for extension in dmg zip; do
      artifact="$ELECTRON_DIR/dist/PiChamber-${VERSION}-mac-${arch}.${extension}"
      if [[ ! -s "$artifact" ]]; then
        log_error "Expected artifact was not created: $artifact"
        exit 1
      fi
      log_success "Created $artifact"
    done
  fi
done

log_success "Electron release build test completed"
log_info "Signing and notarization are disabled locally."
log_info "Windows and Linux packaging must be checked on their native CI runners."
