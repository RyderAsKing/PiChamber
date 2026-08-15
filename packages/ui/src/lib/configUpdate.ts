const DEFAULT_MESSAGE = "Updating OpenCode configuration...";

type ConfigUpdateListener = (state: {
  isUpdating: boolean;
  message: string;
}) => void;

const pendingCount = 0;
const currentMessage = DEFAULT_MESSAGE;
const listeners = new Set<ConfigUpdateListener>();

export function subscribeConfigUpdate(listener: ConfigUpdateListener) {
  listeners.add(listener);
  listener({
    isUpdating: pendingCount > 0,
    message: currentMessage,
  });
  return () => {
    listeners.delete(listener);
  };
}

export function getConfigUpdateSnapshot() {
  return {
    isUpdating: pendingCount > 0,
    message: currentMessage,
  };
}
