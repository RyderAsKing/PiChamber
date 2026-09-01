import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { getStartupStatus, enableStartupService, disableStartupService, formatStartupServeCommand, getStartupServicePaths } from './cli-startup.js';
import { hasUiPasswordConfigured } from './cli-network.js';
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
  printJson,
  logStatus,
} from '../cli-output.js';

const promptApi = { select, text, password: passwordPrompt, confirm, isCancel, cancel: clackCancel };

function validatePort(value) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) return 'Enter a port between 1 and 65535.';
  const port = Number(normalized);
  return port >= 1 && port <= 65535 ? undefined : 'Enter a port between 1 and 65535.';
}

function hasExplicitStartupConfiguration(options) {
  return options.explicitPort === true
    || options.lan === true
    || typeof options.host === 'string'
    || options.explicitUiPassword === true
    || options.apiOnly === true;
}

async function collectInteractiveStartupOptions(options, prompts = promptApi) {
  const ask = async (method, config) => {
    const answer = await prompts[method](config);
    if (prompts.isCancel(answer)) {
      prompts.cancel('Startup setup cancelled.');
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
      placeholder: '127.0.0.1',
      initialValue: '127.0.0.1',
      validate: (value) => String(value ?? '').trim().length > 0 ? undefined : 'Enter a bind address.',
    });
    if (hostResult.cancelled) return null;
    host = String(hostResult.answer).trim();
  }

  const portResult = await ask('text', {
    message: 'Port',
    initialValue: String(options.port),
    validate: validatePort,
  });
  if (portResult.cancelled) return null;
  const port = Number(String(portResult.answer).trim());

  const networkExposed = accessResult.answer !== 'local';
  const configuredPassword = hasUiPasswordConfigured(options.uiPassword);
  const authOptions = [
    ...(configuredPassword ? [{ value: 'configured', label: 'Use the configured password' }] : []),
    { value: 'enter', label: 'Enter a password' },
    { value: 'generate', label: 'Generate a secure password' },
    ...(!networkExposed && !configuredPassword ? [{ value: 'none', label: 'No password', hint: 'local access only' }] : []),
  ];
  const authResult = await ask('select', {
    message: networkExposed ? 'Choose a required UI password' : 'Protect the UI with a password?',
    options: authOptions,
    initialValue: configuredPassword ? 'configured' : (networkExposed ? 'generate' : 'none'),
  });
  if (authResult.cancelled) return null;

  let uiPassword = configuredPassword ? options.uiPassword : undefined;
  let explicitUiPassword = false;
  if (authResult.answer === 'enter') {
    const passwordResult = await ask('password', {
      message: 'UI password',
      validate: (value) => String(value ?? '').length > 0 ? undefined : 'Enter a password.',
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
  } else if (authResult.answer === 'none') {
    uiPassword = undefined;
  }

  const paths = getStartupServicePaths();
  logStatus('info', 'Review startup service', [
    `Access: ${accessResult.answer === 'local' ? 'this machine only' : host}`,
    `Port: ${port}`,
    `Authentication: ${authResult.answer === 'none' ? 'disabled' : authResult.answer === 'generate' ? 'generated password' : 'enabled'}`,
    `Service: ${paths.scope === 'system' ? 'system' : paths.scope === 'user' ? 'user' : paths.platform}`,
  ].join('\n'));

  const confirmResult = await ask('confirm', {
    message: 'Install and start this service?',
    initialValue: true,
  });
  if (confirmResult.cancelled) return null;
  if (confirmResult.answer !== true) {
    prompts.cancel('Startup setup cancelled.');
    return null;
  }

  return {
    ...options,
    port,
    explicitPort: true,
    host,
    lan,
    uiPassword,
    explicitUiPassword,
  };
}

async function startupCommand(options, action = 'status') {
  const normalized = typeof action === 'string' ? action.trim().toLowerCase() : 'status';
  if (!['status', 'enable', 'disable'].includes(normalized)) {
    throw new TunnelCliError(
      `Unknown startup subcommand '${action}'. Use 'pichamber startup --help'.`,
      EXIT_CODE.USAGE_ERROR
    );
  }

  let resolvedOptions = options;
  if (normalized === 'enable' && canPrompt(options) && !hasExplicitStartupConfiguration(options)) {
    clackIntro('PiChamber Startup Setup');
    resolvedOptions = await collectInteractiveStartupOptions(options);
    if (!resolvedOptions) return;
  }

  let status;
  if (normalized === 'enable') {
    status = enableStartupService(resolvedOptions);
  } else if (normalized === 'disable') {
    status = disableStartupService();
  } else {
    status = getStartupStatus();
  }

  const generatedUiPassword = typeof status.generatedUiPassword === 'string' && status.generatedUiPassword.length > 0
    ? status.generatedUiPassword
    : undefined;
  const { generatedUiPassword: _generatedUiPassword, ...publicStatus } = status;
  void _generatedUiPassword;
  const serveCommand = normalized === 'enable' ? formatStartupServeCommand(resolvedOptions) : undefined;
  const result = {
    action: normalized,
    ...publicStatus,
    ...(serveCommand ? { serveCommand } : {}),
    ...(generatedUiPassword ? { password: generatedUiPassword } : {}),
  };
  if (!result.supported) {
    throw new TunnelCliError(
      `Startup integration is not supported on ${result.platform}.`,
      EXIT_CODE.USAGE_ERROR
    );
  }
  if (normalized === 'enable' && result.activeState === 'failed') {
    const journalCommand = result.scope === 'system'
      ? 'journalctl -u pichamber.service -n 80 --no-pager'
      : 'journalctl --user -u pichamber.service -n 80 --no-pager';
    throw new TunnelCliError(
      `Startup service was installed but failed to start. Run \`${journalCommand}\` for details.`,
      EXIT_CODE.GENERAL_ERROR
    );
  }
  if (isJsonMode(options)) {
    printJson(result);
    return;
  }

  if (isQuietMode(options)) {
    process.stdout.write(`startup ${result.enabled ? 'enabled' : 'disabled'} platform:${result.platform} supported:${result.supported ? 'yes' : 'no'}${result.servicePath ? ` path:${result.servicePath}` : ''}${serveCommand ? ` command:${serveCommand}` : ''}${generatedUiPassword ? ` pass:${generatedUiPassword}` : ''}\n`);
    return;
  }

  if (resolvedOptions === options) clackIntro('PiChamber Startup');
  logStatus(result.enabled ? 'success' : 'info', `startup ${result.enabled ? 'enabled' : 'disabled'}`, result.servicePath || undefined);
  if (typeof result.activeState === 'string') {
    logStatus(result.active ? 'success' : result.activeState === 'failed' ? 'error' : 'warning', `service ${result.activeState}`);
  }
  if (serveCommand) {
    logStatus('info', 'service command', serveCommand);
  }
  if (generatedUiPassword) {
    logStatus('success', 'UI password', generatedUiPassword);
    logStatus('warning', 'save this password', 'it is not shown again');
  }
  clackOutro(normalized === 'status' ? 'status complete' : `${normalized} complete`);
}

export { startupCommand, collectInteractiveStartupOptions, hasExplicitStartupConfiguration, validatePort };
