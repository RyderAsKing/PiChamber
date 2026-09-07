export const SESSION_DAEMON_PROTOCOL_VERSION = 1;
export const SESSION_DAEMON_MAX_FRAME_BYTES = 16 * 1024 * 1024;

// Keep normal transcript pages well below the hard frame ceiling. The final
// encoded response contains protocol and session metadata in addition to the
// projected messages.
export const SESSION_DAEMON_MESSAGE_PAGE_TARGET_BYTES = 4 * 1024 * 1024;
export const SESSION_DAEMON_DEFAULT_MESSAGE_PAGE_LIMIT = 50;
export const SESSION_DAEMON_MAX_MESSAGE_PAGE_LIMIT = 100;
