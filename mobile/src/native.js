import { registerPlugin } from '@capacitor/core';
export const Native = registerPlugin('ToteNative');
export const Discovery = registerPlugin('ToteDiscovery');
export const Speech = registerPlugin('ToteSpeech');
const sockets = new Map();
let sequence = 0;
export async function initNative() {
  await Native.addListener('socket', event => {
    const socket = sockets.get(event.id);
    if (!socket) return;
    if (event.type === 'open') socket.onopen?.();
    if (event.type === 'message') socket.onmessage?.({ data: event.data });
    if (event.type === 'error') socket.onerror?.({ message: event.message });
    if (event.type === 'close') { socket.onclose?.(); sockets.delete(event.id); }
  });
}
export function socketFactory(address, port) {
  const id = String(++sequence);
  const socket = {
    send(data) { Native.send({ id, data }).catch(e => socket.onerror?.(e)); },
    close() { sockets.delete(id); Native.disconnect({ id }).catch(() => {}); },
  };
  sockets.set(id, socket);
  // Plugin completion is async; handlers are installed by the caller first.
  Native.connect({ id, address, port }).catch(e => socket.onerror?.(e));
  return socket;
}
