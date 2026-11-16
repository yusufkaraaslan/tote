import { registerPlugin } from '@capacitor/core';
export const Native = registerPlugin('ToteNative');
export const Discovery = registerPlugin('ToteDiscovery');
export const Speech = registerPlugin('ToteSpeech');
const sockets = new Map();
export async function initNative() {
  await Native.addListener('socket', async event => {
    const socket = sockets.get(event.id);
    if (!socket) return;
    if (event.type === 'open') socket.onopen?.();
    if (event.type === 'message') {
      try { await socket.onmessage?.({ data: event.data }); }
      catch (error) { socket.onerror?.(error); }
      finally { if (event.seq) Native.received({ id: event.id, seq: event.seq }).catch(() => {}); }
    }
    if (event.type === 'error') socket.onerror?.({ message: event.message });
    if (event.type === 'close') { socket.onclose?.({ reason: event.message }); sockets.delete(event.id); }
  });
}
export function socketFactory(address, port) {
  // A WebView reload can leave old native callbacks in flight. Never reuse an
  // id from the previous JavaScript runtime for a new socket.
  const id = crypto.randomUUID();
  const socket = {
    send(data) { return Native.send({ id, data }); },
    close() { sockets.delete(id); Native.disconnect({ id }).catch(() => {}); },
  };
  sockets.set(id, socket);
  // Plugin completion is async; handlers are installed by the caller first.
  Native.connect({ id, address, port }).catch(e => socket.onerror?.(e));
  return socket;
}
