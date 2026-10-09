/** Display label for a paired device's reported platform. */
export const devicePlatformLabel = (platform?: string | null): string | null => {
  switch ((platform || '').toLowerCase()) {
    case 'ios':
      return 'iOS';
    case 'android':
      return 'Android';
    case 'macos':
    case 'darwin':
      return 'macOS';
    case 'windows':
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    default:
      return null;
  }
};
