// Hosts on the server's own network: loopback, private, link-local (which
// includes cloud metadata services), carrier-grade NAT (Tailscale), and
// local names. Pages from the public internet must not reach these through
// PiChamber unless the person asked for that address.
export const isServerNetworkHost = (hostname) => {
  if (!hostname) return true;
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 127 || a === 10) return true;          // this-host / loopback / private
    if (a === 169 && b === 254) return true;                    // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;           // private
    if (a === 192 && b === 168) return true;                    // private
    if (a === 100 && b >= 64 && b <= 127) return true;          // carrier-grade NAT
    return false;
  }

  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;           // loopback / unspecified
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true;          // link-local fe80::/10
    if (host.startsWith('fc') || host.startsWith('fd')) return true; // unique local fc00::/7
    if (host.includes('::ffff:')) return true;                       // IPv4-mapped (dotted or hex form)
    return false;
  }

  return false;
};
