import type { createFragmentAssembler } from './tunnel-codec';

export type StreamHandler = {
  handleFrame(frameType: number, payload: Uint8Array): void;
  fail(error: Error): void;
};

export type ActiveChannel = {
  streams: Map<number, StreamHandler>;
  assembler: ReturnType<typeof createFragmentAssembler>;
  nextStreamId(): number;
  send(frame: Uint8Array): void;
  dead: boolean;
};

export type ChannelWaiter = {
  resolve(channel: ActiveChannel): void;
  reject(error: Error): void;
};
