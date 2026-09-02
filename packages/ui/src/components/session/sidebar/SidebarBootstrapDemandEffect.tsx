import React from 'react';

import { useSessionUIStore } from '@/sync/session-ui-store';
import type { useChildStoreManager } from '@/sync/sync-context';
import { buildSessionBootstrapDemands } from './sessionBootstrapDemands';

export interface SidebarBootstrapDemandEffectProps {
  owner: string;
  childStores: ReturnType<typeof useChildStoreManager>;
  projectSections: Parameters<typeof buildSessionBootstrapDemands>[0]['projectSections'];
  activeProjectId: string | null;
  collapsedProjects: ReadonlySet<string>;
  collapsedGroups: ReadonlySet<string>;
  currentDirectory: string | null;
}

export const SidebarBootstrapDemandEffect: React.FC<SidebarBootstrapDemandEffectProps> = ({
  owner,
  childStores,
  projectSections,
  activeProjectId,
  collapsedProjects,
  collapsedGroups,
  currentDirectory,
}) => {
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);

  React.useEffect(() => {
    childStores.setBootstrapDemand(
      owner,
      buildSessionBootstrapDemands({
        projectSections,
        activeProjectId,
        collapsedProjects,
        collapsedGroups,
        currentDirectory,
        currentSessionDirectory,
      })
    );
  }, [
    activeProjectId,
    childStores,
    collapsedGroups,
    collapsedProjects,
    currentDirectory,
    currentSessionDirectory,
    owner,
    projectSections,
  ]);

  React.useEffect(
    () => () => childStores.clearBootstrapDemand(owner),
    [childStores, owner]
  );

  return null;
};
