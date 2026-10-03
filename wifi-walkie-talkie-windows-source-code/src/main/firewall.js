'use strict';
/**
 * firewall.js — Windows Defender Firewall integration.
 *
 * Windows Firewall blocks every inbound connection by default, including on a
 * private/home network. For a peer-to-peer app that means: no other device can
 * see us, `netsh` sweeps time out and the user is shown "0 peers" forever. It is
 * by far the most common reason a LAN app "does not work" on Windows, so the app
 * offers a one-click, one-UAC-prompt fix on first run.
 *
 * What is opened
 * --------------
 *   TCP 8888        signalling / chat / encrypted file transfer
 *   UDP 5353        mDNS discovery (DNS-SD)
 *   UDP 8887        broadcast signalling
 *   UDP 8889        call video (JPEG)
 *   UDP 8890        call audio (PCM)
 *   UDP 9999        walkie-talkie audio (PCM)
 *
 * The rules are intentionally NOT scoped to a program path. This build ships as
 * a single portable .exe that unpacks itself into a fresh temporary folder on
 * every run, so a program-scoped rule would stop matching after the next
 * restart. The ports are opened for the chosen network profiles only, and the
 * user can remove the rules again from Settings (or with the documented netsh
 * one-liner).
 *
 * Everything here is a no-op on non-Windows platforms, so the rest of the app
 * never has to branch.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WINDOWS = process.platform === 'win32';

const RULE_NAME = 'WiFi Walkie-Talkie (inbound)';
const RULE_DESCRIPTION =
  'Allows other devices on your local network to discover and talk to ' +
  'WiFi Walkie-Talkie. Added automatically on first run; remove it from ' +
  'Settings if you no longer want the app.';

const TCP_PORTS = [8888];
const UDP_PORTS = [5353, 8887, 8889, 8890, 9999];

const NETSH_TIMEOUT_MS = 15000;

function runNetsh(args, timeout) {
  return new Promise((resolve) => {
    execFile(
      'netsh.exe',
      ['advfirewall', 'firewall', ...args],
      { encoding: 'utf8', timeout: timeout || NETSH_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
          stdout: stdout || '',
          stderr: stderr || '',
        });
      },
    );
  });
}

/** Escape a path for use inside a single-quoted PowerShell string literal. */
function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * Write a .bat that (re)creates the inbound rules and run it elevated.
 *
 * A batch file is used rather than five separate elevated calls because every
 * elevation costs the user a UAC interaction; one UAC prompt per session is the
 * goal.
 */
function runElevatedBatch(lines) {
  const dir = path.join(os.tmpdir(), 'wifi-walkie-talkie');
  fs.mkdirSync(dir, { recursive: true });
  const batPath = path.join(dir, 'firewall.bat');

  const body = lines.map((l) => l + '\r\n').join('');
  fs.writeFileSync(batPath, '@echo off\r\n' + body, 'ascii');

  const script =
    `Start-Process -FilePath '${psQuote(batPath)}' -Verb RunAs -Wait -WindowStyle Hidden`;

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 60000, windowsHide: true },
      (err, stdout, stderr) => {
        // A cancelled UAC prompt makes PowerShell throw "The operation was
        // canceled by the user"; that is a user choice, not a failure to report
        // as an error dialog.
        const cancelled = /cancel/i.test(String(stderr || '') + String(stdout || ''));
        resolve({ ok: !err && !cancelled, cancelled, error: err ? err.message : null });
      },
    );
  });
}

function addRuleLines(profile) {
  const p = profile === 'private' ? 'private,domain' : 'any';
  const lines = [
    `@netsh advfirewall firewall delete rule name="${RULE_NAME}"`,
    `@netsh advfirewall firewall add rule name="${RULE_NAME}" dir=in action=allow ` +
      `protocol=TCP localport=${TCP_PORTS.join(',')} enable=yes profile=${p} ` +
      `description="${RULE_DESCRIPTION}"`,
    `@netsh advfirewall firewall add rule name="${RULE_NAME}" dir=in action=allow ` +
      `protocol=UDP localport=${UDP_PORTS.join(',')} enable=yes profile=${p} ` +
      `description="${RULE_DESCRIPTION}"`,
  ];
  return lines;
}

async function status() {
  if (!IS_WINDOWS) {
    return { supported: false, installed: false, ports: { tcp: TCP_PORTS, udp: UDP_PORTS } };
  }
  const res = await runNetsh(['show', 'rule', `name=${RULE_NAME}`], 20000);
  if (!res.ok) {
    // netsh exits non-zero ("No rules match") when nothing is installed.
    return { supported: true, installed: false, ports: { tcp: TCP_PORTS, udp: UDP_PORTS } };
  }
  const out = res.stdout;
  const rules = (out.match(/Rule Name/gi) || []).length;
  const installed = /8888/.test(out) && /9999/.test(out);
  return {
    supported: true,
    installed: installed && rules >= 2,
    ruleCount: rules,
    ports: { tcp: TCP_PORTS, udp: UDP_PORTS },
  };
}

/**
 * Create the inbound rules, elevating once.
 * @param {'any'|'private'} profile
 */
async function allow(profile) {
  if (!IS_WINDOWS) return { ok: true, skipped: true };
  const res = await runElevatedBatch(addRuleLines(profile === 'private' ? 'private' : 'any'));
  if (!res.ok) return { ok: false, cancelled: !!res.cancelled, error: res.error };
  const after = await status();
  return { ok: after.installed, cancelled: false, error: after.installed ? null : 'netsh reported success but the rules are missing' };
}

/** Remove every rule this app created (also needs elevation). */
async function remove() {
  if (!IS_WINDOWS) return { ok: true, skipped: true };
  const res = await runElevatedBatch([
    `@netsh advfirewall firewall delete rule name="${RULE_NAME}"`,
  ]);
  if (!res.ok) return { ok: false, cancelled: !!res.cancelled, error: res.error };
  const after = await status();
  return { ok: !after.installed, cancelled: false };
}

module.exports = {
  supported: IS_WINDOWS,
  RULE_NAME,
  TCP_PORTS,
  UDP_PORTS,
  status,
  allow,
  remove,
  _internals: { runNetsh, runElevatedBatch, addRuleLines, psQuote },
};