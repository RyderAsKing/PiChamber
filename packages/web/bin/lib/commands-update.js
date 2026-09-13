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
  claimUpdateJob as defaultClaimUpdateJob,
  updateUpdateJob as defaultUpdateUpdateJob,
} from '../../server/lib/update-job-store.js';
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

function createUpdateCommand({
  importFromFilePath,
  packageManagerPath,
  serveCommand,
  isInsideSystemdService,
  isUserStartupServiceActive = defaultIsUserStartupServiceActive,
  restartUserStartupService = defaultRestartUserStartupService,
  discoverInstances = discoverRunningInstances,
  requestShutdown = requestServerShutdown,
  stopProcess = stopInstanceProcess,
  claimUpdateJob = defaultClaimUpdateJob,
  updateUpdateJob = defaultUpdateUpdateJob,
}) {
  return async function updateCommand(options = {}) {
    const showOutput = shouldRenderHumanOutput(options);
    const updateSpin = createSpinner(options);

    const {
      checkForUpdates,
      executeUpdate,
      getUpdateCapability,
      getCurrentVersion,
      getInstalledVersion,
      isInsidePiChamberSystemdService,
      launchUpdateCommand,
    } = await importFromFilePath(packageManagerPath);

    let jobId = options.updateJobId;
    const writeJob = async (changes) => {
      if (!jobId) return;
      await updateUpdateJob(jobId, changes);
    };

    try {
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
      await writeJob({ state: 'complete', currentVersion, targetVersion: updateInfo.version || currentVersion });
      return;
    }

    const capability = getUpdateCapability();
    if (!capability.supported) {
      updateSpin?.error('This deployment requires a manual update');
      if (isJsonMode(options)) {
        printJson({
          currentVersion,
          latestVersion: updateInfo.version || 'latest',
          updated: false,
          code: capability.code,
          error: capability.error,
        });
        return;
      }
      if (showOutput) clackOutro('update skipped');
      throw new Error(capability.error);
    }
    const pm = capability.packageManager;

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

    const insideManagedService = typeof isInsideSystemdService === 'function'
      ? isInsideSystemdService()
      : isInsidePiChamberSystemdService?.() === true;
    if (insideManagedService && options.updateWorker !== true) {
      updateSpin?.start('Starting systemd update worker...');
      if (typeof launchUpdateCommand !== 'function') {
        throw new Error('The systemd update worker is unavailable.');
      }
      const launched = await launchUpdateCommand({
        previousVersion: currentVersion,
        targetVersion: latestVersion,
        packageManager: pm,
        isSystemd: true,
      });
      if (!launched.success) throw new Error(launched.error || 'Could not start the systemd update worker.');
      updateSpin?.clear();
      if (isJsonMode(options)) {
        printJson({ status: 'started', updated: false, jobId: launched.jobId, previousVersion: currentVersion, latestVersion });
      } else if (showOutput) {
        logStatus('success', 'systemd update worker started');
        clackOutro('the server will restart when the update is installed');
      } else if (isQuietMode(options)) {
        process.stdout.write(`update-started ${currentVersion} -> ${latestVersion} job:${launched.jobId}\n`);
      }
      return;
    }

    if (!jobId) {
      if (typeof claimUpdateJob !== 'function') throw new Error('Update coordination is unavailable.');
      const claimed = await claimUpdateJob({
        previousVersion: currentVersion,
        targetVersion: latestVersion,
        packageManager: pm,
      });
      if (!claimed.created) {
        updateSpin?.clear();
        if (isJsonMode(options)) {
          printJson({ status: 'in-progress', updated: false, jobId: claimed.job.id, previousVersion: currentVersion, latestVersion });
        } else if (showOutput) {
          logStatus('info', 'another PiChamber update is already in progress');
          clackOutro('update already running');
        } else if (isQuietMode(options)) {
          process.stdout.write(`update-in-progress job:${claimed.job.id}\n`);
        }
        return;
      }
      jobId = claimed.job.id;
    }

    if (showOutput && !updateSpin) {
      logStatus('info', `updating ${currentVersion} -> ${latestVersion} with ${pm}`);
    }
    updateSpin?.start(`Updating ${currentVersion} -> ${latestVersion}...`);
    await writeJob({
      state: 'installing',
      previousVersion: currentVersion,
      targetVersion: latestVersion,
      packageManager: pm,
      workerPid: process.pid,
    });

    const result = executeUpdate(pm, { silent: isJsonMode(options) || isQuietMode(options) });
    if (!result.success) {
      updateSpin?.error('Update failed');
      if (showOutput) {
        clackOutro('update failed');
      }
      throw new Error(`Update failed with exit code ${result.exitCode}`);
    }

    const installedVersion = typeof getInstalledVersion === 'function'
      ? getInstalledVersion(pm)
      : getCurrentVersion();
    await writeJob({ state: 'verifying', currentVersion: installedVersion });
    const restartResults = [];
    let startupServiceRestarted = false;

    if (startupServiceActive) {
      await writeJob({ state: 'restarting' });
      updateSpin?.message('Restarting systemd service...');
      try {
        restartUserStartupService();
        startupServiceRestarted = true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const systemctl = typeof process.getuid === 'function' && process.getuid() === 0
          ? 'systemctl restart pichamber.service'
          : 'systemctl --user restart pichamber.service';
        const msg = `Package updated but failed to restart pichamber.service. Run: ${systemctl} (${detail})`;
        updateSpin?.error('Startup service restart failed');
        if (showOutput) {
          clackOutro('update incomplete');
        }
        throw new Error(msg);
      }
    } else if (runningInstances.length > 0) {
      await writeJob({ state: 'restarting' });
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
    await writeJob({
      state: messages.length > 0 ? 'failed' : 'complete',
      currentVersion: installedVersion,
      error: messages.length > 0 ? messages.map((message) => message.message).join(' ') : undefined,
    });
    return { exitCode };
    } catch (error) {
      try {
        await writeJob({ state: 'failed', error: error instanceof Error ? error.message : String(error) });
      } catch {
        // Preserve the update failure when status persistence also fails.
      }
      throw error;
    }
  };
}

export { createUpdateCommand };
