#!/usr/bin/env sh
set -eu

HOME="/home/pichamber"

SSH_DIR="${HOME}/.ssh"
SSH_PRIVATE_KEY_PATH="${SSH_DIR}/id_ed25519"
SSH_PUBLIC_KEY_PATH="${SSH_PRIVATE_KEY_PATH}.pub"

mkdir -p "${SSH_DIR}"
if ! chmod 700 "${SSH_DIR}" 2>/dev/null; then
  echo "[entrypoint] warning: cannot chmod ${SSH_DIR}, continuing with existing permissions"
fi

if [ ! -f "${SSH_PRIVATE_KEY_PATH}" ] || [ ! -f "${SSH_PUBLIC_KEY_PATH}" ]; then
  if [ ! -w "${SSH_DIR}" ]; then
    echo "[entrypoint] warning: ssh key missing and ${SSH_DIR} is not writable, continuing without SSH key" >&2
  else
    echo "[entrypoint] generating SSH key..."
    if ! ssh-keygen -t ed25519 -N "" -f "${SSH_PRIVATE_KEY_PATH}" >/dev/null 2>&1; then
      echo "[entrypoint] warning: failed to generate SSH key, continuing without SSH key" >&2
    fi
  fi
fi

if ! chmod 600 "${SSH_PRIVATE_KEY_PATH}" 2>/dev/null; then
  echo "[entrypoint] warning: cannot chmod ${SSH_PRIVATE_KEY_PATH}, continuing"
fi

if ! chmod 644 "${SSH_PUBLIC_KEY_PATH}" 2>/dev/null; then
  echo "[entrypoint] warning: cannot chmod ${SSH_PUBLIC_KEY_PATH}, continuing"
fi

if [ -f "${SSH_PUBLIC_KEY_PATH}" ]; then
  echo "[entrypoint] SSH public key:"
  cat "${SSH_PUBLIC_KEY_PATH}"
fi

# Handle UI password environment variables. UI_PASSWORD is kept as a legacy
# alias; PICHAMBER_UI_PASSWORD is the canonical runtime variable.
if [ -z "${PICHAMBER_UI_PASSWORD:-}" ] && [ -n "${UI_PASSWORD:-}" ]; then
  PICHAMBER_UI_PASSWORD="$UI_PASSWORD"
  export PICHAMBER_UI_PASSWORD
fi

if [ -n "${PICHAMBER_UI_PASSWORD:-}" ]; then
  echo "[entrypoint] UI password set, enabling authentication"
fi

# Docker containers need to listen on all interfaces for port mapping to work.
PICHAMBER_HOST="${PICHAMBER_HOST:-0.0.0.0}"
export PICHAMBER_HOST

echo "[entrypoint] starting..."

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

set -- bun packages/web/bin/cli.js
if [ -n "${PICHAMBER_UI_PASSWORD:-}" ]; then
  set -- "$@" --ui-password "$PICHAMBER_UI_PASSWORD"
fi
"$@"

exec bun packages/web/bin/cli.js logs
