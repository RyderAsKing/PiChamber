import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { getStartupStatus, enableStartupService, disableStartupService, formatStartupServeCommand } from './cli-startup.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  isJsonMode,
  isQuietMode,
  printJson,
  logStatus,
} from '../cli-output.js';

async function startupCommand(options, action = 'status') {
  const normalized = typeof action === 'string' ? action.trim().toLowerCase() : 'status';
  if (!['status', 'enable', 'disable'].includes(normalized)) {
    throw new TunnelCliError(
      `Unknown startup subcommand '${action}'. Use 'pichamber startup --help'.`,
      EXIT_CODE.USAGE_ERROR
    );
  }

  let status;
  if (normalized === 'enable') {
    status = enableStartupService(options);
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
  const serveCommand = normalized === 'enable' ? formatStartupServeCommand(options) : undefined;
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
    throw new TunnelCliError(
      'Startup service was installed but failed to start. Run `journalctl --user -u pichamber.service -n 80 --no-pager` for details.',
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

  clackIntro('PiChamber Startup');
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

export { startupCommand };
