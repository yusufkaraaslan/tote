package com.tote.mobile;

import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;

/** Shared transport configuration, exercised against real loopback sockets. */
final class NativeHttp {
    static OkHttpClient client() {
        return new OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS)
            .pingInterval(15, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).build();
    }
}
