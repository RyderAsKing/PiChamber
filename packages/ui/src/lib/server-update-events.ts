const SERVER_UPDATE_CHANNEL_CHANGED_EVENT = 'pichamber:server-update-channel-changed';

export const notifyServerUpdateChannelChanged = (): void => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SERVER_UPDATE_CHANNEL_CHANGED_EVENT));
};

export const subscribeServerUpdateChannelChanged = (listener: () => void): (() => void) => {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(SERVER_UPDATE_CHANNEL_CHANGED_EVENT, listener);
  return () => window.removeEventListener(SERVER_UPDATE_CHANNEL_CHANGED_EVENT, listener);
};
