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
