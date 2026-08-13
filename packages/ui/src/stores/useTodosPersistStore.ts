/* eslint-disable */
import { create } from "zustand";
export const useTodosPersistStore = create(() => ({
  todos: [] as unknown[],
  clearSessionTodos: (..._args: unknown[]) => {},
}));
