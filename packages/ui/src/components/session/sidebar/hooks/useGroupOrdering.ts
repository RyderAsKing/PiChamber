import React from 'react';
import type { SessionGroup } from '../types';

export const useGroupOrdering = (groupOrderByProject: Map<string, string[]>) => {
  const getOrderedGroups = React.useCallback(
    (projectId: string, groups: SessionGroup[]) => {
      const preferredOrder = groupOrderByProject.get(projectId);
      if (!preferredOrder || preferredOrder.length === 0) {
        return groups;
      }
      const groupById = new Map(groups.map((group) => [group.id, group]));
      const ordered: SessionGroup[] = [];
      preferredOrder.forEach((id) => {
        const group = groupById.get(id);
        if (group) {
          ordered.push(group);
          groupById.delete(id);
        }
      });
      // Groups unknown to the saved order are NEW worktrees — surface them at
      // the top of the worktree list (the root/main group is positioned by
      // the renderer regardless of this ordering).
      const newGroups: SessionGroup[] = [];
      groups.forEach((group) => {
        if (groupById.has(group.id)) newGroups.push(group);
      });
      return [...newGroups, ...ordered];
    },
    [groupOrderByProject],
  );

  return { getOrderedGroups };
};
