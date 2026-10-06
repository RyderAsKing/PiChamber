import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui/toast';
import { getClientPlatform } from '@/lib/platform';
import { openExternalUrl } from '@/lib/url';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';

const TOAST_ID = 'mobile-app-update-available';
const DISMISSED_VERSION_KEY = 'mobile-app-update-toast-dismissed-version';

export const MobileAppUpdateToast: React.FC = () => {
  const { t } = useTranslation();
  const available = useUpdateStore((state) => state.available);
  const runtimeType = useUpdateStore((state) => state.runtimeType);
  const version = useUpdateStore((state) => state.info?.version);
  const downloadUrl = useUpdateStore((state) => state.info?.downloadUrl);
  const seenVersionsRef = React.useRef(new Set<string>());

  React.useEffect(() => {
    if (getClientPlatform() !== 'android' || runtimeType !== 'mobile' || !available || !version || !downloadUrl) {
      toast.dismiss(TOAST_ID);
      return;
    }

    if (getDeferredSafeStorage().getItem(DISMISSED_VERSION_KEY) === version) {
      return;
    }

    if (seenVersionsRef.current.has(version)) {
      return;
    }

    seenVersionsRef.current.add(version);

    toast.info(t('PiChamber update available'), {
      id: TOAST_ID,
      description: t('Version {{version}} is ready for Android.', { version }),
      duration: Infinity,
      icon: <Icon name="download" className="h-4 w-4 text-muted-foreground" />,
      action: {
        label: t('Download'),
        onClick: () => {
          void openExternalUrl(downloadUrl);
        },
      },
      cancel: {
        label: t('Dismiss'),
        onClick: () => {
          getDeferredSafeStorage().setItem(DISMISSED_VERSION_KEY, version);
          toast.dismiss(TOAST_ID);
        },
      },
    });
  }, [available, downloadUrl, runtimeType, t, version]);

  return null;
};
