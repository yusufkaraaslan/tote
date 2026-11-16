package com.tote.mobile;

import org.json.JSONObject;

/** Validate before caching, and construct links only within the public release repository. */
final class UpdateRelease {
    private static final String VERSION = "(?:0|[1-9][0-9]{0,3})\\.(?:0|[1-9][0-9]{0,3})\\.(?:0|[1-9][0-9]{0,3})";
    static String version(JSONObject data) {
        Object tag = data.opt("tag_name");
        if (!(tag instanceof String) || !((String) tag).matches("v" + VERSION)
            || !Boolean.FALSE.equals(data.opt("draft")) || !Boolean.FALSE.equals(data.opt("prerelease"))) {
            throw new IllegalArgumentException("Invalid stable release metadata");
        }
        return ((String) tag).substring(1);
    }
    static String url(String version) {
        if (version == null || !version.matches(VERSION)) throw new IllegalArgumentException("Invalid release version");
        return "https://github.com/yusufkaraaslan/tote/releases/tag/v" + version;
    }
}
