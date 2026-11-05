import React from 'react';

import { subscribeOpenRequests } from '@/apps/pi-session-store';
import { toast } from '@/components/ui';
import { isElectronShell } from '@/lib/desktopBridge';
import { decideOpenRequest, describeOpenRequestPrompt, describeOpenRequestUrl } from '@/lib/pi/open-request';
import type { PiSessionOpenUrlEvent } from '@/lib/pi/protocol';
import { useUIStore } from '@/stores/useUIStore';
import { getDeviceDirectory, openRequestOnDevice } from './openRequestActions';

/**
 * Shows Open requests (`session.openUrl`): a URL something on the server
 * machine asked PiChamber to show, such as a review page an extension
 * started. Every device asks before opening it; nothing opens by itself
 * (see `describeOpenRequestPrompt`).
 *
 * Mounted once in the full app shell (`App.tsx`) and in `MobileApp.tsx`,
 * like `NeedsInputAlerts`.
 */

const SEEN_LIMIT = 200;
const INFO_ONLY_DURATION_MS = 15_000;

const handleOpenRequest = (event: PiSessionOpenUrlEvent): void => {
  const { id, url } = event.payload;
  const decision = decideOpenRequest(event.payload);
  if (!decision.showNotice) return;

  const toastId = `open-request:${id}`;
  const prompt = describeOpenRequestPrompt(describeOpenRequestUrl(url), decision.target, {
    isMobile: useUIStore.getState().isMobile,
    isolatedBrowser: isElectronShell(),
  });
  if (!prompt.canOpen) {
    toast.info(prompt.title, { id: toastId, description: prompt.description, duration: INFO_ONLY_DURATION_MS });
    return;
  }
  // Stays until answered: a request that vanished on its own would be lost.
  toast.info(prompt.title, {
    id: toastId,
    description: prompt.description,
    duration: Infinity,
    action: {
      label: 'Open',
      onClick: () => {
        // The panel the person is looking at, not the requesting session's
        // project: they clicked here, so the page should appear here.
        openRequestOnDevice(decision.target, url, getDeviceDirectory() || event.directory);
      },
    },
    cancel: {
      label: 'Dismiss',
      onClick: () => {
        toast.dismiss(toastId);
      },
    },
  });
};

export const OpenRequestAlerts: React.FC = () => {
  React.useEffect(() => {
    // The replay log can resend a request after a reconnect; show each once.
    const seen = new Set<string>();
    return subscribeOpenRequests((event) => {
      if (seen.has(event.payload.id)) return;
      seen.add(event.payload.id);
      if (seen.size > SEEN_LIMIT) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      handleOpenRequest(event);
    });
  }, []);
  return null;
};
