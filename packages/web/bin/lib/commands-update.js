import fs from 'fs';
import { requestServerShutdown } from './cli-http.js';
import { discoverRunningInstances } from './cli-lifecycle.js';
import {
  readInstanceOptions,
  removePidFile,
  stopInstanceProcess,
} from './cli-process.js';
import {
  isUserStartupServiceActive as defaultIsUserStartupServiceActive,
  restartUserStartupService as defaultRestartUserStartupService,
} from './cli-startup.js';
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

const UNOWNED_INSTALL_MESSAGE = [
  'This PiChamber copy is not a global package-manager install.',
  'Install one copy, then update that same copy:',
  '  bun add -g @pi-chamber/web',
  '  npm install -g @pi-chamber/web',
  '  pnpm add -g @pi-chamber/web',
  '  yarn global add @pi-chamber/web',
].join('\n');

function createUpdateCommand({
  importFromFilePath,
  packageManagerPath,
  serveCommand,
  isInsideSystemdService = () => Boolean(process.env.INVOCATION_ID) || Boolean(process.env.PICHAMBER_SYSTEMD_UNIT),
  isUserStartupServiceActive = defaultIsUserStartupServiceActive,
  restartUserStartupService = defaultRestartUserStartupService,
}) {
  return async function updateCommand(options = {}) {
    const showOutput = shouldRenderHumanOutput(options);
    const updateSpin = createSpinner(options);

    const {
      checkForUpdates,
      executeUpdate,
      resolveTrustedUpdatePackageManager,
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

    if (isInsideSystemdService()) {
      const msg = 'pichamber update cannot replace this process while it is running as a systemd service. Run it from a terminal instead.';
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

    const pm = resolveTrustedUpdatePackageManager();
    if (!pm) {
      updateSpin?.error('No global package-manager install');
      if (isJsonMode(options)) {
        printJson({
          currentVersion,
          latestVersion: updateInfo.version || 'latest',
          updated: false,
          error: UNOWNED_INSTALL_MESSAGE,
        });
        return;
      }
      if (showOutput) {
        clackOutro('update skipped');
      }
      throw new Error(UNOWNED_INSTALL_MESSAGE);
    }

    if (showOutput && !updateSpin) {
      logStatus('info', `updating ${updateInfo.currentVersion || currentVersion} -> ${updateInfo.version || 'latest'} with ${pm}`);
    }
    updateSpin?.message(`Updating to ${updateInfo.version || 'latest'}...`);

    const result = executeUpdate(pm, { silent: isJsonMode(options) || isQuietMode(options) });
    if (!result.success) {
      updateSpin?.error('Update failed');
      if (showOutput) {
        clackOutro('update failed');
      }
      throw new Error(`Update failed with exit code ${result.exitCode}`);
    }

    let restartedCount = 0;
    let startupServiceRestarted = false;

    if (isUserStartupServiceActive()) {
      updateSpin?.message('Restarting systemd user service...');
      try {
        restartUserStartupService();
        startupServiceRestarted = true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const msg = `Package updated but failed to restart pichamber.service. Run: systemctl --user restart pichamber.service (${detail})`;
        updateSpin?.error('Startup service restart failed');
        if (showOutput) {
          clackOutro('update incomplete');
        }
        throw new Error(msg);
      }
    } else {
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
        restartedCount = runningInstances.length;
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
        packageManager: pm,
        restartedCount,
        startupServiceRestarted,
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
