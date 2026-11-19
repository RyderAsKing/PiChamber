import { normalizeCommandArgs } from './command-triggers';
import { parseExtensionCommandName } from './extension-command';

interface ExtensionAppCommandContext {
  appId: string;
  token: string;
}

interface ExtensionAppCommand {
  command: string;
  args?: string;
}

/**
 * Validate an untrusted iframe message and return the only capability an app
 * surface may request: one of the extension's own commands, with arguments.
 * The command name follows the rule every extension surface shares
 * (`extension-command.ts`).
 */
export const parseExtensionAppCommand = (
  value: unknown,
  context: ExtensionAppCommandContext,
): ExtensionAppCommand | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (data.type !== 'pichamber-app-command' || data.appId !== context.appId || data.token !== context.token) {
    return undefined;
  }
  const command = parseExtensionCommandName(data.command);
  if (!command) return undefined;
  const args = normalizeCommandArgs(typeof data.args === 'string' ? data.args : undefined);
  return args ? { command, args } : { command };
};
