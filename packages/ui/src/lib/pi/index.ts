/**
 * Public exports for the Pi shared UI module.
 *
 * Consumers should import from `@/lib/pi` (or the relative path) rather
 * than reaching into individual files. The barrel keeps the module's
 * surface small and stable: the workstream-9 deletion will eventually
 * remove the OpenCode facade, but the `pi/` exports remain.
 */

export * from './types';
export * from './protocol';
export * from './client';
export * from './transport';
export * from './snapshot';
export * from './event-reducer';
export * from './bootstrap';
export * from './reconnect';
export * from './archive';
export * from './attachments';
export * from './model-provider';
