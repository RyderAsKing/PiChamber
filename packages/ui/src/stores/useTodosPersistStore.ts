/* eslint-disable */
import { create } from "zustand";

/**
 * Session todos are a deferred follow-up feature in the Pi port. This store
 * keeps the status-row wiring intact while behaving as a stable
 * no-op: no todos are persisted, so reads return undefined and mutations are
 * no-ops.
 */
export const useTodosPersistStore = create(() => ({
  todos: [] as unknown[],
  getSessionTodos: (..._args: unknown[]) => undefined,
  clearSessionTodos: (..._args: unknown[]) => {},
}));
