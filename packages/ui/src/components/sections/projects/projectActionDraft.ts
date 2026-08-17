type ProjectActionDraftFields = {
  id: string;
  name: string;
  command: string;
};

export const isProjectActionComplete = (action: ProjectActionDraftFields): boolean => (
  action.name.trim().length > 0 && action.command.trim().length > 0
);

export const isProjectActionBlank = (action: ProjectActionDraftFields): boolean => (
  action.name.trim().length === 0 && action.command.trim().length === 0
);

export const isProjectActionPartial = (action: ProjectActionDraftFields): boolean => (
  !isProjectActionComplete(action) && !isProjectActionBlank(action)
);

export const getPersistableProjectActions = <T extends ProjectActionDraftFields>(
  actions: T[],
  savedIds: ReadonlySet<string>,
): { canPersist: boolean; actions: T[] } => {
  const hasIncompleteSavedAction = actions.some(
    (action) => savedIds.has(action.id) && !isProjectActionComplete(action),
  );
  if (hasIncompleteSavedAction) {
    return { canPersist: false, actions };
  }

  return {
    canPersist: true,
    actions: actions.filter(isProjectActionComplete),
  };
};
