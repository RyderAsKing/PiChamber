type SessionOpener = (sessionID: string, directory: string) => void

export const setSessionOpener: (opener: SessionOpener | null) => void = () => {
  // Previously delegated to `openSessionFromToast` from this module, which was
  // removed as unused. The setter remains as a public hook so callers can
  // register navigation behavior; the in-module opener state is no longer
  // maintained because nothing in this package triggers it. Pass-through.
};
