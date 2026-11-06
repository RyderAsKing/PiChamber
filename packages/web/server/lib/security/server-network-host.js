import net from 'node:net';

const isLocalIPv4 = ([a, b, c]) => (
  a === 0 || a === 127 || a === 10                // this-host / loopback / private
  || (a === 169 && b === 254)                     // link-local incl. cloud metadata
  || (a === 172 && b >= 16 && b <= 31)            // private
  || (a === 192 && b === 168)                     // private
  || (a === 100 && b >= 64 && b <= 127)           // carrier-grade NAT (Tailscale)
  || (a === 192 && b === 0 && c === 0)            // IETF protocol assignments
  || (a === 198 && (b === 18 || b === 19))        // benchmarking
  || a >= 224                                     // multicast, reserved, broadcast
);

// The eight 16-bit groups of a valid IPv6 address (dotted tail allowed).
const ipv6Groups = (host) => {
  let text = host;
  const dotted = text.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number);
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const start = head ? head.split(':') : [];
  const end = tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(8 - start.length - end.length).fill('0');
  return [...start, ...fill, ...end].map((group) => parseInt(group, 16));
};

const ipv4FromGroups = (high, low) => [high >> 8, high & 0xff, low >> 8, low & 0xff];

const isLocalIPv6 = (host) => {
  const g = ipv6Groups(host);
  const zeros = (from, to) => g.slice(from, to).every((group) => group === 0);
  if ((g[0] & 0xffc0) === 0xfe80) return true;    // link-local fe80::/10
  if ((g[0] & 0xfe00) === 0xfc00) return true;    // unique local fc00::/7
  if ((g[0] & 0xff00) === 0xff00) return true;    // multicast
  if (zeros(0, 5) && g[5] === 0xffff) return true; // IPv4-mapped
  // Forms that carry an IPv4 address: IPv4-compatible (and :: / ::1),
  // NAT64 64:ff9b::/96, and 6to4 2002::/16.
  if (zeros(0, 6)) return g[6] === 0 || isLocalIPv4(ipv4FromGroups(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return isLocalIPv4(ipv4FromGroups(g[6], g[7]));
  if (g[0] === 0x2002) return isLocalIPv4(ipv4FromGroups(g[1], g[2]));
  return false;
};

// Hosts on the server's own network: loopback, private, link-local (which
// includes cloud metadata services), carrier-grade NAT (Tailscale), other
// special-use ranges, and local names. Pages from the public internet must
// not reach these through PiChamber unless the person asked for that address.
export const isServerNetworkHost = (hostname) => {
  if (!hostname) return true;
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/%.*$/, '');                // IPv6 zone
  if (host.endsWith('.')) host = host.slice(0, -1); // fully qualified name

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;

  const version = net.isIP(host);
  if (version === 4) return isLocalIPv4(host.split('.').map(Number));
  if (version === 6) return isLocalIPv6(host);
  // Not an address; a name with a colon is malformed.
  return host.includes(':');
};
