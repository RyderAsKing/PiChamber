import { buildCommandPromptText } from './command-triggers';

const COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

interface ExtensionAppCommandContext {
  appId: string;
  token: string;
}

/**
 * Validate an untrusted iframe message and return the only capability an app
 * surface may request: a slash-command prompt string.
 */
export const parseExtensionAppCommand = (
  value: unknown,
  context: ExtensionAppCommandContext,
): string | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (data.type !== 'pichamber-app-command' || data.appId !== context.appId || data.token !== context.token) {
    return undefined;
  }
  if (typeof data.command !== 'string' || !COMMAND_PATTERN.test(data.command)) return undefined;
  return buildCommandPromptText(data.command, typeof data.args === 'string' ? data.args : undefined);
};
