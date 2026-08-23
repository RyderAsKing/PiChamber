export type DictationState =
  | 'idle'
  | 'requesting-permission'
  | 'recording'
  | 'reconnecting'
  | 'transcribing'
  | 'error';

export interface DictationController {
  state: DictationState;
  error: string | null;
  elapsedSeconds: number;
  start(): Promise<void>;
  finish(): Promise<string>;
  cancel(): void;
  subscribeLevel(listener: (level: number) => void): () => void;
}
