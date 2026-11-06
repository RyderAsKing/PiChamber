import net from 'node:net';
import os from 'node:os';

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

const isIPv4Mapped = (g) => g.slice(0, 5).every((group) => group === 0) && g[5] === 0xffff;

const isLocalIPv6 = (host) => {
  const g = ipv6Groups(host);
  const zeros = (from, to) => g.slice(from, to).every((group) => group === 0);
  if ((g[0] & 0xffc0) === 0xfe80) return true;    // link-local fe80::/10
  if ((g[0] & 0xfe00) === 0xfc00) return true;    // unique local fc00::/7
  if ((g[0] & 0xff00) === 0xff00) return true;    // multicast
  // IPv4-mapped: a socket reaches the IPv4 address, and some stacks route
  // even public ones to the local host, so none are allowed as destinations.
  if (isIPv4Mapped(g)) return true;
  // Teredo 2001::/32 and local-use NAT64 64:ff9b:1::/48 carry IPv4 addresses
  // that translators may route without checking.
  if (g[0] === 0x2001 && g[1] === 0) return true;
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;
  // Forms that carry an IPv4 address: IPv4-translated ::ffff:0:0/96,
  // IPv4-compatible (and :: / ::1), NAT64 64:ff9b::/96, and 6to4 2002::/16.
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return isLocalIPv4(ipv4FromGroups(g[6], g[7]));
  if (zeros(0, 6)) return g[6] === 0 || isLocalIPv4(ipv4FromGroups(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return isLocalIPv4(ipv4FromGroups(g[6], g[7]));
  if (g[0] === 0x2002) return isLocalIPv4(ipv4FromGroups(g[1], g[2]));
  return false;
};

const bareHost = (hostname) => {
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/%.*$/, '');                // IPv6 zone
  if (host.endsWith('.')) host = host.slice(0, -1); // fully qualified name
  return host;
};

const sameAddress = (a, b, version) => (version === 6
  ? ipv6Groups(a).every((group, index) => group === ipv6Groups(b)[index])
  : a === b);

// The server's own interface addresses, public ones included: a page that
// reaches them reaches the server's services as well as a loopback one does.
const isOwnAddress = (host, version) => Object.values(os.networkInterfaces()).flat().some((entry) => (
  entry && net.isIP(entry.address.replace(/%.*$/, '')) === version
  && sameAddress(entry.address.replace(/%.*$/, '').toLowerCase(), host, version)
));

// Hosts on the server's own network: loopback, private, link-local (which
// includes cloud metadata services), carrier-grade NAT (Tailscale), other
// special-use ranges, the server's own addresses, and local names. Pages
// from the public internet must not reach these through PiChamber unless the
// person asked for that address.
export const isServerNetworkHost = (hostname) => {
  if (!hostname) return true;
  const host = bareHost(hostname);

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;

  const version = net.isIP(host);
  if (version === 4) return isLocalIPv4(host.split('.').map(Number)) || isOwnAddress(host, 4);
  if (version === 6) return isLocalIPv6(host) || isOwnAddress(host, 6);
  // Not an address; a name with a colon is malformed.
  return host.includes(':');
};

/**
 * Whether a page at `hostname` is on the server's network, as the source of
 * a load. Every IPv4-mapped address is a server-network destination, but a
 * page at a public one (`::ffff:8.8.8.8`) is a public page: it counts by its
 * IPv4 address.
 */
export const isServerNetworkSource = (hostname) => {
  if (!hostname) return true;
  const host = bareHost(hostname);
  if (net.isIP(host) === 6) {
    const g = ipv6Groups(host);
    if (isIPv4Mapped(g)) return isServerNetworkHost(ipv4FromGroups(g[6], g[7]).join('.'));
  }
  return isServerNetworkHost(host);
};
