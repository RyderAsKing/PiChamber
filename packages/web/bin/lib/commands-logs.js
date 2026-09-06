import { getDaemonLogFilePath, getLogFilePath } from './cli-paths.js';
import { readTailLines, followFile } from './cli-log-files.js';
import { discoverRunningInstances, getLatestInstance } from './cli-lifecycle.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  isJsonMode,
  isQuietMode,
  shouldRenderHumanOutput,
  printJson,
  logStatus,
} from '../cli-output.js';

async function logsCommand(options) {
  const showFrames = shouldRenderHumanOutput(options);
  const shouldPrefixLines = options.all || (!showFrames && !isQuietMode(options));
  let targets = [];
  const running = await discoverRunningInstances();

  if (options.all) {
    targets = running;
    if (targets.length === 0) {
      throw new Error('No running PiChamber instance found.');
    }
  } else if (options.explicitPort) {
    const found = running.find((entry) => entry.port === options.port);
    if (!found) {
      throw new Error(`No running PiChamber instance found on port ${options.port}.`);
    }
    targets = [found];
  } else {
    const latest = getLatestInstance(running);
    if (!latest) {
      throw new Error('No running PiChamber instance found.');
    }
    targets = [latest];
    if (shouldRenderHumanOutput(options)) {
      logStatus('info', `no port specified; using latest started instance on port ${latest.port}`);
    }
  }

  if (isJsonMode(options)) {
    if (options.follow) {
      throw new Error('`pichamber logs --json` requires `--no-follow` for deterministic JSON output.');
    }
    const entries = targets.map((target) => {
      const logPath = getLogFilePath(target.port);
      const daemonLogPath = getDaemonLogFilePath(target.profileKey);
      return {
        port: target.port,
        logPath,
        lines: readTailLines(logPath, options.lines),
        ...(daemonLogPath ? {
          daemonLogPath,
          daemonLines: readTailLines(daemonLogPath, options.lines),
        } : {}),
      };
    });
    printJson({ entries });
    return;
  }

  if (showFrames) {
    clackIntro('PiChamber Logs');
  }

  for (const target of targets) {
    const logPath = getLogFilePath(target.port);
    const daemonLogPath = getDaemonLogFilePath(target.profileKey);
    const lines = readTailLines(logPath, options.lines);
    const daemonLines = daemonLogPath ? readTailLines(daemonLogPath, options.lines) : [];
    if (showFrames) {
      logStatus('info', `port ${target.port}`, logPath);
      if (daemonLogPath) logStatus('info', 'Pi daemon', daemonLogPath);
    }

    for (const line of lines) {
      if (shouldPrefixLines) {
        console.log(`[${target.port}] ${line}`);
      } else {
        console.log(line);
      }
    }
    for (const line of daemonLines) {
      console.log(shouldPrefixLines ? `[${target.port} daemon] ${line}` : `[daemon] ${line}`);
    }
  }

  if (showFrames) {
    clackOutro(options.follow ? 'following (Ctrl+C to stop)' : 'tail complete');
  }

  if (!options.follow) {
    return;
  }

  const unsubs = targets.flatMap((target) => {
    const logPath = getLogFilePath(target.port);
    const daemonLogPath = getDaemonLogFilePath(target.profileKey);
    const followers = [followFile(logPath, (line) => {
      if (shouldPrefixLines) {
        console.log(`[${target.port}] ${line}`);
      } else {
        console.log(line);
      }
    })];
    if (daemonLogPath) {
      followers.push(followFile(daemonLogPath, (line) => {
        console.log(shouldPrefixLines ? `[${target.port} daemon] ${line}` : `[daemon] ${line}`);
      }));
    }
    return followers;
  });

  await new Promise((resolve) => {
    const onSignal = () => {
      for (const unsub of unsubs) {
        unsub();
      }
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolve();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}

export { logsCommand };
