import fs from 'fs';
import { requestServerShutdown } from './cli-http.js';
import { discoverRunningInstances } from './cli-lifecycle.js';
import {
  readInstanceOptions,
  removePidFile,
  stopInstanceProcess,
} from './cli-process.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  isJsonMode,
  isQuietMode,
  shouldRenderHumanOutput,
  createSpinner,
  printJson,
  logStatus,
} from '../cli-output.js';

function createUpdateCommand({ importFromFilePath, packageManagerPath, serveCommand }) {
  return async function updateCommand(options = {}) {
    const showOutput = shouldRenderHumanOutput(options);
    const updateSpin = createSpinner(options);

    const {
      checkForUpdates,
      executeUpdate,
      detectPackageManager,
      getCurrentVersion,
    } = await importFromFilePath(packageManagerPath);

    const currentVersion = getCurrentVersion();

    if (showOutput) {
      clackIntro('PiChamber Update');
    }

    if (showOutput && !updateSpin) {
      logStatus('info', `current version: ${currentVersion}`);
    }

    updateSpin?.start('Checking for updates...');

    const updateInfo = await checkForUpdates();
    if (updateInfo.error) {
      updateSpin?.error('Update check failed');
      if (showOutput) {
        clackOutro('update failed');
      }
      throw new Error(updateInfo.error);
    }

    if (!updateInfo.available) {
      if (isJsonMode(options)) {
        printJson({
          currentVersion,
          latestVersion: updateInfo.version || currentVersion,
          updated: false,
        });
        return;
      }
      if (showOutput && !updateSpin) {
        logStatus('success', 'you are running the latest version');
      }
      updateSpin?.stop('Already up to date');
      if (showOutput) {
        clackOutro('no update needed');
      } else if (isQuietMode(options)) {
        process.stdout.write(`up-to-date ${currentVersion}\n`);
      }
      return;
    }

    const isContainer =
      fs.existsSync('/.dockerenv') ||
      Boolean(process.env.CONTAINER) ||
      process.env.container === 'docker';

    if (isContainer) {
      const msg = 'Docker deployments must be updated using container image deployment (e.g. docker pull) rather than in-app replacement.';
      updateSpin?.error('Docker deployment detected');
      if (isJsonMode(options)) {
        printJson({
          currentVersion,
          latestVersion: updateInfo.version || 'latest',
          updated: false,
          error: msg,
        });
        return;
      }
      if (showOutput) {
        clackOutro('update skipped');
      }
      throw new Error(msg);
    }

    const isSystemdService = Boolean(process.env.INVOCATION_ID) || Boolean(process.env.OPENCHAMBER_SYSTEMD_UNIT);
    if (isSystemdService) {
      const msg = 'systemd deployments must be updated through package management and service restart (e.g. systemctl --user restart openchamber.service).';
      updateSpin?.error('systemd service deployment detected');
      if (isJsonMode(options)) {
        printJson({
          currentVersion,
          latestVersion: updateInfo.version || 'latest',
          updated: false,
          error: msg,
        });
        return;
      }
      if (showOutput) {
        clackOutro('update skipped');
      }
      throw new Error(msg);
    }

    if (showOutput && !updateSpin) {
      logStatus('info', `updating ${updateInfo.currentVersion || currentVersion} -> ${updateInfo.version || 'latest'}`);
    }
    updateSpin?.message(`Updating to ${updateInfo.version || 'latest'}...`);

    const pm = detectPackageManager();
    const result = executeUpdate(pm, { silent: isJsonMode(options) || isQuietMode(options) });
    if (!result.success) {
      updateSpin?.error('Update failed');
      if (showOutput) {
        clackOutro('update failed');
      }
      throw new Error(`Update failed with exit code ${result.exitCode}`);
    }

    const runningInstances = await discoverRunningInstances();
    if (runningInstances.length > 0) {
      updateSpin?.message(`Stopping ${runningInstances.length} running instance(s)...`);
      for (const instance of runningInstances) {
        try {
          const requested = await requestServerShutdown(instance.port, instance.host);
          await stopInstanceProcess(instance.pid, {
            shutdownWaitMs: requested ? 5000 : 0,
            gracefulTimeoutMs: 2500,
            forceTimeoutMs: 3000,
          });
          removePidFile(instance.pidFilePath);
        } catch {
        }
      }

      updateSpin?.message(`Restarting ${runningInstances.length} instance(s)...`);
      for (const instance of runningInstances) {
        const storedOptions = readInstanceOptions(instance.instanceFilePath) || { port: instance.port };
        await serveCommand({
          port: storedOptions.port || instance.port,
          host: storedOptions.host,
          explicitPort: true,
          uiPassword: storedOptions.uiPassword,
          suppressStartupSummary: true,
          suppressUiPasswordWarning: true,
          quiet: true,
        });
      }
    }

    if (showOutput && !updateSpin) {
      logStatus('success', `updated to ${updateInfo.version || 'latest'}`);
    }
    updateSpin?.stop(`Updated to ${updateInfo.version || 'latest'}`);
    if (isJsonMode(options)) {
      printJson({
        currentVersion,
        latestVersion: updateInfo.version || 'latest',
        updated: true,
        restartedCount: runningInstances.length,
      });
      return;
    }
    if (showOutput) {
      clackOutro('update complete');
    } else if (isQuietMode(options)) {
      process.stdout.write(`updated ${updateInfo.version || 'latest'}\n`);
    }
  };
}

export { createUpdateCommand };

