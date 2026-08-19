import { readFile, chmod, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createSessionDaemon } from './session-daemon.js';

const DAEMON_ENTRYPOINT = fileURLToPath(import.meta.url);

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const endpoint = argument('--endpoint');
const credentialFile = argument('--credential-file');
const stateFile = argument('--state-file');
const cwd = argument('--cwd');
const agentDir = argument('--agent-dir');

const exitWithFailure = (code) => {
  // Do not log configuration paths, credentials, or session data from this
  // private process. The parent maps startup failure to a stable error code.
  process.exitCode = code;
};

const chmodIfPossible = async (filePath, mode) => {
  try {
    await chmod(filePath, mode);
  } catch {
    // Windows and some filesystems reject POSIX mode bits; the sidecar must
    // still become the ready/failure record.
  }
};

const writeState = async (state) => {
  const temporaryPath = `${stateFile}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(state), { mode: 0o600 });
  await chmodIfPossible(temporaryPath, 0o600);
  await rename(temporaryPath, stateFile);
  await chmodIfPossible(stateFile, 0o600);
};

const writeReadyState = () => writeState({
  protocolVersion: 1,
  pid: process.pid,
  endpoint,
  entrypoint: DAEMON_ENTRYPOINT,
  startedAt: new Date().toISOString(),
});

const writeFailureState = (code) => writeState({
  protocolVersion: 1,
  pid: process.pid,
  endpoint,
  state: 'failed',
  error: { code },
});

const removeOwnState = async () => {
  try {
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    if (state?.pid === process.pid) await rm(stateFile, { force: true });
  } catch {
    // A missing or malformed state sidecar cannot block daemon shutdown.
  }
};

if (!endpoint || !credentialFile || !stateFile || !cwd) {
  exitWithFailure(64);
} else {
  let daemon;
  let stopping = false;
  try {
    const credential = (await readFile(credentialFile, 'utf8')).trim();
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd,
      ...(agentDir ? { agentDir } : {}),
      healthMetadata: { daemonPid: process.pid },
    });
    await daemon.start();
    await writeReadyState();
  } catch (error) {
    try {
      await daemon?.stop();
    } catch {
      // Process exit closes the local listener if startup cleanup also failed.
    }
    if (error?.code === 'MALFORMED_SESSION_JSONL' || error?.code === 'SESSION_JSONL_UNREADABLE') {
      try {
        await writeFailureState(error.code);
      } catch {
        // The supervisor will report the generic startup failure when the sidecar cannot be written.
      }
    } else {
      await removeOwnState();
    }
    exitWithFailure(1);
  }

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await daemon?.stop();
    } finally {
      await removeOwnState();
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      void stop().finally(() => process.exit(0));
    });
  }
}
