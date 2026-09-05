import fs from 'fs';
import { EXIT_CODE } from './cli-errors.js';
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
  cancel as clackCancel,
  confirm,
  isCancel,
  canPrompt,
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
  discoverInstances = discoverRunningInstances,
  requestShutdown = requestServerShutdown,
  stopProcess = stopInstanceProcess,
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

    const latestVersion = updateInfo.version || 'latest';
    const startupServiceActive = isUserStartupServiceActive();
    const runningInstances = startupServiceActive ? [] : await discoverInstances();

    if (canPrompt(options) && options.yes !== true) {
      updateSpin?.clear();
      logStatus('info', 'Review update', [
        `Version: ${currentVersion} -> ${latestVersion}`,
        `Package manager: ${pm}`,
        startupServiceActive
          ? 'Restart: startup service'
          : `Restart: ${runningInstances.length} running instance(s)`,
      ].join('\n'));
      const approved = await confirm({
        message: `Install PiChamber ${latestVersion}?`,
        initialValue: true,
      });
      if (isCancel(approved) || approved !== true) {
        clackCancel('Update cancelled.');
        return;
      }
    }

    if (showOutput && !updateSpin) {
      logStatus('info', `updating ${currentVersion} -> ${latestVersion} with ${pm}`);
    }
    updateSpin?.start(`Updating ${currentVersion} -> ${latestVersion}...`);

    const result = executeUpdate(pm, { silent: isJsonMode(options) || isQuietMode(options) });
    if (!result.success) {
      updateSpin?.error('Update failed');
      if (showOutput) {
        clackOutro('update failed');
      }
      throw new Error(`Update failed with exit code ${result.exitCode}`);
    }

    const installedVersion = getCurrentVersion();
    const restartResults = [];
    let startupServiceRestarted = false;

    if (startupServiceActive) {
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
    } else if (runningInstances.length > 0) {
      updateSpin?.message(`Restarting ${runningInstances.length} running instance(s)...`);
      for (const instance of runningInstances) {
        const storedOptions = readInstanceOptions(instance.instanceFilePath) || { port: instance.port };
        if (storedOptions.launchMode === 'foreground') {
          restartResults.push({ port: instance.port, ok: false, reason: 'foreground-restart-required' });
          continue;
        }
        try {
          const requested = await requestShutdown(instance.port, instance.host);
          const stopped = await stopProcess(instance.pid, {
            shutdownWaitMs: requested ? 5000 : 0,
            gracefulTimeoutMs: 2500,
            forceTimeoutMs: 3000,
          });
          if (!stopped) {
            restartResults.push({ port: instance.port, ok: false, reason: 'stop-failed' });
            continue;
          }
          removePidFile(instance.pidFilePath);
          const restartedPort = await serveCommand({
            port: storedOptions.port || instance.port,
            host: storedOptions.host,
            explicitPort: true,
            uiPassword: storedOptions.uiPassword,
            apiOnly: storedOptions.apiOnly === true,
            suppressStartupSummary: true,
            suppressUiPasswordWarning: true,
            suppressQuietOutput: true,
            quiet: true,
          });
          restartResults.push({ port: instance.port, restartedPort, ok: true });
        } catch (error) {
          restartResults.push({
            port: instance.port,
            ok: false,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const restartedCount = restartResults.filter((entry) => entry.ok).length;
    const failedRestartCount = restartResults.length - restartedCount;
    const versionVerified = latestVersion === 'latest' || installedVersion === latestVersion;
    const messages = [];
    if (!versionVerified) {
      messages.push({
        level: 'warning',
        code: 'VERSION_MISMATCH',
        message: `Package manager completed, but this install reports ${installedVersion} instead of ${latestVersion}.`,
      });
    }
    if (failedRestartCount > 0) {
      messages.push({
        level: 'warning',
        code: 'RESTART_PARTIAL',
        message: `${failedRestartCount} running instance(s) require manual restart.`,
      });
    }

    updateSpin?.clear();
    const exitCode = messages.length > 0 ? EXIT_CODE.GENERAL_ERROR : EXIT_CODE.SUCCESS;
    const resultPayload = {
      status: messages.length > 0 ? 'warning' : 'ok',
      previousVersion: currentVersion,
      currentVersion: installedVersion,
      latestVersion,
      versionVerified,
      updated: installedVersion !== currentVersion || versionVerified,
      packageManager: pm,
      restartedCount,
      startupServiceRestarted,
      restartResults,
      messages,
    };
    if (isJsonMode(options)) {
      printJson(resultPayload);
      return { exitCode };
    }
    if (showOutput) {
      logStatus(versionVerified ? 'success' : 'warning', `version ${currentVersion} -> ${installedVersion}`);
      for (const message of messages) {
        logStatus('warning', `[${message.code}]`, message.message);
      }
      clackOutro(messages.length > 0 ? 'update complete with warnings' : 'update complete');
    } else if (isQuietMode(options)) {
      process.stdout.write(`updated ${currentVersion} -> ${installedVersion} restarted:${restartedCount} failed:${failedRestartCount}\n`);
    }
    return { exitCode };
  };
}

export { createUpdateCommand };
