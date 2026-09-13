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
  readUpdateJob as defaultReadUpdateJob,
  updateUpdateJob as defaultUpdateUpdateJob,
} from '../../server/lib/update-job-store.js';
import { createPiUiSettingsStore } from '../../server/lib/pi/ui-settings-store.js';
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

const readConfiguredServerUpdateChannel = async () => {
  const settings = await createPiUiSettingsStore().read();
  return settings.serverUpdateChannel;
};

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
  readUpdateJob = defaultReadUpdateJob,
  updateUpdateJob = defaultUpdateUpdateJob,
  readServerUpdateChannel = readConfiguredServerUpdateChannel,
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
      normalizeServerUpdateChannel,
    } = await importFromFilePath(packageManagerPath);

    let jobId = options.updateJobId;
    const writeJob = async (changes) => {
      if (!jobId) return;
      await updateUpdateJob(jobId, changes);
    };

    try {
    const currentVersion = getCurrentVersion();
    const workerJob = options.updateWorker === true && jobId
      ? await readUpdateJob(jobId)
      : null;
    if (options.updateWorker === true && (!workerJob || !workerJob.targetVersion)) {
      throw new Error('The persisted update job is unavailable.');
    }
    const channel = normalizeServerUpdateChannel(
      workerJob ? workerJob.channel : (options.channel ?? await readServerUpdateChannel()),
    );

    if (showOutput) {
      clackIntro('PiChamber Update');
    }

    if (showOutput && !updateSpin) {
      logStatus('info', `current version: ${currentVersion}`);
    }

    updateSpin?.start('Checking for updates...');

    const updateInfo = workerJob
      ? {
          available: workerJob.targetVersion !== currentVersion,
          version: workerJob.targetVersion,
          currentVersion,
          channel,
        }
      : await checkForUpdates({ channel });
    if (updateInfo.error) {
      updateSpin?.error('Update check failed');
      if (showOutput) {
        clackOutro('update failed');
      }
      throw new Error(updateInfo.error);
    }

    if (!updateInfo.available) {
      await writeJob({ state: 'complete', currentVersion, targetVersion: updateInfo.version || currentVersion });
      if (isJsonMode(options)) {
        printJson({
          currentVersion,
          latestVersion: updateInfo.version || currentVersion,
          channel,
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

    const capability = getUpdateCapability();
    if (!capability.supported) {
      updateSpin?.error('This deployment requires a manual update');
      if (isJsonMode(options)) {
        await writeJob({ state: 'failed', error: capability.error });
        printJson({
          status: 'error',
          currentVersion,
          latestVersion: updateInfo.version || 'latest',
          updated: false,
          code: capability.code,
          error: capability.error,
          channel,
        });
        return { exitCode: EXIT_CODE.GENERAL_ERROR };
      }
      if (showOutput) clackOutro('update skipped');
      throw new Error(capability.error);
    }
    const pm = capability.packageManager;

    if (typeof updateInfo.version !== 'string' || updateInfo.version.length === 0) {
      throw new Error('Update target version is unavailable.');
    }
    const latestVersion = updateInfo.version;
    const startupServiceActive = isUserStartupServiceActive();
    const runningInstances = startupServiceActive ? [] : await discoverInstances();

    if (canPrompt(options) && options.yes !== true) {
      updateSpin?.clear();
      logStatus('info', 'Review update', [
        `Version: ${currentVersion} -> ${latestVersion}`,
        `Channel: ${channel}`,
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
        channel,
        isSystemd: true,
      });
      if (!launched.success) throw new Error(launched.error || 'Could not start the systemd update worker.');
      updateSpin?.clear();
      if (isJsonMode(options)) {
        printJson({
          status: launched.existing ? 'in-progress' : 'started',
          updated: false,
          jobId: launched.jobId,
          previousVersion: currentVersion,
          latestVersion: launched.targetVersion || latestVersion,
          channel: launched.channel || channel,
        });
      } else if (showOutput) {
        logStatus('success', launched.existing ? 'an update is already in progress' : 'systemd update worker started');
        clackOutro(launched.existing ? 'using the existing update job' : 'the server will restart when the update is installed');
      } else if (isQuietMode(options)) {
        process.stdout.write(launched.existing
          ? `update-in-progress job:${launched.jobId}\n`
          : `update-started ${currentVersion} -> ${latestVersion} job:${launched.jobId}\n`);
      }
      return;
    }

    if (!jobId) {
      if (typeof claimUpdateJob !== 'function') throw new Error('Update coordination is unavailable.');
      const claimed = await claimUpdateJob({
        previousVersion: currentVersion,
        targetVersion: latestVersion,
        packageManager: pm,
        channel,
      });
      if (!claimed.created) {
        updateSpin?.clear();
        if (isJsonMode(options)) {
          printJson({
            status: 'in-progress',
            updated: false,
            jobId: claimed.job.id,
            previousVersion: claimed.job.previousVersion || currentVersion,
            latestVersion: claimed.job.targetVersion || latestVersion,
            channel: claimed.job.channel || channel,
          });
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
      channel,
      workerPid: process.pid,
    });

    const result = executeUpdate(pm, {
      silent: isJsonMode(options) || isQuietMode(options),
      targetVersion: latestVersion,
    });
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
    const versionVerified = installedVersion === latestVersion;
    const messages = [];
    if (!versionVerified) {
      messages.push({
        level: 'warning',
        code: 'VERSION_MISMATCH',
        message: `Package manager completed, but this install reports ${installedVersion} instead of ${latestVersion}. Run pichamber update again or reinstall ${latestVersion} before restarting the server.`,
      });
    }

    if (versionVerified && startupServiceActive) {
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
    } else if (versionVerified && runningInstances.length > 0) {
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
      channel,
      versionVerified,
      updated: installedVersion !== currentVersion || versionVerified,
      packageManager: pm,
      restartedCount,
      startupServiceRestarted,
      restartResults,
      messages,
    };
    await writeJob({
      state: messages.length > 0 ? 'failed' : 'complete',
      currentVersion: installedVersion,
      error: messages.length > 0 ? messages.map((message) => message.message).join(' ') : undefined,
    });
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
