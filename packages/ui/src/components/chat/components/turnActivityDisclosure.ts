interface TurnActivityDisclosureInput {
    isExpanded: boolean;
    userToggled: boolean;
    wasAutoCollapsed: boolean;
    hasActivity: boolean;
    showWorkingStatus: boolean;
    hasFinalText: boolean;
    previousHadFinalText: boolean;
    hasNewActivity: boolean;
}

interface TurnActivityDisclosureResult {
    isExpanded: boolean;
    wasAutoCollapsed: boolean;
    resetUserToggle: boolean;
}

export const resolveTurnActivityDisclosure = ({
    isExpanded,
    userToggled,
    wasAutoCollapsed,
    hasActivity,
    showWorkingStatus,
    hasFinalText,
    previousHadFinalText,
    hasNewActivity,
}: TurnActivityDisclosureInput): TurnActivityDisclosureResult => {
    if (!hasActivity) {
        return { isExpanded, wasAutoCollapsed, resetUserToggle: false };
    }

    const finalOutputStarted = showWorkingStatus && hasFinalText && !previousHadFinalText;
    if (finalOutputStarted) {
        return {
            isExpanded: false,
            wasAutoCollapsed: true,
            resetUserToggle: userToggled,
        };
    }

    if (userToggled) {
        return { isExpanded, wasAutoCollapsed, resetUserToggle: false };
    }

    if (hasNewActivity && wasAutoCollapsed) {
        return { isExpanded: true, wasAutoCollapsed: false, resetUserToggle: false };
    }

    if (showWorkingStatus && !hasFinalText && !isExpanded) {
        return { isExpanded: true, wasAutoCollapsed, resetUserToggle: false };
    }

    if (showWorkingStatus && hasFinalText && isExpanded) {
        return { isExpanded: false, wasAutoCollapsed: true, resetUserToggle: false };
    }

    return { isExpanded, wasAutoCollapsed, resetUserToggle: false };
};
