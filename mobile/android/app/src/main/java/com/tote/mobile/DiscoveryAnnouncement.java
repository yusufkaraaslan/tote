package com.tote.mobile;

import org.json.JSONObject;
import org.json.JSONArray;

/** Incoming UDP only carries a connection hint, never a command. */
final class DiscoveryAnnouncement {
    static JSONObject parse(String source, String text) {
        if (!TailnetAddress.valid(source) || text == null || text.length() > 1024) return null;
        try {
            JSONObject message = new JSONObject(text);
            if (!"tote:device".equals(message.optString("t")) || message.optInt("v") != 1 ||
                !source.equals(message.optString("address"))) return null;
            int port = message.optInt("port");
            if (port < 1 || port > 65535) return null;
            String name = message.optString("name", "Tote");
            JSONObject candidate = new JSONObject();
            candidate.put("address", source); candidate.put("port", port);
            candidate.put("name", name.substring(0, Math.min(name.length(), 80)));
            JSONArray peers = message.optJSONArray("peers"), safe = new JSONArray();
            if (peers != null) for (int i=0; i<Math.min(64,peers.length()); i++) {
                JSONObject peer = peers.optJSONObject(i);
                if (peer == null || !TailnetAddress.valid(peer.optString("address"))) continue;
                int peerPort = peer.optInt("port");
                if (peerPort < 1 || peerPort > 65535) continue;
                JSONObject hint = new JSONObject(); hint.put("address", peer.optString("address")); hint.put("port", peerPort); safe.put(hint);
            }
            candidate.put("peers",safe);
            return candidate;
        } catch (Exception ignored) { return null; }
    }
}
