'use strict';
/**
 * netutil.js — Local network interface discovery.
 *
 * Mirrors com.example.network.NetworkUtils: pick the active IPv4 address
 * belonging to a Wi-Fi/Ethernet interface and derive the subnet broadcast
 * address used for peer discovery sweeps.
 *
 * Windows specifics handled here (see README "Windows notes"):
 *   - Adapter names are localised ("Wi-Fi" / "WLAN" / "Ethernet" / "以太网"), so
 *     interface preference is matched by pattern, including the Chinese names.
 *   - Virtual adapters (Hyper-V, WSL, VPN, VMware, Docker, Bluetooth) are
 *     demoted, because on Windows they usually outrank the real NIC.
 *   - 169.254.x.x (APIPA) addresses are ignored: Windows keeps "Ethernet" bound
 *     to one on an unplugged cable, and it would otherwise win every time.
 *   - The real Wi-Fi SSID is read from `netsh wlan show interfaces` (cached,
 *     never blocking) instead of being guessed from the adapter name.
 */

const os = require('os');
const { execFile } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';

/** Name fragments that mark a virtual / tunnel / container adapter. */
const VIRTUAL_RE = /vethernet|virtual|hyper-v|vmware|virtualbox|vbox|loopback|tunnel|bluetooth|\btap\b|\btun\b|\bvpn\b|cisco|docker|wsl|teredo|isatap|pseudo|zethernet/;
/** Name fragments that mark a real Wi-Fi adapter (English + Chinese). */
const WIFI_RE = /wi-?fi|wifi|wireless|wlan|wlp|无线/;
/** Name fragments that mark a real wired adapter (English + Chinese). */
const ETHERNET_RE = /ethernet|^(eth|en|lan)\b|local area connection|有线|以太网/;

function ipv4ToInt(ip) {
  const parts = String(ip || '').split('.').map((n) => parseInt(n, 10));
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

/** 169.254.0.0/16 — self-assigned, means "no DHCP lease", so no peers there. */
function isLinkLocal(ip) {
  return String(ip || '').startsWith('169.254.');
}

/**
 * Lower is better. Mirrors the Android heuristic (real Wi-Fi first, then wired,
 * virtual adapters last).
 *
 * `platform` defaults to the running platform but is injectable so the ranking
 * rules can be unit-tested for Windows from any host.
 */
function scoreInterface(name, addr, platform) {
  const plat = platform || process.platform;
  const n = String(name || '').toLowerCase();
  let score = 50;

  if (plat === 'win32') {
    if (WIFI_RE.test(n)) score = 5;
    else if (ETHERNET_RE.test(n)) score = 15;
    if (VIRTUAL_RE.test(n)) score = 95;
  } else if (plat === 'darwin') {
    if (n === 'en0') score = 5;
    else if (/^en\d/.test(n)) score = 15;
    if (/^(utun|awdl|llw|bridge|gif|stf|anpi|ap\d|ppp)/.test(n)) score = 95;
  } else {
    const LINUX_PREFERRED = ['wl', 'wifi', 'wlan', 'en', 'eth', 'wlp', 'eno', 'ens'];
    if (LINUX_PREFERRED.some((p) => n.startsWith(p))) score = 10;
    if (n.startsWith('lo') || n.includes('docker') || n.includes('veth') || n.includes('br-')) score = 90;
    if (n.startsWith('tun') || n.startsWith('tap') || n.startsWith('wg')) score = 95;
  }

  // Virtual adapters frequently carry an all-zero MAC. That is a strong hint,
  // so it can only ever push an interface *down*, never promote one.
  const mac = addr && addr.mac ? String(addr.mac).toLowerCase() : '';
  if (mac === '00:00:00:00:00:00') score = Math.max(score, 90);

  return score;
}

/**
 * Returns a descriptor for the best active IPv4 network interface, or null.
 */
function getPrimaryInterface() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' && addr.family !== 4) continue;
      if (addr.internal) continue;
      // An APIPA lease means there is no working network behind this adapter.
      if (isLinkLocal(addr.address)) continue;

      candidates.push({
        name,
        address: addr.address,
        netmask: addr.netmask,
        mac: addr.mac,
        cidr: addr.cidr,
        score: scoreInterface(name, addr),
      });
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
      if ((addr.family === 'IPv4' || addr.family === 4) && !addr.internal && !isLinkLocal(addr.address)) {
        result.push(addr.address);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// SSID
// ---------------------------------------------------------------------------

const SSID_TTL_MS = 60000;
const ssidCache = { value: null, at: 0, inflight: false };

/**
 * Pull the connected SSID out of `netsh wlan show interfaces`.
 *
 * The output is localised, so we cannot assume an English "SSID : x" line. The
 * key of every "key : value" line is matched instead, which works on every
 * Windows UI language ("SSID", "BSSID", ...). BSSID is explicitly rejected.
 */
function parseNetshSsid(text) {
  const found = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([^:]+?)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const value = m[2].trim();
    if (key === 'bssid') continue;
    if (key === 'ssid' || key.endsWith(' ssid')) {
      if (value) found.push(value);
    }
  }
  return found.length ? found[0] : null;
}

/** Kick off a non-blocking SSID refresh. Safe to call on every heartbeat. */
function refreshSsid() {
  if (!IS_WINDOWS) return;
  if (ssidCache.inflight) return;
  if (ssidCache.at && Date.now() - ssidCache.at < SSID_TTL_MS) return;

  ssidCache.inflight = true;
  execFile(
    'netsh',
    ['wlan', 'show', 'interfaces'],
    { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 1 << 20 },
    (err, stdout) => {
      ssidCache.inflight = false;
      ssidCache.at = Date.now();
      // A failure is cached too, otherwise a machine without a Wi-Fi radio would
      // spawn netsh twice a minute forever.
      ssidCache.value = err ? null : parseNetshSsid(stdout);
    },
  );
}

/** Best-effort network name. Starts a background refresh when stale. */
function guessSsid(ifaceName) {
  if (IS_WINDOWS) {
    refreshSsid();
    if (ssidCache.value) return ssidCache.value;
    // No radio, no SSID, or netsh unavailable — say something truthful rather
    // than leaking the raw adapter name into the UI.
    return ifaceName && WIFI_RE.test(String(ifaceName)) ? 'Wi-Fi Network' : 'Local Network';
  }

  const map = {
    wlan0: 'Wi-Fi Network',
    wlp2s0: 'Wi-Fi Network',
    wl: 'Wi-Fi Network',
    en0: 'Wi-Fi Network',
  };
  if (!ifaceName) return 'Local Network';
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
  isLinkLocal,
  scoreInterface,
  getPrimaryInterface,
  getLocalIpAddress,
  getAllIPv4,
  guessSsid,
  refreshSsid,
  parseNetshSsid,
  classCSweep,
};