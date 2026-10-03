'use strict';
/**
 * preload.js — The only bridge between the renderer and Node.
 *
 * Context isolation stays on and Node integration stays off: the renderer can
 * only invoke the specific operations listed below, never raw `ipcRenderer`.
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

const listeners = {
  state: new Set(),
  walkieAudio: new Set(),
  callAudio: new Set(),
  callVideo: new Set(),
};

ipcRenderer.on('walkie:state', (_event, snapshot, reason) => {
  for (const fn of listeners.state) {
    try { fn(snapshot, reason); } catch (e) { console.error(e); }
  }
});

ipcRenderer.on('walkie:audioIn', (_event, pcm, from) => {
  for (const fn of listeners.walkieAudio) {
    try { fn(pcm, from); } catch (e) { console.error(e); }
  }
});

ipcRenderer.on('walkie:callAudioIn', (_event, pcm, from) => {
  for (const fn of listeners.callAudio) {
    try { fn(pcm, from); } catch (e) { console.error(e); }
  }
});

ipcRenderer.on('walkie:callVideoIn', (_event, jpeg, from) => {
  for (const fn of listeners.callVideo) {
    try { fn(jpeg, from); } catch (e) { console.error(e); }
  }
});

contextBridge.exposeInMainWorld('walkie', {
  // -- queries
  getState: () => invoke('walkie:getState'),
  getGlobalMessages: () => invoke('walkie:getGlobalMessages'),
  getChatMessages: (chatId) => invoke('walkie:getChatMessages', chatId),
  appInfo: () => invoke('walkie:appInfo'),
  rescan: () => invoke('walkie:rescan'),

  // -- settings / identity
  setDisplayName: (name) => invoke('walkie:setDisplayName', name),
  setChannel: (channel) => invoke('walkie:setChannel', channel),
  setAutoDelete: (enabled) => invoke('walkie:setAutoDelete', enabled),
  cleanupNow: () => invoke('walkie:cleanupNow'),

  // -- messaging
  sendText: (chatId, text) => invoke('walkie:sendText', chatId, text),
  sendFile: (chatId) => invoke('walkie:sendFile', chatId),
  markRead: (chatId) => invoke('walkie:markRead', chatId),
  toggleStar: (msgId, starred) => invoke('walkie:toggleStar', msgId, starred),
  clearMessages: (chatId) => invoke('walkie:clearMessages', chatId),

  // -- files
  openReceivedDir: () => invoke('walkie:openReceivedDir'),
  openFile: (filePath) => invoke('walkie:openFile', filePath),
  readMedia: (filePath) => invoke('walkie:readMedia', filePath),

  // -- walkie-talkie
  setTransmitting: (value) => invoke('walkie:setTransmitting', value),
  sendWalkieAudio: (base64) => invoke('walkie:sendWalkieAudio', base64),

  // -- windows firewall
  // -- devices
  mediaAccessStatus: () => invoke('walkie:mediaAccessStatus'),

  // -- windows firewall
  firewallStatus: () => invoke('walkie:firewallStatus'),
  firewallAllow: (profile) => invoke('walkie:firewallAllow', profile),
  firewallRemove: () => invoke('walkie:firewallRemove'),

  // -- calls
  initiateCall: (peerIp, isVideo) => invoke('walkie:initiateCall', peerIp, isVideo),
  acceptCall: () => invoke('walkie:acceptCall'),
  declineCall: () => invoke('walkie:declineCall'),
  endCall: () => invoke('walkie:endCall'),
  setCallMic: (muted) => invoke('walkie:setCallMic', muted),
  setCallVideo: (enabled) => invoke('walkie:setCallVideo', enabled),
  sendCallAudio: (base64) => invoke('walkie:sendCallAudio', base64),
  sendCallVideo: (base64) => invoke('walkie:sendCallVideo', base64),

  // -- events
  onState: (fn) => {
    listeners.state.add(fn);
    return () => listeners.state.delete(fn);
  },
  onWalkieAudio: (fn) => {
    listeners.walkieAudio.add(fn);
    return () => listeners.walkieAudio.delete(fn);
  },
  onCallAudio: (fn) => {
    listeners.callAudio.add(fn);
    return () => listeners.callAudio.delete(fn);
  },
  onCallVideo: (fn) => {
    listeners.callVideo.add(fn);
    return () => listeners.callVideo.delete(fn);
  },
});