export const canShowQuickArchiveAction = ({
  mobileVariant,
  isTablet,
}: {
  mobileVariant: boolean;
  isTablet: boolean;
}): boolean => !mobileVariant && !isTablet;
