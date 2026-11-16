package com.tote.mobile;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;
public class UpdateReleaseTest {
    @Test public void onlyStableTypedMetadataCanEnterTheCache() throws Exception {
        JSONObject good = new JSONObject("{\"tag_name\":\"v0.6.0\",\"draft\":false,\"prerelease\":false,\"html_url\":\"https://evil.invalid\"}");
        assertEquals("0.6.0", UpdateRelease.version(good));
        for (String bad : new String[]{"{}", "{\"tag_name\":\"v0.6.0\"}", "{\"tag_name\":\"v0.6.0\",\"draft\":\"false\",\"prerelease\":false}",
            "{\"tag_name\":\"v0.6.0-rc.1\",\"draft\":false,\"prerelease\":false}", "{\"tag_name\":\"v0.6.0\",\"draft\":true,\"prerelease\":false}"}) {
            try { UpdateRelease.version(new JSONObject(bad)); fail("Accepted invalid metadata"); } catch (IllegalArgumentException expected) {}
        }
    }
    @Test public void linksPinTheCheckedVersionAndRejectPaths() {
        assertEquals("https://github.com/yusufkaraaslan/tote/releases/tag/v0.6.0", UpdateRelease.url("0.6.0"));
        for(String bad : new String[]{null,"01.2.3","0.6.0/../../","https://evil.invalid","0.6.0\n"}) {
            try { UpdateRelease.url(bad); fail("Accepted invalid version"); } catch (IllegalArgumentException expected) {}
        }
    }
}
