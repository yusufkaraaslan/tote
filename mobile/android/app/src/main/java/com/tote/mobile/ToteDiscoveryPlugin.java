package com.tote.mobile;

import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import org.json.JSONObject;

/** Client discovery only: receives small hints over the existing Tailscale VPN.
 * There is no HTTP/PTY/file server and the receiver never replies to a packet. */
@CapacitorPlugin(name = "ToteDiscovery")
public class ToteDiscoveryPlugin extends Plugin {
    private static final int DISCOVERY_PORT = 47822;
    private final Handler main = new Handler(Looper.getMainLooper());
    private DatagramSocket socket;
    private String scanId;
    private int generation;
    private final Runnable timeout = () -> stopScan(null);

    @PluginMethod public void start(PluginCall call) {
        main.post(() -> {
            stopScan(null);
            int token = ++generation;
            scanId = call.getString("id", "");
            try {
                DatagramSocket receiver = new DatagramSocket(null);
                socket = receiver;
                // Android owns the VPN interface. Listen without selecting Wi-Fi
                // or cellular; validate the Tailscale source before any parsing.
                receiver.bind(new InetSocketAddress("0.0.0.0", DISCOVERY_PORT));
                Thread worker = new Thread(() -> receive(receiver, token), "tote-discovery");
                worker.setDaemon(true); worker.start();
                main.postDelayed(timeout, 20000); call.resolve();
            } catch (Exception error) { stopScan(error.getMessage()); call.reject("Could not start device discovery. " + error.getMessage()); }
        });
    }
    private void receive(DatagramSocket receiver, int token) {
        HashSet<String> seen = new HashSet<>();
        byte[] bytes = new byte[1025];
        while (!receiver.isClosed()) {
            try {
                DatagramPacket packet = new DatagramPacket(bytes, bytes.length);
                receiver.receive(packet);
                if (packet.getLength() > 1024) continue;
                String source = packet.getAddress().getHostAddress();
                if (!TailnetAddress.valid(source)) continue;
                JSONObject candidate = DiscoveryAnnouncement.parse(source,
                    new String(packet.getData(), packet.getOffset(), packet.getLength(), StandardCharsets.UTF_8));
                if (candidate == null || seen.size() >= 64 || !seen.add(source + ":" + candidate.optInt("port") + ":" + candidate.optJSONArray("peers").toString())) continue;
                main.post(() -> {
                    if (token != generation) return;
                    JSObject event = new JSObject(); event.put("scan", scanId);
                    event.put("address", candidate.optString("address")); event.put("port", candidate.optInt("port"));
                    event.put("name", candidate.optString("name")); event.put("peers", candidate.optJSONArray("peers")); notifyListeners("candidate", event);
                });
            } catch (Exception error) {
                if (!receiver.isClosed()) main.post(() -> { if (token == generation) stopScan("Device discovery was interrupted."); });
                return;
            }
        }
    }
    private void stopScan(String error) {
        generation++; main.removeCallbacks(timeout);
        if (socket != null) { socket.close(); socket = null; }
        JSObject event = new JSObject(); event.put("scan", scanId);
        if (error != null) event.put("error", error); notifyListeners("finished", event);
    }
    @PluginMethod public void stop(PluginCall call) { main.post(() -> { stopScan(null); call.resolve(); }); }
    @PluginMethod public void openTailscale(PluginCall call) {
        Intent launch = getContext().getPackageManager().getLaunchIntentForPackage("com.tailscale.ipn");
        if (launch == null) { call.reject("Tailscale is not installed or cannot be opened."); return; }
        getActivity().startActivity(launch); call.resolve();
    }
    @Override protected void handleOnStop() { main.post(() -> stopScan(null)); }
    @Override protected void handleOnDestroy() { main.post(() -> stopScan(null)); }
}
