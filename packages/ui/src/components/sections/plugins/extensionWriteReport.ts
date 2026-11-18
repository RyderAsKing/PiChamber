import { toast } from '@/components/ui';
import { reportSettingsSaveState } from '@/lib/persistence';
import { busySettingsMessage, deferredSettingsMessage, isSessionBusyError } from '@/lib/pi/mutation-status';
import type { ExtensionConfigWriteResult } from '@/plugins/extensionConfigStore';

const codeOf = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

/** The server sends a code and no text; this is what each one means to the user. */
const failureText = (code: string | undefined, subject: string): string => {
  switch (code) {
    case 'PROJECT_UNTRUSTED':
      return 'This project is not trusted, so Pi will not change its settings.';
    case 'RESOURCE_NOT_FOUND':
      return `${subject} is no longer there. The list has been read again.`;
    case 'PACKAGE_NOT_CONFIGURED':
      return `${subject} is no longer in Pi's settings.`;
    case 'PACKAGE_REMOVE_FAILED':
      return `Pi could not remove ${subject}. Its files may still be installed.`;
    case 'PACKAGE_ALREADY_INSTALLED':
      return `${subject} is already installed there.`;
    case 'PACKAGE_INSTALL_FAILED':
      return `npm could not install ${subject}. Check the server's network and try again.`;
    case 'PACKAGE_UPDATE_FAILED':
      return `Pi could not update ${subject}. The installed version stays.`;
    case 'PACKAGE_PINNED':
      return `${subject} is pinned to a version, so Pi does not update it.`;
    case 'DAEMON_UNAVAILABLE':
      return `Pi did not answer in time. ${subject} may still finish; the list will show it.`;
    case 'PI_SETTINGS_INVALID':
      return 'Pi\'s settings file could not be read or written.';
    default:
      return `${subject} could not be saved.`;
  }
};

/** Report a finished write: the header's save state, and a toast only when there is something to say. */
export const reportExtensionWrite = (result: ExtensionConfigWriteResult, subject: string): void => {
  if (result.ok) {
    reportSettingsSaveState('saved');
    if (result.deferred) toast.info(deferredSettingsMessage(subject));
    return;
  }
  reportSettingsSaveState('error');
  if (isSessionBusyError(result.error)) {
    toast.info(busySettingsMessage(subject));
    return;
  }
  toast.error(failureText(codeOf(result.error), subject));
};

/**
 * Report a finished install or update. These take long enough that the user
 * may have moved on, so success gets a toast too.
 */
export const reportPackageWrite = (
  result: ExtensionConfigWriteResult,
  subject: string,
  action: 'install' | 'update',
): void => {
  if (!result.ok) {
    reportExtensionWrite(result, subject);
    return;
  }
  reportSettingsSaveState('saved');
  const done = action === 'install' ? `Installed ${subject}` : `Updated ${subject}`;
  if (result.deferred) {
    toast.info(`${done}. Sessions pick it up when their turn ends.`);
    return;
  }
  toast.success(`${done}. New turns use it.`);
};
