import { isGlobalSessionDirectory } from '@/sync/global-session-directory';

type HeaderOpenDirectoryOptions = {
  sessionDirectory: string;
  draftDirectory: string;
  isNewSessionDraftOpen: boolean;
};

type HeaderLocationOptions = {
  activeProjectLabel: string | null;
  openDirectory: string;
  homeDirectory?: string | null;
};

export const getHeaderOpenDirectory = ({
  sessionDirectory,
  draftDirectory,
  isNewSessionDraftOpen,
}: HeaderOpenDirectoryOptions): string => (
  isNewSessionDraftOpen ? draftDirectory : sessionDirectory
);

export const getHeaderLocationLabel = ({
  activeProjectLabel,
  openDirectory,
  homeDirectory,
}: HeaderLocationOptions): string | null => {
  if (isGlobalSessionDirectory(openDirectory, homeDirectory)) {
    return null;
  }
  return activeProjectLabel;
};
