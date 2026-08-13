import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';
import { registerFsRoutes } from '../fs/routes.js';
import { registerGitRoutes } from '../git/routes.js';
import { createPreviewProxyRuntime } from '../preview/proxy-runtime.js';
import { createRequestSecurityRuntime } from '../security/request-security.js';
import { mergePathValues } from '../server/path-utils.js';
import { createTerminalRuntime } from '../terminal/runtime.js';
import { getExecutableSearchDirectories } from '../tunnels/executable-search.js';

const normalizeDirectoryPath = (value) => (typeof value === 'string' ? path.resolve(value.trim()) : '');

const buildAugmentedPath = () => mergePathValues(process.env.PATH || '', process.env.Path || '', path.delimiter);

const searchPathFor = (name) => {
  for (const directory of getExecutableSearchDirectories()) {
    const candidate = path.join(directory, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return name;
};

const isExecutable = (filePath) => {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return fs.existsSync(filePath);
  }
};

const resolveProjectDirectory = async (req) => {
  const header = typeof req.get === 'function' ? req.get('x-opencode-directory') || req.get('x-pichamber-directory') : null;
  const query = Array.isArray(req.query?.directory) ? req.query.directory[0] : req.query?.directory;
  const requested = typeof header === 'string' && header.trim() ? header.trim() : (typeof query === 'string' ? query.trim() : '');
  if (!requested) return { directory: process.cwd(), error: null };
  try {
    const resolved = path.resolve(requested);
    const stats = await fs.promises.stat(resolved);
    if (!stats.isDirectory()) return { directory: null, error: 'Specified path is not a directory' };
    return { directory: await fs.promises.realpath(resolved), error: null };
  } catch {
    return { directory: null, error: 'Directory not found' };
  }
};

export const registerWorkspaceIntegrations = ({ app, server, express, uiAuthController }) => {
  const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });
  registerGitRoutes(app);
  registerFsRoutes(app, {
    os,
    path,
    fsPromises: fs.promises,
    spawn,
    crypto,
    normalizeDirectoryPath,
    resolveProjectDirectory,
    buildAugmentedPath,
    resolveGitBinaryForSpawn: () => searchPathFor(process.platform === 'win32' ? 'git.exe' : 'git'),
    pichamberUserConfigRoot: path.join(os.homedir(), '.config'),
  });
  createTerminalRuntime({
    app,
    server,
    express,
    fs,
    path,
    uiAuthController,
    buildAugmentedPath,
    searchPathFor,
    isExecutable,
    isRequestOriginAllowed: security.isRequestOriginAllowed,
    rejectWebSocketUpgrade: security.rejectWebSocketUpgrade,
  });
  createPreviewProxyRuntime({
    crypto,
    URL,
    createProxyMiddleware,
    responseInterceptor,
  }).attach(app, {
    server,
    express,
    uiAuthController,
    isRequestOriginAllowed: security.isRequestOriginAllowed,
    rejectWebSocketUpgrade: security.rejectWebSocketUpgrade,
  });
};
