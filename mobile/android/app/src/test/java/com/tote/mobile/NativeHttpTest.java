package com.tote.mobile;

import static org.junit.Assert.*;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import mockwebserver3.MockResponse;
import mockwebserver3.MockWebServer;
import okhttp3.*;
import org.junit.Test;

public class NativeHttpTest {
    private static final class Peer extends WebSocketListener {
        final LinkedBlockingQueue<String> messages = new LinkedBlockingQueue<>();
        final LinkedBlockingQueue<WebSocket> opened = new LinkedBlockingQueue<>();
        final LinkedBlockingQueue<Integer> failures = new LinkedBlockingQueue<>();
        @Override public void onOpen(WebSocket ws, Response response) { opened.add(ws); }
        @Override public void onMessage(WebSocket ws, String text) { messages.add(text); }
        @Override public void onClosing(WebSocket ws, int code, String reason) { ws.close(code, reason); }
        @Override public void onFailure(WebSocket ws, Throwable error, Response response) {
            failures.add(response == null ? 0 : response.code());
        }
    }

    @Test public void websocketTextCancellationAndFreshConnection() throws Exception {
        OkHttpClient client = NativeHttp.client();
        WebSocket first = null, second = null;
        try (MockWebServer server = new MockWebServer()) {
            Peer host = new Peer(), phone = new Peer();
            server.enqueue(new MockResponse.Builder().webSocketUpgrade(host).build());
            server.start();
            Request request = new Request.Builder().url(server.url("/device")).build();
            first = client.newWebSocket(request, phone);
            assertNotNull(phone.opened.poll(5, TimeUnit.SECONDS));
            WebSocket remote = host.opened.poll(5, TimeUnit.SECONDS);
            assertNotNull(remote);
            String output = "\u001b[38;2;12;180;90mTürkçe 世界\u001b[0m";
            assertTrue(remote.send(output));
            assertEquals(output, phone.messages.poll(5, TimeUnit.SECONDS));
            assertTrue(first.send("input-once"));
            assertEquals("input-once", host.messages.poll(5, TimeUnit.SECONDS));
            first.cancel();
            assertNotNull(phone.failures.poll(5, TimeUnit.SECONDS));
            assertFalse(first.send("after-disconnect"));

            Peer nextHost = new Peer(), nextPhone = new Peer();
            server.enqueue(new MockResponse.Builder().webSocketUpgrade(nextHost).build());
            second = client.newWebSocket(request, nextPhone);
            assertNotNull(nextPhone.opened.poll(5, TimeUnit.SECONDS));
            WebSocket nextRemote = nextHost.opened.poll(5, TimeUnit.SECONDS);
            assertNotNull(nextRemote);
            assertTrue(nextRemote.send("fresh-replay"));
            assertEquals("fresh-replay", nextPhone.messages.poll(5, TimeUnit.SECONDS));
            assertTrue(second.send("new-input"));
            assertEquals("new-input", nextHost.messages.poll(5, TimeUnit.SECONDS));
            assertNull(nextHost.messages.poll(200, TimeUnit.MILLISECONDS));
            assertTrue(second.close(1000, "finished"));
        } finally {
            if (first != null) first.cancel();
            if (second != null) second.cancel();
            client.dispatcher().executorService().shutdownNow();
            client.connectionPool().evictAll();
        }
    }

    @Test public void websocketRedirectCannotEscapeTheSelectedHost() throws Exception {
        OkHttpClient client = NativeHttp.client();
        WebSocket socket = null;
        try (MockWebServer server = new MockWebServer(); MockWebServer other = new MockWebServer()) {
            other.start();
            server.enqueue(new MockResponse.Builder().code(302).addHeader("Location", other.url("/other")).build());
            server.start();
            Peer phone = new Peer();
            socket = client.newWebSocket(new Request.Builder().url(server.url("/device")).build(), phone);
            assertEquals(Integer.valueOf(302), phone.failures.poll(5, TimeUnit.SECONDS));
            assertNull(other.takeRequest(200, TimeUnit.MILLISECONDS));
        } finally {
            if (socket != null) socket.cancel();
            client.dispatcher().executorService().shutdownNow();
            client.connectionPool().evictAll();
        }
    }
}
