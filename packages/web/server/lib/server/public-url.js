// The address a reverse proxy publishes PiChamber at (PICHAMBER_PUBLIC_URL or
// `serve --public-url`). Pairing links, the create-device dialog, and the
// paired-device candidate refresh advertise it ahead of interface addresses,
// which a phone cannot reach when the server runs in a container.

export class PublicUrlError extends Error {}

// Returns the URL's origin, or null when unset. Throws PublicUrlError for any
// value that is set but unusable, so a typo fails startup instead of silently
// advertising interface addresses again. Messages never echo the value: it
// could carry credentials.
export const parsePublicUrl = (value, { source = 'PICHAMBER_PUBLIC_URL' } = {}) => {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new PublicUrlError(`${source} is not a valid URL. Use an http:// or https:// address such as https://pichamber.example.com.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PublicUrlError(`${source} must start with http:// or https://.`);
  }
  if (parsed.username || parsed.password) {
    throw new PublicUrlError(`${source} must not contain a user name or password.`);
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new PublicUrlError(`${source} must be the address of the site root, without a path, query, or fragment.`);
  }
  return parsed.origin;
};
