import os from 'node:os';

import { isNetworkExposedBindHost } from '../security/bind-host.js';

const isIpv4Family = (family) => family === 'IPv4' || family === 4;

export const listLanIPv4Addresses = (networkInterfaces = os.networkInterfaces()) => {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces || {})) {
    for (const entry of entries || []) {
      if (!isIpv4Family(entry.family) || entry.internal || typeof entry.address !== 'string') continue;
      if (entry.address === '0.0.0.0' || entry.address.startsWith('127.')) continue;
      if (!addresses.includes(entry.address)) addresses.push(entry.address);
    }
  }
  return addresses;
};

const formatHostForUrl = (host) => (host.includes(':') ? `[${host}]` : host);

export const createPairingTransportResolvers = ({ getPort, bindHost, networkInterfaces } = {}) => {
  const localUrl = () => {
    const port = getPort();
    return Number.isInteger(port) && port > 0 ? `http://127.0.0.1:${port}` : null;
  };

  const lanUrls = () => {
    const port = getPort();
    if (!Number.isInteger(port) || port <= 0 || !isNetworkExposedBindHost(bindHost)) return [];
    return listLanIPv4Addresses(networkInterfaces).map((ip) => `http://${formatHostForUrl(ip)}:${port}`);
  };

  return {
    getPairingTransports: () => ({
      local: localUrl(),
      lan: lanUrls()[0] ?? null,
      relayAvailable: false,
    }),
    getDirectCandidateUrls: () => lanUrls(),
  };
};
