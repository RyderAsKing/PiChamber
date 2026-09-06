import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TRANSACTION_FILE_NAME = 'linux-appimage-update.json';
const BACKUP_SUFFIX = '.previous';
const TEMP_SUFFIX = '.update.tmp';
const MAX_EXTRACT_MS = 120_000;

const isMissing = (error) => error?.code === 'ENOENT';

const assertAbsolutePath = (value, label) => {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.normalize(value);
};

const defaultExtract = async (appImagePath) => {
  const temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'pichamber-appimage-'));
  try {
    const result = spawnSync(appImagePath, ['--appimage-extract'], {
      cwd: temporaryDirectory,
      stdio: 'ignore',
      timeout: MAX_EXTRACT_MS,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`The downloaded AppImage could not be extracted${result.error ? `: ${result.error.message}` : ''}`);
    }

    const extractedRoot = path.join(temporaryDirectory, 'squashfs-root');
    const indexPath = path.join(extractedRoot, 'resources', 'web-dist', 'index.html');
    const indexInfo = await fsp.stat(indexPath);
    if (!indexInfo.isFile() || indexInfo.size === 0) {
      throw new Error('The downloaded AppImage is missing its packaged UI assets');
    }
    const launcherPath = path.join(extractedRoot, 'pichamber');
    const bundledBinaryPath = path.join(extractedRoot, 'pichamber-bin');
    const launcher = await fsp.readFile(launcherPath, 'utf8');
    const binaryInfo = await fsp.stat(bundledBinaryPath);
    if (!binaryInfo.isFile() || (binaryInfo.mode & 0o111) === 0 || !launcher.includes('--no-sandbox') || !launcher.includes('pichamber-bin')) {
      throw new Error('The downloaded AppImage does not contain the compatible Linux launcher');
    }
  } finally {
    await fsp.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
};

export const validateLinuxAppImage = async ({
  appImagePath,
  stat = fsp.stat,
  extract = defaultExtract,
} = {}) => {
  const candidate = assertAbsolutePath(appImagePath, 'AppImage path');
  let info;
  try {
    info = await stat(candidate);
  } catch {
    throw new Error(`The downloaded AppImage cannot be found at ${candidate}`);
  }
  if (!info.isFile() || info.size <= 0) {
    throw new Error(`The downloaded AppImage is not a valid file at ${candidate}`);
  }
  if ((info.mode & 0o111) === 0) {
    throw new Error(`The downloaded AppImage is not executable at ${candidate}`);
  }

  await extract(candidate);
  return { path: candidate, size: info.size };
};

const readJson = async (filePath, readFile = fsp.readFile) => {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (isMissing(error)) return null;
    throw new Error(`The Linux update recovery record is invalid at ${filePath}`);
  }
};

const writeJsonAtomically = async (filePath, value, {
  writeFile = fsp.writeFile,
  rename = fsp.rename,
} = {}) => {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
};

const resolveTransactionPath = (appDataDirectory) => (
  path.join(assertAbsolutePath(appDataDirectory, 'App data directory'), TRANSACTION_FILE_NAME)
);

const chooseBackupPath = async (currentPath, stat = fsp.stat, now = Date.now) => {
  const base = `${currentPath}${BACKUP_SUFFIX}`;
  try {
    await stat(base);
  } catch (error) {
    if (isMissing(error)) return base;
    throw error;
  }
  return `${base}.${now()}`;
};

const removeIfPresent = async (filePath, rm = fsp.rm) => {
  await rm(filePath, { force: true }).catch((error) => {
    if (!isMissing(error)) throw error;
  });
};

export const installLinuxAppImageUpdate = async ({
  currentPath,
  downloadedPath,
  appDataDirectory,
  version = '',
  validate = validateLinuxAppImage,
  stat = fsp.stat,
  copyFile = fsp.copyFile,
  chmod = fsp.chmod,
  rename = fsp.rename,
  rm = fsp.rm,
  mkdir = fsp.mkdir,
  writeFile = fsp.writeFile,
  now = Date.now,
} = {}) => {
  const current = assertAbsolutePath(currentPath, 'Current AppImage path');
  const downloaded = assertAbsolutePath(downloadedPath, 'Downloaded AppImage path');
  if (current === downloaded) {
    throw new Error('The downloaded update must not be the running AppImage');
  }

  await validate({ appImagePath: downloaded });

  let currentInfo;
  try {
    currentInfo = await stat(current);
  } catch {
    throw new Error(`The running AppImage cannot be found at ${current}`);
  }
  if (!currentInfo.isFile()) {
    throw new Error(`The running AppImage is not a regular file at ${current}`);
  }

  const directory = path.dirname(current);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(current)}-${process.pid}-${now()}${TEMP_SUFFIX}`,
  );
  const backupPath = await chooseBackupPath(current, stat, now);
  const transactionPath = resolveTransactionPath(appDataDirectory);

  await mkdir(directory, { recursive: true });
  await mkdir(path.dirname(transactionPath), { recursive: true });
  await copyFile(downloaded, temporaryPath);
  await chmod(temporaryPath, 0o755);

  const transaction = {
    currentPath: current,
    backupPath,
    version: typeof version === 'string' ? version : '',
    phase: 'staged',
    attempts: 0,
  };
  await writeJsonAtomically(transactionPath, transaction, { writeFile, rename });

  try {
    // Keep the last known-good image until the replacement has started
    // successfully. The final rename below is atomic on the same filesystem,
    // so desktop shortcuts keep pointing at the same path.
    await copyFile(current, backupPath);
    await chmod(backupPath, currentInfo.mode & 0o7777);
    await rename(temporaryPath, current);

    await writeJsonAtomically(transactionPath, {
      ...transaction,
      phase: 'installed',
    }, { writeFile, rename });
  } catch (error) {
    await removeIfPresent(temporaryPath, rm);
    await removeIfPresent(transactionPath, rm);
    throw new Error(`Could not install the downloaded AppImage: ${error instanceof Error ? error.message : error}`);
  }

  return { currentPath: current, backupPath, transactionPath, version: transaction.version };
};

const restoreBackup = async ({
  currentPath,
  backupPath,
  copyFile = fsp.copyFile,
  chmod = fsp.chmod,
  rename = fsp.rename,
  rm = fsp.rm,
  stat = fsp.stat,
  now = Date.now,
} = {}) => {
  const restoreTempPath = `${currentPath}.${process.pid}.${now()}.restore.tmp`;
  const backupInfo = await stat(backupPath);
  await copyFile(backupPath, restoreTempPath);
  await chmod(restoreTempPath, backupInfo.mode & 0o7777);
  await rename(restoreTempPath, currentPath);
  await removeIfPresent(backupPath, rm);
};

export const recoverLinuxAppImageUpdate = async ({
  appImagePath,
  appDataDirectory,
  readFile = fsp.readFile,
  writeFile = fsp.writeFile,
  rename = fsp.rename,
  rm = fsp.rm,
  copyFile = fsp.copyFile,
  chmod = fsp.chmod,
  stat = fsp.stat,
  now = Date.now,
} = {}) => {
  const current = assertAbsolutePath(appImagePath, 'AppImage path');
  const transactionPath = resolveTransactionPath(appDataDirectory);
  const transaction = await readJson(transactionPath, readFile);
  if (!transaction || transaction.currentPath !== current) return { pending: false, recovered: false };

  const backupPath = typeof transaction.backupPath === 'string'
    ? transaction.backupPath
    : `${current}${BACKUP_SUFFIX}`;
  const backupExists = await stat(backupPath).then(() => true).catch((error) => {
    if (isMissing(error)) return false;
    throw error;
  });

  if (!backupExists) {
    await removeIfPresent(transactionPath, rm);
    return { pending: false, recovered: false };
  }

  if (transaction.phase !== 'installed') {
    await restoreBackup({ currentPath: current, backupPath, copyFile, chmod, rename, rm, stat, now });
    await removeIfPresent(transactionPath, rm);
    return { pending: false, recovered: true };
  }

  if (Number(transaction.attempts) > 0) {
    await restoreBackup({ currentPath: current, backupPath, copyFile, chmod, rename, rm, stat, now });
    await removeIfPresent(transactionPath, rm);
    return { pending: false, recovered: true };
  }

  await writeJsonAtomically(transactionPath, {
    ...transaction,
    attempts: 1,
  }, { writeFile, rename });
  return {
    pending: true,
    recovered: false,
    version: typeof transaction.version === 'string' ? transaction.version : '',
  };
};

export const confirmLinuxAppImageUpdate = async ({
  appImagePath,
  appDataDirectory,
  readFile = fsp.readFile,
  rm = fsp.rm,
} = {}) => {
  const current = assertAbsolutePath(appImagePath, 'AppImage path');
  const transactionPath = resolveTransactionPath(appDataDirectory);
  const transaction = await readJson(transactionPath, readFile);
  if (!transaction || transaction.currentPath !== current) return false;

  if (typeof transaction.backupPath === 'string') {
    await removeIfPresent(transaction.backupPath, rm);
  }
  await removeIfPresent(transactionPath, rm);
  return true;
};
