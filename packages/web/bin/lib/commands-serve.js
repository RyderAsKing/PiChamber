import fs from 'fs';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { buildLocalUrl, resolveServeHost, assertSafeBrowserPort, resolveServeUiPassword, assertAuthenticatedNetworkExposure } from './cli-network.js';
import { fetchSystemInfoFromPort } from './cli-http.js';
import { isPortAvailable, resolveAvailablePort } from './cli-ports.js';
import { ensureLogsDir, getLogFilePath } from './cli-paths.js';
import { rotateLogFile } from './cli-log-files.js';
import { discoverPiChamberInstanceOnPort, isDesktopRuntimeForPort } from './cli-lifecycle.js';
import { getPidFilePath, getInstanceFilePath, writePidFile, writeInstanceOptions, removePidFile, removeInstanceFile, isProcessRunning, terminateProcessTree } from './cli-process.js';
import { isNetworkExposedBindHost } from '../../server/lib/security/bind-host.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  cancel as clackCancel,
  isCancel,
  select,
  text,
  password as passwordPrompt,
  confirm,
  canPrompt,
  isJsonMode,
  isQuietMode,
  shouldRenderHumanOutput,
  createSpinner,
  printJson,
  logStatus,
} from '../cli-output.js';

const DAEMON_READY_TIMEOUT_MS = 30000;
const servePromptApi = { select, text, password: passwordPrompt, confirm, isCancel, cancel: clackCancel };

function hasExplicitServeConfiguration(options) {
  return options.explicitPort === true
    || options.lan === true
    || typeof options.host === 'string'
    || options.explicitUiPassword === true
    || options.apiOnly === true
    || options.foreground === true;
}

async function collectInteractiveServeOptions(options, prompts = servePromptApi) {
  const ask = async (method, config) => {
    const answer = await prompts[method](config);
    if (prompts.isCancel(answer)) {
      prompts.cancel('Server setup cancelled.');
      return { cancelled: true };
    }
    return { answer };
  };

  const accessResult = await ask('select', {
    message: 'Where should PiChamber be accessible?',
    options: [
      { value: 'local', label: 'This machine only', hint: 'recommended' },
      { value: 'lan', label: 'Local network', hint: 'other devices on your LAN or Wi-Fi' },
      { value: 'custom', label: 'Custom bind address' },
    ],
    initialValue: 'local',
  });
  if (accessResult.cancelled) return null;

  let host = '127.0.0.1';
  let lan = false;
  if (accessResult.answer === 'lan') {
    host = '0.0.0.0';
    lan = true;
  } else if (accessResult.answer === 'custom') {
    const hostResult = await ask('text', {
      message: 'Bind address',
      initialValue: '127.0.0.1',
      validate: (value) => String(value ?? '').trim() ? undefined : 'Enter a bind address.',
    });
    if (hostResult.cancelled) return null;
    host = String(hostResult.answer).trim();
  }

  const portResult = await ask('text', {
    message: 'Port',
    initialValue: String(options.port),
    validate: (value) => {
      const normalized = String(value ?? '').trim();
      if (!/^\d+$/.test(normalized)) return 'Enter a port from 0 to 65535.';
      const port = Number(normalized);
      return port >= 0 && port <= 65535 ? undefined : 'Enter a port from 0 to 65535.';
    },
  });
  if (portResult.cancelled) return null;
  const port = Number(String(portResult.answer).trim());

  const networkExposed = accessResult.answer !== 'local';
  const authResult = await ask('select', {
    message: networkExposed ? 'Choose a required UI password' : 'Protect the UI with a password?',
    options: [
      { value: 'enter', label: 'Enter a password' },
      { value: 'generate', label: 'Generate a secure password' },
      ...(!networkExposed ? [{ value: 'none', label: 'No password', hint: 'local access only' }] : []),
    ],
    initialValue: networkExposed ? 'generate' : 'none',
  });
  if (authResult.cancelled) return null;

  let uiPassword;
  let explicitUiPassword = false;
  if (authResult.answer === 'enter') {
    const passwordResult = await ask('password', {
      message: 'UI password',
      validate: (value) => String(value ?? '').length ? undefined : 'Enter a password.',
    });
    if (passwordResult.cancelled) return null;
    uiPassword = String(passwordResult.answer);
    const confirmationResult = await ask('password', {
      message: 'Confirm UI password',
      validate: (value) => value === uiPassword ? undefined : 'Passwords do not match.',
    });
    if (confirmationResult.cancelled) return null;
    explicitUiPassword = true;
  } else if (authResult.answer === 'generate') {
    uiPassword = '';
    explicitUiPassword = true;
  }

  const contentResult = await ask('select', {
    message: 'What should this server provide?',
    options: [
      { value: 'ui', label: 'Browser UI and API', hint: 'recommended' },
      { value: 'api', label: 'API only', hint: 'for paired clients' },
    ],
    initialValue: 'ui',
  });
  if (contentResult.cancelled) return null;

  const processResult = await ask('select', {
    message: 'How should the server run?',
    options: [
      { value: 'daemon', label: 'In the background', hint: 'recommended' },
      { value: 'foreground', label: 'In the foreground', hint: 'for process managers' },
    ],
    initialValue: 'daemon',
  });
  if (processResult.cancelled) return null;

  logStatus('info', 'Review server', [
    `Access: ${accessResult.answer === 'local' ? 'this machine only' : host}`,
    `Port: ${port === 0 ? 'automatic' : port}`,
    `Authentication: ${authResult.answer === 'none' ? 'disabled' : authResult.answer === 'generate' ? 'generated password' : 'enabled'}`,
    `Content: ${contentResult.answer === 'api' ? 'API only' : 'browser UI and API'}`,
    `Process: ${processResult.answer === 'foreground' ? 'foreground' : 'background'}`,
  ].join('\n'));

  const confirmResult = await ask('confirm', { message: 'Start this server?', initialValue: true });
  if (confirmResult.cancelled) return null;
  if (confirmResult.answer !== true) {
    prompts.cancel('Server setup cancelled.');
    return null;
  }

  return {
    ...options,
    host,
    lan,
    port,
    explicitPort: true,
    uiPassword,
    explicitUiPassword,
    apiOnly: contentResult.answer === 'api',
    foreground: processResult.answer === 'foreground',
  };
}

function createServeCommand({
  serverPath,
  bunBin,
  getPreferredServerRuntime,
  setForegroundServerActive,
  setForegroundShutdown,
}) {
async function serveCommand(options) {
    let usedInteractiveSetup = false;
    if (options.offerInteractiveSetup === true && canPrompt(options) && !hasExplicitServeConfiguration(options)) {
      clackIntro('PiChamber Server Setup');
      const resolvedOptions = await collectInteractiveServeOptions(options);
      if (!resolvedOptions) return;
      options = resolvedOptions;
      usedInteractiveSetup = true;
    }

    const showOutput = shouldRenderHumanOutput(options);
    const jsonMessages = [];
    const emitNotice = (notice) => {
      if (!notice || typeof notice !== 'object' || typeof notice.message !== 'string') return;
      const level = notice.level === 'error' ? 'error' : (notice.level === 'warning' ? 'warning' : 'info');

      if (isJsonMode(options)) {
        jsonMessages.push({
          level,
          code: notice.code,
          message: notice.message,
        });
        return;
      }

      if (showOutput) {
        logStatus(level, notice.message);
        return;
      }

      if (!isQuietMode(options)) {
        const prefix = level === 'warning' ? 'Warning' : level === 'error' ? 'Error' : 'Info';
        const line = `${prefix}: ${notice.message}`;
        if (level === 'error') {
          console.error(line);
        } else {
          console.warn(line);
        }
      }
    };
    const explicitPort = options.explicitPort === true;
    const effectiveHost = resolveServeHost(options.host);
    const targetPort = await resolveAvailablePort(options.port, explicitPort, emitNotice);

    if (targetPort !== 0 && !options.suppressUnsafePortWarning) {
      assertSafeBrowserPort(targetPort, { context: 'PiChamber serve' });
    }

    if (targetPort !== 0) {
      const existingInstance = await discoverPiChamberInstanceOnPort(targetPort, { host: effectiveHost });
      if (existingInstance?.runtime === 'desktop') {
        throw new Error(
          `Port ${targetPort} is used by PiChamber Desktop app. Choose another port or stop the desktop app.`
        );
      }
      if (existingInstance) {
        const pidSuffix = Number.isFinite(existingInstance.pid) ? ` (PID: ${existingInstance.pid})` : '';
        if (existingInstance.source === 'probe') {
          throw new Error(`PiChamber is already running on port ${targetPort}. Use \`pichamber status\` or \`pichamber stop --port ${targetPort}\`.`);
        }
        throw new Error(`PiChamber is already running on port ${targetPort}${pidSuffix}`);
      }

      if (explicitPort && !(await isPortAvailable(targetPort, effectiveHost))) {
        const systemInfo = await fetchSystemInfoFromPort(targetPort, globalThis.fetch, effectiveHost);
        if (isDesktopRuntimeForPort(systemInfo, targetPort)) {
          throw new Error(
            `Port ${targetPort} is used by PiChamber Desktop app. Choose another port or stop the desktop app.`
          );
        }
        const systemInfoRuntimeMatchesPort = systemInfo?.runtime !== 'desktop' || isDesktopRuntimeForPort(systemInfo, targetPort);
        if (systemInfo?.runtime && systemInfoRuntimeMatchesPort) {
          throw new Error(`PiChamber is already running on port ${targetPort}. Use \`pichamber status\` or \`pichamber stop --port ${targetPort}\`.`);
        }
        throw new Error(`Port ${targetPort} is already in use by another process.`);
      }
    }

    const preferredRuntime = getPreferredServerRuntime();
    const runtimeBin = preferredRuntime === 'bun' ? bunBin : process.execPath;

    ensureLogsDir();
    const initialLogPort = targetPort === 0 ? 'auto' : String(targetPort);
    const initialLogPath = getLogFilePath(initialLogPort);
    rotateLogFile(initialLogPath);
    const logFd = fs.openSync(initialLogPath, 'a');

    // Resolve the effective UI password before either launch path so a
    // password generated for `--ui-password` (no value) is set in the
    // daemon/foreground environment before spawning and persisted in the
    // instance state file the server and restart/status flows read.
    const resolvedUiPassword = resolveServeUiPassword(options);
    const effectiveUiPassword = resolvedUiPassword.password;
    const autoGeneratedUiPassword = resolvedUiPassword.generated === true;
    assertAuthenticatedNetworkExposure({
      host: effectiveHost,
      uiPassword: effectiveUiPassword,
    });
    if (!effectiveUiPassword && !options.suppressUiPasswordWarning) {
      const bindHost = effectiveHost;
      const networkExposed = isNetworkExposedBindHost(bindHost);
      const warningLine = 'PICHAMBER_UI_PASSWORD is not set';
      const warningDetail = networkExposed
        ? `server is bound to ${bindHost} and reachable on your network with no UI auth. `
          + 'Set --ui-password or PICHAMBER_UI_PASSWORD before exposing it over LAN.'
        : 'browser UI is unsecured. Use --ui-password or PICHAMBER_UI_PASSWORD.';
      if (showOutput) {
        logStatus('warning', warningLine, warningDetail);
      } else if (isJsonMode(options)) {
        emitNotice({
          level: 'warning',
          code: 'UI_PASSWORD_MISSING',
          message: `${warningLine}; ${warningDetail}`,
        });
      } else if (!isQuietMode(options)) {
        console.warn(`Warning: ${warningLine}; ${warningDetail}`);
      }
    }
    // Foreground mode: run server inline so the CLI process is the server process.
    // Required for process managers like systemd (Type=simple) that track the
    // direct child rather than a detached grandchild.
    // IMPORTANT: foreground MUST remain inline (in-process). Do not convert to
    // child-process orchestration — that causes shell job-control suspension.
    if (options.foreground) {
      if (isJsonMode(options)) {
        throw new TunnelCliError(
          '--json is not supported with --foreground. Use --json with background (daemon) mode instead.',
          EXIT_CODE.USAGE_ERROR
        );
      }

      // Propagate resolved values into env before importing the server module.
      if (effectiveUiPassword) {
        process.env.PICHAMBER_UI_PASSWORD = effectiveUiPassword;
      }
      process.env.PICHAMBER_HOST = effectiveHost;
      process.env.PICHAMBER_RUNTIME = 'web';

      // In --quiet mode, redirect stdout/stderr to the log file so that
      // server runtime output (console.log calls) does not pollute the
      // deterministic CLI output contract.  In plain human mode, close the
      // log fd and let output go to the inherited terminal as before.
      const suppressServerOutput = isQuietMode(options);
      // Keep a reference to the real stdout.write so CLI output (port, JSON)
      // can bypass the log-file redirect.
      const realStdoutWrite = process.stdout.write.bind(process.stdout);
      if (suppressServerOutput) {
        const logStream = fs.createWriteStream(null, { fd: logFd });
        process.stdout.write = (chunk, encoding, callback) => {
          return logStream.write(chunk, encoding, callback);
        };
        process.stderr.write = (chunk, encoding, callback) => {
          return logStream.write(chunk, encoding, callback);
        };
      } else {
        // Close the log fd – in foreground human mode stdout/stderr are
        // inherited from the parent (e.g. journald/terminal).
        try {
          fs.closeSync(logFd);
        } catch {
        }
      }

      if (!isQuietMode(options)) {
        console.log(`Starting PiChamber on port ${targetPort === 0 ? 'auto' : targetPort} (foreground)`);
      }

      const { startWebUiServer } = await import(pathToFileURL(serverPath).href);
      const controller = await startWebUiServer({
        port: targetPort,
        host: effectiveHost,
        uiPassword: effectiveUiPassword,
        apiOnly: options.apiOnly === true,
        attachSignals: false,
        exitOnShutdown: false,
      });

      const resolvedPort = controller.getPort();

      // Write PID / instance files so status, stop, and restart can discover
      // this foreground instance the same way they discover daemon instances.
      const fgPidFilePath = await getPidFilePath(resolvedPort);
      const fgInstanceFilePath = await getInstanceFilePath(resolvedPort);
      writePidFile(fgPidFilePath, process.pid, emitNotice);
      writeInstanceOptions(fgInstanceFilePath, {
        port: resolvedPort,
        host: effectiveHost,
        launchMode: 'foreground',
        uiPassword: effectiveUiPassword,
        apiOnly: options.apiOnly === true,
      }, emitNotice);

      if (isQuietMode(options)) {
        if (!options.suppressQuietOutput) {
          realStdoutWrite(
            autoGeneratedUiPassword
              ? `${resolvedPort} pass:${effectiveUiPassword}\n`
              : `${resolvedPort}\n`
          );
        }
      } else if (usedInteractiveSetup && showOutput && !options.suppressStartupSummary) {
        logStatus('success', `port ${resolvedPort} (foreground)`);
        if (autoGeneratedUiPassword) {
          logStatus('success', 'UI password', effectiveUiPassword);
          logStatus('warning', 'save this password', 'it is not shown again');
        }
        logStatus('info', `visit: ${buildLocalUrl(resolvedPort, '/')}`);
        logStatus('info', `logs: pichamber logs -p ${resolvedPort}`);
        clackOutro('server running; press Ctrl+C to stop');
      } else if (autoGeneratedUiPassword && showOutput && !options.suppressStartupSummary) {
        console.log(`Generated UI password: ${effectiveUiPassword}`);
        console.log('Save this password — it is not shown again.');
      }

      // Clean up PID / instance files.
      const cleanupFiles = () => {
        removePidFile(fgPidFilePath);
        removeInstanceFile(fgInstanceFilePath);
      };

      process.on('exit', cleanupFiles);

      // Idempotent graceful shutdown with deterministic exit codes.
      let shutdownInProgress = false;
      const shutdownForegroundServer = async (signal = 'SIGTERM') => {
        if (shutdownInProgress) return;
        shutdownInProgress = true;
        try {
          await controller.stop({ exitProcess: false });
        } catch {
        }
        cleanupFiles();
        setForegroundServerActive(false);
        setForegroundShutdown(null);
        const exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGQUIT' ? 131 : 143;
        process.exit(exitCode);
      };

      // Expose shutdown to the global SIGINT handler.
      setForegroundShutdown(shutdownForegroundServer);
      setForegroundServerActive(true);

      // Register signal handlers (additive, no removeAllListeners).
      process.on('SIGINT', () => { void shutdownForegroundServer('SIGINT'); });
      process.on('SIGTERM', () => { void shutdownForegroundServer('SIGTERM'); });
      process.on('SIGQUIT', () => { void shutdownForegroundServer('SIGQUIT'); });

      // Block forever – the process stays alive until signalled.
      await new Promise(() => {});
    }

    const serverArgs = [serverPath, '--port', String(targetPort)];
    serverArgs.push('--host', effectiveHost);
    if (options.apiOnly === true) {
      serverArgs.push('--api-only');
    }

    const serveSpin = showOutput ? createSpinner(options) : null;

    const child = spawn(runtimeBin, serverArgs, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd, 'ipc'],
      env: {
        ...process.env,
        PICHAMBER_PORT: String(targetPort),
        PICHAMBER_RUNTIME: 'web',
        PICHAMBER_HOST: effectiveHost,
        ...(effectiveUiPassword
          ? { PICHAMBER_UI_PASSWORD: effectiveUiPassword }
          : {}),
        ...(options.apiOnly === true ? { PICHAMBER_API_ONLY: 'true' } : {}),
      },
    });

    child.unref();
    serveSpin?.start(`Starting PiChamber on port ${targetPort === 0 ? 'auto' : targetPort}...`);

    let resolvedPort;
    try {
      resolvedPort = await new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(`PiChamber daemon did not report ready within ${DAEMON_READY_TIMEOUT_MS / 1000}s`));
        }, DAEMON_READY_TIMEOUT_MS);

        child.on('message', (msg) => {
          if (settled) return;
          if (msg && msg.type === 'pichamber:ready' && typeof msg.port === 'number') {
            settled = true;
            clearTimeout(timeout);
            resolve(msg.port);
          }
        });

        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(error);
        });

        child.on('exit', (code, signal) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`PiChamber daemon exited before reporting ready${signal ? ` (${signal})` : ` (code ${code ?? 'unknown'})`}`));
        });
      });
    } catch (error) {
      await terminateProcessTree(child.pid, { gracefulTimeoutMs: 1500, forceTimeoutMs: 1500 });
      throw error;
    }

    try {
      if (typeof child.disconnect === 'function' && child.connected) {
        child.disconnect();
      }
    } catch {
    }

    try {
      fs.closeSync(logFd);
    } catch {
    }

    const resolvedLogPath = getLogFilePath(resolvedPort);
    if (initialLogPath !== resolvedLogPath && !fs.existsSync(resolvedLogPath)) {
      try {
        fs.renameSync(initialLogPath, resolvedLogPath);
      } catch {
      }
    }

    if (!isProcessRunning(child.pid)) {
      serveSpin?.error('Failed to start PiChamber');
      throw new Error('Failed to start server in daemon mode');
    }

    const pidFilePath = await getPidFilePath(resolvedPort);
    const instanceFilePath = await getInstanceFilePath(resolvedPort);
    writePidFile(pidFilePath, child.pid, emitNotice);
    writeInstanceOptions(instanceFilePath, {
      port: resolvedPort,
      host: effectiveHost,
      launchMode: 'daemon',
      uiPassword: effectiveUiPassword,
      apiOnly: options.apiOnly === true,
    }, emitNotice);

    const serveResult = {
      port: resolvedPort,
      pid: child.pid,
      url: buildLocalUrl(resolvedPort, '/'),
      logs: `pichamber logs -p ${resolvedPort}`,
      launchMode: 'daemon',
    };

    if (isJsonMode(options)) {
      printJson({
        ...serveResult,
        messages: jsonMessages,
        ...(autoGeneratedUiPassword ? { password: effectiveUiPassword } : {}),
      });
      return resolvedPort;
    }

    if (isQuietMode(options)) {
      if (options.suppressQuietOutput) {
        return resolvedPort;
      }
      // A generated password is essential result data for scripts: include it
      // in the same compact `pass:` token form `pichamber status --quiet`
      // already emits. Configured passwords are never echoed.
      process.stdout.write(
        autoGeneratedUiPassword
          ? `${resolvedPort} pass:${effectiveUiPassword}\n`
          : `${resolvedPort}\n`
      );
      return resolvedPort;
    }

    serveSpin?.clear();

    if (!options.suppressStartupSummary && showOutput) {
      if (!usedInteractiveSetup) clackIntro('PiChamber Started');
      logStatus('success', `port ${serveResult.port} (PID: ${serveResult.pid})`);
      if (autoGeneratedUiPassword) {
        logStatus('success', 'UI password', effectiveUiPassword);
        logStatus('warning', 'save this password', 'it is not shown again');
      }
      logStatus('info', `visit: ${serveResult.url}`);
      logStatus('info', `logs: ${serveResult.logs}`);
      clackOutro('daemon running');
    }

    return resolvedPort;
}

  return serveCommand;
}

export { createServeCommand, collectInteractiveServeOptions, hasExplicitServeConfiguration };
