import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { DEFAULT_PORT } from './cli-args.js';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { getDataDir } from './cli-paths.js';
import { assertAuthenticatedNetworkExposure, hasUiPasswordConfigured, resolveServeUiPassword } from './cli-network.js';

const STARTUP_SERVICE_ID = 'dev.pichamber.web';

const isRootUser = () => typeof process.getuid === 'function' && process.getuid() === 0;

function getStartupServicePaths() {
  if (process.platform === 'darwin') {
    return {
      platform: 'macos',
      servicePath: path.join(os.homedir(), 'Library', 'LaunchAgents', `${STARTUP_SERVICE_ID}.plist`),
    };
  }
  if (process.platform === 'linux') {
    if (isRootUser()) {
      return {
        platform: 'linux',
        servicePath: '/etc/systemd/system/pichamber.service',
        scope: 'system',
      };
    }
    return {
      platform: 'linux',
      servicePath: path.join(os.homedir(), '.config', 'systemd', 'user', 'pichamber.service'),
      scope: 'user',
    };
  }
  if (process.platform === 'win32') {
    return { platform: 'windows', servicePath: STARTUP_SERVICE_ID };
  }
  return { platform: process.platform, servicePath: null };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function systemdEscapeArg(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function startupShellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function systemdUnitPath(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/ /g, '\\x20');
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function startupEnvFileQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function systemdEnvFileQuote(value) {
  return `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')}"`;
}

function getStartupEnvFilePath() {
  return path.join(getDataDir(), 'startup.env');
}

function getMacosStartupWrapperPath() {
  return path.join(getDataDir(), 'bin', 'PiChamber');
}

function collectStartupEnv(options = {}) {
  const env = options.envSnapshot === false ? {} : Object.fromEntries(
    Object.entries(process.env)
      .filter(([key, value]) => shouldPersistStartupEnv(key, value))
      .map(([key, value]) => [key, String(value)])
  );

  const uiPassword = hasUiPasswordConfigured(options.uiPassword) ? options.uiPassword : undefined;
  if (uiPassword) {
    env.PICHAMBER_UI_PASSWORD = uiPassword;
    env.PICHAMBER_UI_PASSWORD = uiPassword;
  }
  if (options.apiOnly === true) {
    env.PICHAMBER_API_ONLY = 'true';
    env.PICHAMBER_API_ONLY = 'true';
  }
  const configuredDataDir = typeof process.env.PICHAMBER_DATA_DIR === 'string' && process.env.PICHAMBER_DATA_DIR.trim().length > 0
    ? process.env.PICHAMBER_DATA_DIR.trim()
    : (typeof process.env.PICHAMBER_DATA_DIR === 'string' && process.env.PICHAMBER_DATA_DIR.trim().length > 0
      ? process.env.PICHAMBER_DATA_DIR.trim()
      : '');
  if (configuredDataDir.length > 0) {
    env.PICHAMBER_DATA_DIR = path.resolve(configuredDataDir);
    env.PICHAMBER_DATA_DIR = path.resolve(configuredDataDir);
  }
  return env;
}

function shouldPersistStartupEnv(key, value) {
  if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return false;
  if (typeof value !== 'string') return false;
  if (/[\r\n]/.test(value)) return false;

  // These are shell/session implementation details, not app configuration.
  const volatileKeys = new Set([
    '_',
    'BASH_ENV',
    'COLUMNS',
    'CONDA_DEFAULT_ENV',
    'CONDA_PREFIX',
    'CONDA_PROMPT_MODIFIER',
    'CONDA_SHLVL',
    'ENV',
    'HISTFILE',
    'HISTFILESIZE',
    'HISTSIZE',
    'LINES',
    'OLDPWD',
    'PROMPT',
    'PROMPT_COMMAND',
    'PS1',
    'PS2',
    'PS3',
    'PS4',
    'PWD',
    'PYENV_VERSION',
    'SHLVL',
    'TERM',
    'TERM_PROGRAM',
    'TERM_PROGRAM_VERSION',
    'TTY',
    'VIRTUAL_ENV',
    'VIRTUAL_ENV_PROMPT',
  ]);
  return !volatileKeys.has(key);
}

function writeStartupEnvFile(options = {}, fileOptions = {}) {
  const envFilePath = getStartupEnvFilePath();
  const lines = [];
  const env = collectStartupEnv(options);
  const quoteValue = typeof fileOptions.quoteValue === 'function' ? fileOptions.quoteValue : startupEnvFileQuote;
  for (const [key, value] of Object.entries(env)) {
    lines.push(`${key}=${quoteValue(value)}`);
  }
  fs.mkdirSync(path.dirname(envFilePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(envFilePath, lines.length > 0 ? `${lines.join('\n')}\n` : '', { mode: 0o600 });
  return envFilePath;
}

function removeStartupEnvFile() {
  try { fs.unlinkSync(getStartupEnvFilePath()); } catch {}
}

function resolveCliEntrypoint() {
  const entry = typeof process.argv[1] === 'string' && process.argv[1].trim().length > 0
    ? process.argv[1]
    : path.join(__dirname, 'cli.js');
  // Keep the invoked path, not realpath(). pnpm/npm shims point at a stable
  // node_modules entry; resolving through the store pins a versioned folder
  // that breaks after `pichamber update`.
  return path.resolve(entry);
}

function isUserStartupServiceActive() {
  if (process.platform !== 'linux') return false;
  if (isRootUser()) {
    const result = runStartupCommand('systemctl', ['is-active', 'pichamber.service'], { allowFailure: true });
    return (result.stdout || '').trim() === 'active';
  }
  const result = runStartupCommand('systemctl', ['--user', 'is-active', 'pichamber.service'], { allowFailure: true });
  return (result.stdout || '').trim() === 'active';
}

function restartUserStartupService() {
  if (process.platform !== 'linux') {
    throw new Error('Startup service restart is only supported on Linux systemd units.');
  }
  if (isRootUser()) {
    runStartupCommand('systemctl', ['daemon-reload']);
    runStartupCommand('systemctl', ['restart', 'pichamber.service']);
    return;
  }
  runStartupCommand('systemctl', ['--user', 'daemon-reload']);
  runStartupCommand('systemctl', ['--user', 'restart', 'pichamber.service']);
}

function buildStartupArgs(options = {}) {
  const args = [resolveCliEntrypoint(), 'serve', '--foreground', '--port', String(options.port || DEFAULT_PORT)];
  if (typeof options.host === 'string' && options.host.length > 0) {
    args.push('--host', options.host);
  }
  if (options.apiOnly === true) {
    args.push('--api-only');
  }
  return args;
}

function formatStartupServeCommand(options = {}) {
  const parts = ['pichamber', 'serve', '--foreground', '--port', String(options.port || DEFAULT_PORT)];
  if (options.lan === true && (typeof options.host !== 'string' || options.host === '0.0.0.0')) {
    parts.push('--lan');
  } else if (typeof options.host === 'string' && options.host.length > 0) {
    parts.push('--host', options.host);
  }
  if (options.apiOnly === true) {
    parts.push('--api-only');
  }
  if (options.explicitUiPassword === true || hasUiPasswordConfigured(options.uiPassword)) {
    parts.push('--ui-password');
  }
  return parts.join(' ');
}

function writeMacosStartupWrapper(options = {}) {
  const wrapperPath = getMacosStartupWrapperPath();
  const args = buildStartupArgs(options).map(startupShellQuote).join(' ');
  const content = `#!/bin/sh
exec ${startupShellQuote(process.execPath)} ${args}
`;
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(wrapperPath, content, { mode: 0o700 });
  return wrapperPath;
}

function buildMacosLaunchAgent(options = {}) {
  const wrapperPath = writeMacosStartupWrapper(options);
  const args = [wrapperPath];
  const env = collectStartupEnv(options);
  const logDir = path.join(os.homedir(), 'Library', 'Logs', 'PiChamber');
  const argXml = args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n');
  const envXml = Object.entries(env).length > 0
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${Object.entries(env).map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`).join('\n')}\n  </dict>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${STARTUP_SERVICE_ID}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
${envXml}  <key>ProcessType</key>
  <string>Background</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(os.homedir())}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(logDir, 'startup.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(logDir, 'startup.err.log'))}</string>
</dict>
</plist>
`;
}

function buildSystemdUserService(options = {}) {
  const args = buildStartupArgs(options).map((arg) => `"${systemdEscapeArg(arg)}"`).join(' ');
  const envFilePath = getStartupEnvFilePath();
  const isRoot = isRootUser();
  const wantedBy = isRoot ? 'multi-user.target' : 'default.target';
  const workingDir = isRoot ? systemdUnitPath('/root') : systemdUnitPath(os.homedir());
  return `[Unit]
Description=PiChamber web server
After=network-online.target

[Service]
Type=simple
EnvironmentFile=-${systemdEscapeArg(envFilePath)}
ExecStart="${systemdEscapeArg(process.execPath)}" ${args}
WorkingDirectory=${workingDir}
Restart=always
RestartSec=5

[Install]
WantedBy=${wantedBy}
`;
}

function buildSystemdService(options = {}) {
  return buildSystemdUserService(options);
}

function runStartupCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && options.allowFailure !== true) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function getStartupStatus() {
  const paths = getStartupServicePaths();
  if (!paths.servicePath) {
    return { supported: false, platform: paths.platform, enabled: false, servicePath: null };
  }
  if (paths.platform === 'windows') {
    const result = runStartupCommand('schtasks.exe', ['/Query', '/TN', STARTUP_SERVICE_ID], { allowFailure: true });
    return { supported: true, platform: paths.platform, enabled: result.status === 0, active: null, servicePath: paths.servicePath };
  }
  if (paths.platform === 'linux') {
    const isRoot = isRootUser();
    const enabledArgs = isRoot ? ['is-enabled', 'pichamber.service'] : ['--user', 'is-enabled', 'pichamber.service'];
    const activeArgs = isRoot ? ['is-active', 'pichamber.service'] : ['--user', 'is-active', 'pichamber.service'];
    const enabledResult = runStartupCommand('systemctl', enabledArgs, { allowFailure: true });
    const activeResult = runStartupCommand('systemctl', activeArgs, { allowFailure: true });
    const activeState = (activeResult.stdout || '').trim() || 'inactive';
    return {
      supported: true,
      platform: paths.platform,
      enabled: enabledResult.status === 0 || fs.existsSync(paths.servicePath),
      active: activeState === 'active',
      activeState,
      servicePath: paths.servicePath,
      scope: isRoot ? 'system' : 'user',
    };
  }
  return {
    supported: true,
    platform: paths.platform,
    enabled: fs.existsSync(paths.servicePath),
    active: null,
    servicePath: paths.servicePath,
  };
}

function enableStartupService(options = {}) {
  const paths = getStartupServicePaths();
  if (!paths.servicePath) {
    throw new TunnelCliError(`Startup integration is not supported on ${paths.platform}.`, EXIT_CODE.USAGE_ERROR);
  }

  const resolvedUiPassword = resolveServeUiPassword(options);
  const serveOptions = {
    ...options,
    ...(resolvedUiPassword.password ? { uiPassword: resolvedUiPassword.password } : {}),
  };
  assertAuthenticatedNetworkExposure({
    host: serveOptions.host,
    uiPassword: serveOptions.uiPassword,
  });
  const finish = (status) => (
    resolvedUiPassword.generated === true
      ? { ...status, generatedUiPassword: resolvedUiPassword.password }
      : status
  );

  if (paths.platform === 'macos') {
    removeStartupEnvFile();
    fs.mkdirSync(path.dirname(paths.servicePath), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(os.homedir(), 'Library', 'Logs', 'PiChamber'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.servicePath, buildMacosLaunchAgent(serveOptions), { mode: 0o600 });
    runStartupCommand('/bin/launchctl', ['bootout', `gui/${process.getuid()}`, paths.servicePath], { allowFailure: true });
    runStartupCommand('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, paths.servicePath]);
    runStartupCommand('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${STARTUP_SERVICE_ID}`], { allowFailure: true });
    return finish(getStartupStatus());
  }

  if (paths.platform === 'linux') {
    const isRoot = isRootUser();
    writeStartupEnvFile(serveOptions, { quoteValue: systemdEnvFileQuote });
    fs.mkdirSync(path.dirname(paths.servicePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.servicePath, buildSystemdUserService(serveOptions), { mode: 0o600 });
    if (isRoot) {
      runStartupCommand('systemctl', ['daemon-reload']);
      runStartupCommand('systemctl', ['enable', '--now', 'pichamber.service']);
    } else {
      runStartupCommand('systemctl', ['--user', 'daemon-reload']);
      runStartupCommand('systemctl', ['--user', 'enable', '--now', 'pichamber.service']);
    }
    return finish(getStartupStatus());
  }

  const envFilePath = writeStartupEnvFile(serveOptions);
  const startupArgs = buildStartupArgs(serveOptions).map(powershellQuote).join(', ');
  const powerShellCommand = [
    `$envFile=${powershellQuote(envFilePath)}`,
    `if (Test-Path $envFile) { Get-Content $envFile | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { $v=$matches[2]; if ($v.StartsWith("'") -and $v.EndsWith("'")) { $v=$v.Substring(1,$v.Length-2).Replace("'\\''","'") }; [Environment]::SetEnvironmentVariable($matches[1], $v, 'Process') } } }`,
    `& ${powershellQuote(process.execPath)} ${startupArgs}`,
  ].join('; ');
  const taskArgs = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${powerShellCommand.replace(/"/g, '\\"')}"`;
  runStartupCommand('schtasks.exe', [
    '/Create',
    '/TN', STARTUP_SERVICE_ID,
    '/SC', 'ONLOGON',
    '/RL', 'LIMITED',
    '/F',
    '/TR', taskArgs,
  ]);
  runStartupCommand('schtasks.exe', ['/Run', '/TN', STARTUP_SERVICE_ID], { allowFailure: true });
  return finish(getStartupStatus());
}

function disableStartupService() {
  const paths = getStartupServicePaths();
  if (!paths.servicePath) {
    throw new TunnelCliError(`Startup integration is not supported on ${paths.platform}.`, EXIT_CODE.USAGE_ERROR);
  }

  if (paths.platform === 'macos') {
    runStartupCommand('/bin/launchctl', ['bootout', `gui/${process.getuid()}`, paths.servicePath], { allowFailure: true });
    try { fs.unlinkSync(paths.servicePath); } catch {}
    return getStartupStatus();
  }

  if (paths.platform === 'linux') {
    const isRoot = isRootUser();
    if (isRoot) {
      runStartupCommand('systemctl', ['disable', '--now', 'pichamber.service'], { allowFailure: true });
      try { fs.unlinkSync(paths.servicePath); } catch {}
      runStartupCommand('systemctl', ['daemon-reload'], { allowFailure: true });
    } else {
      runStartupCommand('systemctl', ['--user', 'disable', '--now', 'pichamber.service'], { allowFailure: true });
      try { fs.unlinkSync(paths.servicePath); } catch {}
      runStartupCommand('systemctl', ['--user', 'daemon-reload'], { allowFailure: true });
    }
    return getStartupStatus();
  }

  runStartupCommand('schtasks.exe', ['/End', '/TN', STARTUP_SERVICE_ID], { allowFailure: true });
  runStartupCommand('schtasks.exe', ['/Delete', '/TN', STARTUP_SERVICE_ID, '/F'], { allowFailure: true });
  return getStartupStatus();
}


export {
  getStartupServicePaths,
  getStartupStatus,
  enableStartupService,
  disableStartupService,
  isUserStartupServiceActive,
  restartUserStartupService,
  formatStartupServeCommand,
};
