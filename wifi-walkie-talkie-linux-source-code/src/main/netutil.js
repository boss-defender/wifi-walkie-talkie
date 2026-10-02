'use strict';
/**
 * netutil.js — Local network interface discovery.
 *
 * Mirrors com.example.network.NetworkUtils: pick the active IPv4 address
 * belonging to a Wi-Fi/Ethernet interface and derive the subnet broadcast
 * address used for peer discovery sweeps.
 */

const os = require('os');

function ipv4ToInt(ip) {
  const parts = ip.split('.').map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function intToIpv4(value) {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

/** True when `ip` sits inside the subnet described by `netmask` on `selfIp`. */
function isInSubnet(selfIp, netmask, ip) {
  const a = ipv4ToInt(selfIp);
  const m = ipv4ToInt(netmask);
  const b = ipv4ToInt(ip);
  if (a === null || m === null || b === null) return false;
  // Compare the network bits using signed-safe arithmetic.
  return (((a & m) >>> 0) === ((b & m) >>> 0));
}

const PREFERRED_PREFIXES = ['wl', 'wifi', 'wlan', 'en', 'eth', 'wlp', 'eno', 'ens'];

/**
 * Returns a descriptor for the best active IPv4 network interface, or null.
 * Preference order mirrors the Android heuristic (wlan/wifi/eth first).
 */
function getPrimaryInterface() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' && addr.family !== 4) continue;
      if (addr.internal) continue;
      const lower = name.toLowerCase();
      let score = 50;
      if (PREFERRED_PREFIXES.some((p) => lower.startsWith(p))) score = 10;
      if (lower.startsWith('lo') || lower.includes('docker') || lower.includes('veth') || lower.includes('br-')) score = 90;
      if (lower.startsWith('tun') || lower.startsWith('tap') || lower.startsWith('wg')) score = 95;
      candidates.push({ name, address: addr.address, netmask: addr.netmask, mac: addr.mac, score, cidr: addr.cidr });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];

  const self = ipv4ToInt(best.address);
  const mask = ipv4ToInt(best.netmask);
  let broadcast = null;
  if (self !== null && mask !== null) {
    // broadcast = address | ~netmask  (JS bitwise ops are signed 32-bit, so the
    // final >>> 0 is required to recover the unsigned address).
    broadcast = intToIpv4((self | ~mask) >>> 0);
  }

  return {
    name: best.name,
    address: best.address,
    netmask: best.netmask,
    mac: best.mac,
    cidr: best.cidr,
    broadcast,
  };
}

function getLocalIpAddress() {
  const iface = getPrimaryInterface();
  return iface ? iface.address : '127.0.0.1';
}

/** All non-loopback IPv4 addresses, used as extra mDNS query targets. */
function getAllIPv4() {
  const result = [];
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if ((addr.family === 'IPv4' || addr.family === 4) && !addr.internal) {
        result.push(addr.address);
      }
    }
  }
  return result;
}

/** Estimate the Wi-Fi SSID from the interface name (Linux exposes no API). */
function guessSsid(ifaceName) {
  if (!ifaceName) return 'Local Network';
  const map = {
    wlan0: 'Wi-Fi Network',
    wlp2s0: 'Wi-Fi Network',
    wl: 'Wi-Fi Network',
  };
  return map[ifaceName] || `${ifaceName.toUpperCase()} Network`;
}

/** Host candidate list for a /24 subnet (matches Android's Class C sweep). */
function classCSweep(localIp) {
  const parts = String(localIp).split('.');
  if (parts.length !== 4) return [];
  const prefix = parts.slice(0, 3).join('.');
  const out = new Array(254);
  for (let i = 1; i <= 254; i++) out[i - 1] = `${prefix}.${i}`;
  return out;
}

module.exports = {
  ipv4ToInt,
  intToIpv4,
  isInSubnet,
  getPrimaryInterface,
  getLocalIpAddress,
  getAllIPv4,
  guessSsid,
  classCSweep,
};