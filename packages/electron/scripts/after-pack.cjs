const fs = require('node:fs');
const path = require('node:path');

const linuxAppImageLauncher = `#!/bin/sh
set -e

BIN_DIR=$(CDPATH= cd -- "$(dirname -- "$(readlink -f -- "$0")")" && pwd)
if [ -n "\${APPDIR:-}" ] || [ -n "\${APPIMAGE:-}" ]; then
  exec "$BIN_DIR/pichamber-bin" --no-sandbox "$@"
fi
case "$BIN_DIR" in
  */.mount_*|*/.mount_*/*|*/squashfs-root|*/squashfs-root/*)
    exec "$BIN_DIR/pichamber-bin" --no-sandbox "$@"
    ;;
esac
exec "$BIN_DIR/pichamber-bin" "$@"
`;

module.exports = (context) => {
  if (context.electronPlatformName === 'linux') {
    const executablePath = path.join(context.appOutDir, context.packager.executableName);
    const bundledBinaryPath = `${executablePath}-bin`;
    if (!fs.existsSync(executablePath)) {
      throw new Error(`Missing packaged Electron executable at ${executablePath}`);
    }
    if (fs.existsSync(bundledBinaryPath)) {
      const existingLauncher = fs.readFileSync(executablePath, 'utf8');
      if (existingLauncher.includes('pichamber-bin')) return;
      throw new Error(`Unexpected duplicate packaged Electron executable at ${bundledBinaryPath}`);
    }
    fs.renameSync(executablePath, bundledBinaryPath);
    fs.writeFileSync(executablePath, linuxAppImageLauncher, { mode: 0o755 });
    fs.chmodSync(executablePath, 0o755);
    fs.chmodSync(bundledBinaryPath, 0o755);
    return;
  }

  if (context.electronPlatformName !== 'darwin') return;

  const resourcesPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources',
  );
  const sourceAssetsPath = path.join(__dirname, '..', 'resources', 'icons', 'Assets.car');

  if (!fs.existsSync(sourceAssetsPath)) {
    throw new Error(`Missing compiled app icon asset catalog at ${sourceAssetsPath}`);
  }

  fs.copyFileSync(sourceAssetsPath, path.join(resourcesPath, 'Assets.car'));
};
