package com.tote.mobile;

import android.content.Context;
import android.view.inputmethod.InputMethodManager;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import okhttp3.*;

/** Native sockets avoid weakening the WebView's HTTPS/mixed-content policy.
 * Only literal Tailscale IPv4 addresses are accepted; redirects are disabled.
 * The host remains responsible for same-owner Tailscale whois authorization. */
@CapacitorPlugin(name = "ToteNative")
public class ToteNativePlugin extends Plugin {
    private final ConcurrentHashMap<String, WebSocket> sockets = new ConcurrentHashMap<>();
    private final OkHttpClient http = new OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS)
        .pingInterval(15, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build();

    @PluginMethod public void connect(PluginCall call) {
        String id = call.getString("id"), address = call.getString("address", "");
        int port = call.getInt("port", 47821);
        if (id == null || !id.matches("[0-9]{1,12}") || !TailnetAddress.valid(address) || port < 1 || port > 65535) {
            call.reject("Use a Tailscale IPv4 address and a valid port."); return;
        }
        Request request = new Request.Builder().url("ws://" + address + ":" + port).build();
        WebSocket socket = http.newWebSocket(request, new WebSocketListener() {
            @Override public void onOpen(WebSocket ws, Response response) { emit(id, "open", null, null); }
            @Override public void onMessage(WebSocket ws, String text) {
                if (text.length() > 64 * 1024 * 1024) { ws.cancel(); emit(id, "error", null, "Host frame exceeded the protocol limit."); return; }
                emit(id, "message", text, null);
            }
            @Override public void onClosing(WebSocket ws, int code, String reason) { ws.close(code, reason); }
            @Override public void onClosed(WebSocket ws, int code, String reason) { sockets.remove(id, ws); emit(id, "close", null, reason); }
            @Override public void onFailure(WebSocket ws, Throwable t, Response response) {
                sockets.remove(id, ws);
                String message = response != null && response.code() == 403
                    ? "Computer refused this phone. Use the same Tailscale owner on both devices."
                    : "Cannot reach Tote. Check Tailscale, Share device and the address. " + t.getMessage();
                emit(id, "error", null, message); emit(id, "close", null, message);
            }
        });
        WebSocket previous = sockets.put(id, socket); if (previous != null) previous.cancel();
        call.resolve();
    }
    private void emit(String id, String type, String data, String message) {
        JSObject value = new JSObject(); value.put("id", id); value.put("type", type);
        if (data != null) value.put("data", data); if (message != null) value.put("message", message);
        notifyListeners("socket", value);
    }
    @PluginMethod public void send(PluginCall call) {
        String id = call.getString("id", ""), data = call.getString("data");
        WebSocket socket = sockets.get(id);
        if (socket == null || data == null || !socket.send(data)) { call.reject("Socket is disconnected or its send buffer is full."); return; }
        call.resolve();
    }
    @PluginMethod public void disconnect(PluginCall call) {
        WebSocket socket = sockets.remove(call.getString("id", ""));
        if (socket != null) socket.cancel();
        call.resolve();
    }
    @PluginMethod public void showKeyboard(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            bridge.getWebView().requestFocus();
            InputMethodManager keyboard = (InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
            keyboard.showSoftInput(bridge.getWebView(), InputMethodManager.SHOW_IMPLICIT);
            call.resolve();
        });
    }
    @Override protected void handleOnDestroy() {
        for (WebSocket socket : sockets.values()) socket.cancel(); sockets.clear();
        http.dispatcher().executorService().shutdown(); http.connectionPool().evictAll();
    }
}
