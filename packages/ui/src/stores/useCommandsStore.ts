import { create } from 'zustand';

type CommandsState = {
  commands: unknown[];
  load: () => Promise<void>;
};

export const useCommandsStore = create<CommandsState>()(() => ({
  commands: [],
  load: async () => undefined,
}));
