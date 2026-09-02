import { piClient } from '@/lib/pi/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { CONNECTION_PROBE_TIMEOUT_MS } from './configTypes';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const checkPiHealth = async (): Promise<boolean> => {
  const health = await piClient.health({ runtimeKey: getRuntimeKey() });
  return health.state === 'ready';
};

export const probePiHealth = async (
  timeoutMs = CONNECTION_PROBE_TIMEOUT_MS
): Promise<boolean> => {
  return Promise.race([
    checkPiHealth().catch(() => false),
    sleep(Math.max(1, timeoutMs)).then(() => false),
  ]);
};
