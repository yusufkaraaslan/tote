package com.tote.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.net.URI;

/** No Android dependencies: the native boundary independently validates renderer requests. */
final class UpdatePolicy {
    static final long APK_LIMIT = 256L * 1024 * 1024;
    static int compare(String a, String b) {
        UpdateRelease.url(a); UpdateRelease.url(b);
        String[] x = a.split("\\."), y = b.split("\\.");
        for (int i=0; i<3; i++) { int d = Integer.compare(Integer.parseInt(x[i]), Integer.parseInt(y[i])); if (d != 0) return d; }
        return 0;
    }
    static String assetURL(String version, String name) {
        UpdateRelease.url(version);
        if (!name.matches("[A-Za-z0-9_.-]+")) throw new IllegalArgumentException("Invalid update filename");
        return "https://github.com/yusufkaraaslan/tote/releases/download/v" + version + "/" + name;
    }
    static void redirect(String value) {
        URI u = URI.create(value);
        if (!"https".equals(u.getScheme()) || u.getUserInfo() != null || u.getPort() != -1 || u.getFragment() != null ||
            !("release-assets.githubusercontent.com".equals(u.getHost()) ||
              ("github.com".equals(u.getHost()) && u.getPath().startsWith("/yusufkaraaslan/tote/releases/download/"))))
            throw new IllegalArgumentException("Update redirect left the release publisher");
    }
    static long integer(JSONObject object, String key) {
        Object value = object.opt(key);
        if (!(value instanceof Integer || value instanceof Long)) throw new IllegalArgumentException("Invalid " + key);
        return ((Number)value).longValue();
    }
    static JSONObject artifact(JSONObject m, String latest, String current, long currentCode, int protocol, int sdk) throws Exception {
        if (integer(m,"updateSchema") != 1 || !Boolean.TRUE.equals(m.opt("signed")) || !latest.equals(m.opt("version")) ||
            compare(latest,current) <= 0 || integer(m,"protocol") != protocol || integer(m,"androidVersionCode") <= currentCode ||
            integer(m,"androidVersionCode") > Integer.MAX_VALUE || integer(m,"androidMinSdkVersion") < 33 || integer(m,"androidMinSdkVersion") > sdk)
            throw new IllegalArgumentException("This release is not a compatible production update");
        JSONArray platforms = m.getJSONArray("releasePlatforms"); boolean android = false;
        for (int i=0; i<platforms.length(); i++) android |= "android".equals(platforms.opt(i));
        if (!android) throw new IllegalArgumentException("Android is not in this release");
        JSONArray files = m.getJSONArray("files");
        if (files.length() > 16) throw new IllegalArgumentException("Too many release files");
        String name = "Tote-" + latest + "-android.apk"; JSONObject found = null;
        for (int i=0; i<files.length(); i++) {
            JSONObject f = files.getJSONObject(i);
            if (name.equals(f.opt("name")) && "android".equals(f.opt("platform"))) {
                if (found != null) throw new IllegalArgumentException("Duplicate update package");
                found = f;
            }
        }
        if (found == null || !(found.opt("sha256") instanceof String) || !found.getString("sha256").matches("[a-f0-9]{64}") ||
            integer(found,"size") <= 0 || integer(found,"size") > APK_LIMIT) throw new IllegalArgumentException("Invalid update package");
        return found;
    }
}
