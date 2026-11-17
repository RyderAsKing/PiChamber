import { create } from 'zustand';

/** One run of one `subagent` call: the tool part's id and the run's index. */
interface SubagentRunRef {
  callId: string;
  index: number;
}

interface SubagentSelectionState {
  /** The run the Agents panel shows on its own; `null` lists every call. */
  selected: SubagentRunRef | null;
  select: (selected: SubagentRunRef | null) => void;
}

export const useSubagentSelection = create<SubagentSelectionState>((set) => ({
  selected: null,
  select: (selected) => set({ selected }),
}));
