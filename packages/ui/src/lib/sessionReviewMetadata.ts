export type SessionMetadataRecord = Record<string, unknown>;

export function getSessionMetadata(session?: unknown): SessionMetadataRecord {
  void session;
  return {};
}

export const getSessionReviewMetadata = getSessionMetadata;
export const sessionReviewMetadata = getSessionMetadata;
