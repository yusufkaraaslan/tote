package com.tote.mobile;

import java.util.HashMap;

/** Bounds strings waiting in the native-to-WebView bridge, including old hosts. */
final class SocketBudget {
    private final long limit;
    private final int frames;
    private final HashMap<Long, Long> pending = new HashMap<>();
    private long bytes, sequence;
    private boolean closed;
    SocketBudget(long limit, int frames) { this.limit = limit; this.frames = frames; }
    synchronized long reserve(long size) {
        if (closed || size < 0 || pending.size() >= frames || size > limit - bytes) return 0;
        long id = ++sequence;
        pending.put(id, size); bytes += size; return id;
    }
    synchronized void release(long id) {
        Long size = pending.remove(id); if (size != null) bytes -= size;
    }
    synchronized void close() { closed = true; pending.clear(); bytes = 0; }
    synchronized int pendingFrames() { return pending.size(); }
    synchronized long bytes() { return bytes; }
}
