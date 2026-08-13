export type SessionMetadataRecord = Record<string, unknown>;

export function getSessionMetadata(_session?: unknown): SessionMetadataRecord {
  return {};
}

export const getSessionReviewMetadata = getSessionMetadata;
export const sessionReviewMetadata = getSessionMetadata;
