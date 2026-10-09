import { readInstanceOptions } from './cli-process.js';
import { discoverLifecycleInstances, discoverDesktopInstance } from './cli-lifecycle.js';
import { requestJson } from './cli-http.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  isJsonMode,
  isQuietMode,
  printJson,
  logStatus,
} from '../cli-output.js';

async function statusCommand(options = {}) {
  const [runningInstances, desktopInstance] = options.explicitPort
    ? [await discoverLifecycleInstances(options), null]
    : await Promise.all([
        discoverLifecycleInstances(options),
        discoverDesktopInstance(),
      ]);

  const toPasswordProtectionLabel = (value) => {
    if (value === true) return 'yes';
    if (value === false) return 'no';
    return 'unknown';
  };

  const desktopOnly = desktopInstance && !runningInstances.some((entry) => entry.port === desktopInstance.port)
    ? {
        runtime: 'desktop',
        port: desktopInstance.port,
        pid: Number.isFinite(desktopInstance.pid) ? desktopInstance.pid : null,
        launchMode: null,
        passwordProtected: null,
      }
    : null;

  const cliInstances = await Promise.all(runningInstances
    .filter((instance) => instance.runtime !== 'desktop')
    .map(async (instance) => {
      const storedOptions = instance.instanceFilePath ? (readInstanceOptions(instance.instanceFilePath) || {}) : {};
      const passwordProtected = storedOptions.hasUiPassword === true
        || (typeof storedOptions.uiPassword === 'string' && storedOptions.uiPassword.trim().length > 0);

      // Best-effort Tailscale state per instance: a failure (older server,
      // unreachable) reports unknown rather than failing the whole status.
      let tailscale = null;
      try {
        const { response, body } = await requestJson(instance.port, '/api/pichamber/tailscale/status', { timeoutMs: 1500 });
        if (response.ok && body && typeof body.state === 'string') {
          tailscale = {
            state: body.state,
            ...(typeof body.url === 'string' ? { url: body.url } : {}),
            ...(body.config && typeof body.config.mode === 'string' ? { mode: body.config.mode } : {}),
          };
        }
      } catch {
      }

      return {
        runtime: instance.source === 'probe' ? 'unmanaged' : 'cli',
        port: instance.port,
        pid: instance.pid,
        launchMode: instance.launchMode || 'daemon',
        passwordProtected: instance.source === 'probe' ? null : passwordProtected,
        ...(tailscale ? { tailscale } : {}),
      };
    }));

  const explicitDesktop = options.explicitPort
    ? runningInstances.find((entry) => entry.runtime === 'desktop')
    : null;

  const instances = desktopOnly ? [...cliInstances, desktopOnly] : cliInstances;
  if (explicitDesktop) {
    instances.push({
      runtime: 'desktop',
      port: explicitDesktop.port,
      pid: Number.isFinite(explicitDesktop.pid) ? explicitDesktop.pid : null,
      launchMode: null,
      passwordProtected: null,
    });
  }
  const runningCount = instances.length;

  if (isJsonMode(options)) {
    printJson({
      state: runningCount > 0 ? 'running' : 'stopped',
      runningCount,
      instances,
    });
    return;
  }

  if (isQuietMode(options)) {
    if (runningCount === 0) {
      process.stdout.write('stopped\n');
      return;
    }

    for (const instance of instances) {
      const tailscaleSuffix = instance.tailscale?.state && instance.tailscale.state !== 'off'
        ? ` tailscale:${instance.tailscale.state}${instance.tailscale.url ? `:${instance.tailscale.url}` : ''}`
        : '';
      process.stdout.write(
        `port ${instance.port} mode:${instance.launchMode || 'n/a'} pass:${toPasswordProtectionLabel(instance.passwordProtected)}${tailscaleSuffix}\n`
      );
    }
    return;
  }

  clackIntro('PiChamber Status');

  if (runningCount === 0) {
    logStatus('warning', 'stopped');
    clackOutro('no running instances');
    return;
  }

  for (const instance of instances) {
    const pidSuffix = Number.isFinite(instance.pid) ? ` (PID: ${instance.pid})` : '';
    const modeDetail = instance.launchMode ? `mode: ${instance.launchMode}` : '';
    const protectionDetail = `password: ${toPasswordProtectionLabel(instance.passwordProtected)}`;
    const tailscaleDetail = instance.tailscale?.state && instance.tailscale.state !== 'off'
      ? `tailscale: ${instance.tailscale.state}${instance.tailscale.url ? ` (${instance.tailscale.url})` : ''}`
      : '';
    const detail = [modeDetail, protectionDetail, tailscaleDetail].filter(Boolean).join('; ');
    if (instance.runtime === 'desktop') {
      logStatus('info', `desktop app on port ${instance.port}${pidSuffix}`, detail);
    } else {
      logStatus('success', `port ${instance.port}${pidSuffix}`, detail);
    }
  }

  clackOutro(`${runningCount} running runtime(s)`);
}

export { statusCommand };
