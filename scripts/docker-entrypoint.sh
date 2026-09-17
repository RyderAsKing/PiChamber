#!/usr/bin/env sh
set -eu

HOME="/home/pichamber"

# Docker creates missing bind-mount directories as root. Prepare only the mount
# roots, then permanently drop privileges and capabilities before starting PiChamber.
if [ "$(id -u)" -eq 0 ]; then
  for directory in \
    "${HOME}/.config/pichamber" \
    "${HOME}/.pi/agent" \
    "${HOME}/.ssh" \
    "${HOME}/workspaces"
  do
    mkdir -p "$directory"
    chown 1000:1000 "$directory"
  done

  exec setpriv \
    --reuid=1000 \
    --regid=1000 \
    --init-groups \
    --bounding-set=-all \
    --inh-caps=-all \
    --ambient-caps=-all \
    sh "$0" "$@"
fi

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

# Docker containers need to listen on all interfaces for port mapping to work.
PICHAMBER_HOST="${PICHAMBER_HOST:-0.0.0.0}"
export PICHAMBER_HOST

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

if [ -z "${PICHAMBER_UI_PASSWORD:-}" ]; then
  echo "[entrypoint] PICHAMBER_UI_PASSWORD is required because Docker binds 0.0.0.0." >&2
  echo "[entrypoint] Set it in the environment, then recreate the container." >&2
  exit 1
fi

echo "[entrypoint] UI password is set"
echo "[entrypoint] bind ${PICHAMBER_HOST}:3000; connect through the host port published by Docker"
echo "[entrypoint] config, sessions, SSH keys, and workspaces persist in the mounted volumes"
echo "[entrypoint] starting in foreground..."

# Keep the server as PID 1 so Docker stop/restart signals reach it directly.
# Container stdout and stderr are the log stream; no separate log follower is needed.
exec bun packages/web/bin/cli.js serve \
  --foreground \
  --port 3000 \
  --host "$PICHAMBER_HOST" \
  --ui-password "$PICHAMBER_UI_PASSWORD"
