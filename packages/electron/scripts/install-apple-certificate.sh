#!/usr/bin/env bash
# Import a Developer ID PKCS#12 into a temporary keychain for electron-builder.
# Never prints certificate material or passwords.
#
# Expects APPLE_CERTIFICATE as whitespace-stripped base64 of a .p12 file, and
# APPLE_CERTIFICATE_PASSWORD as that archive's password.
#
# Writes signed=true|false to GITHUB_OUTPUT. Missing or unreadable certificates
# produce signed=false so the caller can build unsigned macOS artifacts.

set -euo pipefail

OUTPUT_PATH="${GITHUB_OUTPUT:-}"
CERT_PATH="${RUNNER_TEMP:-/tmp}/certificate.p12"
KEYCHAIN_PATH="${RUNNER_TEMP:-/tmp}/electron-signing.keychain-db"

write_signed() {
  if [[ -n "$OUTPUT_PATH" ]]; then
    echo "signed=$1" >> "$OUTPUT_PATH"
  fi
}

fail_unsigned() {
  echo "$1"
  echo "macOS artifacts will be unsigned. To sign and notarize, store a Developer ID Application PKCS#12 as APPLE_CERTIFICATE using:"
  echo "  base64 -i DeveloperID.p12 | pbcopy"
  rm -f "$CERT_PATH"
  write_signed false
  exit 0
}

compact="$(printf '%s' "${APPLE_CERTIFICATE:-}" | tr -d '[:space:]')"

if [[ -z "$compact" ]]; then
  fail_unsigned "APPLE_CERTIFICATE is empty."
fi

if [[ "$compact" == -----BEGIN* ]]; then
  fail_unsigned "APPLE_CERTIFICATE looks like PEM, not a base64-encoded .p12."
fi

if ! printf '%s' "$compact" | base64 --decode > "$CERT_PATH"; then
  fail_unsigned "APPLE_CERTIFICATE is not valid base64."
fi

if [[ ! -s "$CERT_PATH" ]]; then
  fail_unsigned "APPLE_CERTIFICATE decoded to an empty file."
fi

if ! openssl pkcs12 -in "$CERT_PATH" -nokeys -passin "pass:${APPLE_CERTIFICATE_PASSWORD:-}" -out /dev/null; then
  fail_unsigned "APPLE_CERTIFICATE is not a readable PKCS#12 (wrong encoding or password)."
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "PKCS#12 is readable; skipping keychain import off macOS."
  write_signed true
  exit 0
fi

KEYCHAIN_PASSWORD="$(openssl rand -base64 32)"

security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"

if ! security import "$CERT_PATH" \
  -P "${APPLE_CERTIFICATE_PASSWORD:-}" \
  -A -t cert -f pkcs12 \
  -k "$KEYCHAIN_PATH"
then
  fail_unsigned "security could not import APPLE_CERTIFICATE into the signing keychain."
fi

security list-keychain -d user -s "$KEYCHAIN_PATH"
security set-key-partition-list -S apple-tool:,apple:,codesign: \
  -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"

rm -f "$CERT_PATH"
echo "Imported Apple signing certificate."
write_signed true
