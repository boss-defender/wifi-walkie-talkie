'use strict';
/**
 * main.js — Electron entry point.
 *
 * Owns the window, the store and the P2P repository, and exposes a narrow,
 * explicitly allow-listed IPC surface to the renderer through preload.js.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, session, systemPreferences, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('./store');
const { P2PRepository } = require('./repository');
const proto = require('./protocol');
const firewall = require('./firewall');

const IS_DEV = process.argv.includes('--dev');

// Windows uses this id to group the taskbar entry and to attribute notifications
// to us rather than to the hosting Electron binary. Harmless elsewhere.
if (process.platform === 'win32' && typeof app.setAppUserModelId === 'function') {
  try {
    app.setAppUserModelId('com.example.walkietalkie');
  } catch (_e) { /* not fatal */ }
}

let mainWindow = null;
let store = null;
let repo = null;

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#1a1c1e',
    show: false,
    autoHideMenuBar: true,
    title: 'WiFi Walkie-Talkie',
    icon: path.join(__dirname, '..', '..', 'build', 'icons', '256x256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.removeMenu();

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // External links open in the user's browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/** Push the current repository snapshot to the renderer. */
function broadcastState(_snapshot, reason) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('walkie:state', repo.snapshot(), reason || '');
  }
}

function getWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

// ---------------------------------------------------------------------------
// microphone / camera permission
// ---------------------------------------------------------------------------

function configureMediaPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'audioCapture' || permission === 'videoCapture') {
      callback(true);
      return;
    }
    callback(false);
  });
  ses.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media' || permission === 'audioCapture' || permission === 'videoCapture') {
      return true;
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        console.error(`[ipc] ${channel} failed:`, e.message);
        return { ok: false, error: e.message };
      }
    });
  };

  handle('walkie:getState', () => repo.snapshot());
  handle('walkie:getGlobalMessages', () => repo.store.getGlobalMessages());
  handle('walkie:getChatMessages', (chatId) => repo.store.getMessagesForChat(chatId));

  handle('walkie:rescan', async () => repo.rescan());

  handle('walkie:setDisplayName', (name) => {
    const ok = repo.setDisplayName(name);
    return { ok, displayName: repo.displayName };
  });
  handle('walkie:setChannel', (channel) => ({ channel: repo.setChannel(channel) }));
  handle('walkie:setAutoDelete', (enabled) => {
    repo.setAutoDelete(enabled);
    return { enabled: repo.autoDeleteOldMessages };
  });
  handle('walkie:cleanupNow', () => ({ removed: repo.cleanUpOldMessagesNow() }));

  handle('walkie:sendText', (chatId, text) => ({ ok: repo.sendTextMessage(chatId, text) }));
  handle('walkie:markRead', (chatId) => {
    repo.markChatAsRead(chatId);
    return { ok: true };
  });
  handle('walkie:toggleStar', (msgId, starred) => {
    repo.toggleMessageStar(msgId, starred);
    return { ok: true };
  });
  handle('walkie:clearMessages', (chatId) => ({ removed: repo.clearMessages(chatId) }));

  handle('walkie:sendFile', async (chatId) => {
    const win = getWindow();
    if (!win) return { ok: false, error: 'window closed' };
    const result = await dialog.showOpenDialog(win, {
      title: 'Send a file over the local network',
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };

    const sent = [];
    for (const filePath of result.filePaths) {
      const r = await repo.sendMediaFile(chatId, filePath, null);
      sent.push({ filePath, ...r });
    }
    return { ok: true, sent };
  });

  handle('walkie:readMedia', (filePath) => {
    if (typeof filePath !== 'string' || !filePath) return null;
    // Strictly limited to files inside our own received-files directory.
    const resolved = path.resolve(filePath);
    const baseDir = path.resolve(store.receivedDir);
    if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) return null;

    let stat;
    try { stat = fs.statSync(resolved); } catch (_e) { return null; }
    if (!stat.isFile() || stat.size > 12 * 1024 * 1024) return null;

    const mime = mimeFor(resolved);
    if (!mime) return null;
    try {
      return { mime, data: fs.readFileSync(resolved).toString('base64') };
    } catch (_e) {
      return null;
    }
  });

  handle('walkie:openReceivedDir', async () => {
    await shell.openPath(store.receivedDir);
    return { ok: true };
  });
  handle('walkie:openFile', async (filePath) => {
    if (typeof filePath !== 'string' || !filePath) return { ok: false };
    // Only ever open files that live inside our own received directory.
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(store.receivedDir))) return { ok: false };
    const err = await shell.openPath(resolved);
    return { ok: !err, error: err || undefined };
  });

  handle('walkie:setTransmitting', (value) => {
    repo.setTransmitting(value);
    return { ok: true };
  });

  handle('walkie:sendWalkieAudio', (base64) => {
    try {
      repo.media.sendWalkieFrame(Buffer.from(base64, 'base64'));
    } catch (_e) { /* ignore transient send errors */ }
    return { ok: true };
  });

  handle('walkie:initiateCall', (peerIp, isVideo) => ({ ok: repo.initiateCall(peerIp, isVideo) }));
  handle('walkie:acceptCall', () => ({ ok: repo.acceptIncomingCall() }));
  handle('walkie:declineCall', () => ({ ok: repo.declineIncomingCall() }));
  handle('walkie:endCall', () => {
    repo.endCurrentCall();
    return { ok: true };
  });
  handle('walkie:setCallMic', (muted) => {
    repo.setCallMicMuted(muted);
    return { ok: true };
  });
  handle('walkie:setCallVideo', (enabled) => {
    repo.setCallVideoEnabled(enabled);
    return { ok: true };
  });
  handle('walkie:sendCallAudio', (base64) => {
    try {
      repo.media.sendCallAudio(Buffer.from(base64, 'base64'));
    } catch (_e) { /* ignore */ }
    return { ok: true };
  });
  handle('walkie:sendCallVideo', (base64) => {
    try {
      repo.media.sendCallVideo(Buffer.from(base64, 'base64'));
    } catch (_e) { /* ignore */ }
    return { ok: true };
  });

  // OS-level media permission status.
  //
  // There is deliberately NO device enumeration here. Electron exposes no
  // reliable API for it (session.getAllDevices does not exist), and the
  // renderer-side enumerateDevices() returns an empty list until permission has
  // been granted once — so any check built on it wrongly reports "no
  // microphone" on machines that have one. getUserMedia stays the single
  // authority on whether capture is possible.
  //
  // What this DOES answer reliably is whether Windows itself is blocking the
  // device (Settings > Privacy > Microphone), which is a genuinely
  // Windows-specific cause of failure and the single most useful thing to tell a
  // user whose push-to-talk does nothing.
  handle('walkie:mediaAccessStatus', () => {
    const status = (type) => {
      try {
        return systemPreferences.getMediaAccessStatus(type);
      } catch (_e) {
        return 'unknown';
      }
    };
    return {
      available: true,
      microphone: status('microphone'),
      camera: status('camera'),
    };
  });

  handle('walkie:appInfo', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    userData: app.getPath('userData'),
    sampleRate: proto.SAMPLE_RATE,
    platform: process.platform,
    arch: process.arch,
  }));

  handle('walkie:firewallStatus', () => firewall.status());
  handle('walkie:firewallAllow', (profile) => firewall.allow(profile === 'private' ? 'private' : 'any'));
  handle('walkie:firewallRemove', () => firewall.remove());
}

// ---------------------------------------------------------------------------
// first-run firewall prompt
// ---------------------------------------------------------------------------

/**
 * Windows Firewall blocks every inbound connection, so without this a freshly
 * installed copy silently sees "0 peers" while the rest of the app works
 * perfectly. Asked exactly once per installation; the Settings tab can redo or
 * undo it at any time.
 */
async function maybeOfferFirewallRules() {
  if (!firewall.supported) return;
  if (store.getPref('firewall_prompted')) return;

  // Mark it immediately: if the user dismisses the dialog, or the app is killed
  // while the prompt is open, they must not be nagged on every launch.
  store.setPref('firewall_prompted', true);

  let state;
  try {
    state = await firewall.status();
  } catch (e) {
    console.error('[main] firewall status failed:', e.message);
    return;
  }
  if (!state.supported || state.installed) return;

  const win = getWindow();
  const options = {
    type: 'question',
    buttons: ['Allow on all networks', 'Private networks only', 'Not now'],
    defaultId: 0,
    cancelId: 2,
    title: 'Allow connections on your network?',
    message: 'Allow WiFi Walkie-Talkie through Windows Firewall?',
    detail:
      'This app talks only to devices on your own local network — there is no cloud and no internet use.\n\n' +
      `To let other devices find you, Windows needs to allow inbound connections on these ports:\n` +
      `   •  TCP ${firewall.TCP_PORTS.join(', ')}   — signalling, chat and file transfer\n` +
      `   •  UDP ${firewall.UDP_PORTS.join(', ')}  — device discovery, walkie-talkie audio and calls\n\n` +
      'Without this, other devices cannot see this computer and you will always see "0 peers".\n\n' +
      'You can change or remove this at any time in Settings › Windows Firewall.',
    noLink: true,
  };

  try {
    const { response } = await dialog.showMessageBox(win || undefined, options);
    if (response === 0) {
      const res = await firewall.allow('any');
      console.log('[main] firewall rules (all profiles):', res.ok ? 'added' : res);
    } else if (response === 1) {
      const res = await firewall.allow('private');
      console.log('[main] firewall rules (private only):', res.ok ? 'added' : res);
    } else {
      console.log('[main] user declined the firewall prompt');
    }
  } catch (e) {
    console.error('[main] firewall prompt failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

function mimeFor(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || null;
}

// ---------------------------------------------------------------------------
// media events -> renderer
// ---------------------------------------------------------------------------

function wireMediaEvents() {
  repo.media.on('walkie-frame', (frame) => {
    const win = getWindow();
    if (!win) return;
    win.webContents.send('walkie:audioIn', frame.pcm, frame.from);
  });

  repo.media.on('call-audio-frame', (frame) => {
    const win = getWindow();
    if (!win) return;
    win.webContents.send('walkie:callAudioIn', frame.pcm, frame.from);
  });

  repo.media.on('call-video-frame', (frame) => {
    const win = getWindow();
    if (!win) return;
    win.webContents.send('walkie:callVideoIn', frame.jpeg, frame.from);
  });
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    store = new Store(app.getPath('userData')).load();
    repo = new P2PRepository(store, { onStateChange: broadcastState });

    configureMediaPermissions();
    registerIpc();
    wireMediaEvents();
    createWindow();
    repo.start();

    // Never block the first paint on a dialog.
    maybeOfferFirewallRules().catch((e) => console.error('[main] firewall setup failed:', e.message));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    if (repo) repo.stop();
    else if (store) store.close();
  });

  // A GPU/driver crash must not take the whole app down silently — log it and
  // let the user restart the window.
  app.on('render-process-gone', (_event, _wc, details) => {
    console.error('[main] renderer gone:', JSON.stringify(details));
  });
  app.on('child-process-gone', (_event, details) => {
    console.error('[main] child process gone:', JSON.stringify(details));
  });

  process.on('uncaughtException', (err) => {
    console.error('[main] uncaught exception:', err && err.stack ? err.stack : err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[main] unhandled rejection:', reason);
  });
}