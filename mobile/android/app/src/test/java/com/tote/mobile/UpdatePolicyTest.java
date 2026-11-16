package com.tote.mobile;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;
public class UpdatePolicyTest {
    private JSONObject manifest() throws Exception {
        return new JSONObject("{\"updateSchema\":1,\"signed\":true,\"version\":\"0.6.0\",\"protocol\":1,\"androidVersionCode\":12,\"androidMinSdkVersion\":33,\"releasePlatforms\":[\"android\"],\"files\":[{\"name\":\"Tote-0.6.0-android.apk\",\"platform\":\"android\",\"size\":100,\"sha256\":\""+"a".repeat(64)+"\"}]}");
    }
    @Test public void validatesNativeBoundaryAndRejectsRollback() throws Exception {
        assertEquals("Tote-0.6.0-android.apk",UpdatePolicy.artifact(manifest(),"0.6.0","0.5.0",11,1,33).getString("name"));
        for (String key : new String[]{"updateSchema","signed","version","protocol","androidVersionCode","androidMinSdkVersion","files","releasePlatforms"}) {
            JSONObject m = manifest(); m.remove(key);
            assertThrows(Exception.class,()->UpdatePolicy.artifact(m,"0.6.0","0.5.0",11,1,33));
        }
        assertThrows(Exception.class,()->UpdatePolicy.artifact(manifest(),"0.6.0","0.6.0",12,1,33));
        assertThrows(Exception.class,()->UpdatePolicy.artifact(manifest(),"0.6.0","0.5.0",12,1,33));
        assertThrows(Exception.class,()->UpdatePolicy.artifact(manifest(),"0.6.0","0.5.0",11,2,33));
        assertThrows(Exception.class,()->UpdatePolicy.artifact(manifest(),"0.6.0","0.5.0",11,1,32));
        JSONObject m = manifest();m.put("androidVersionCode","12");
        assertThrows(Exception.class,()->UpdatePolicy.artifact(m,"0.6.0","0.5.0",11,1,33));
        JSONObject duplicate = manifest();duplicate.getJSONArray("files").put(duplicate.getJSONArray("files").get(0));
        assertThrows(Exception.class,()->UpdatePolicy.artifact(duplicate,"0.6.0","0.5.0",11,1,33));
    }
    @Test public void redirectsCannotEscapePublisherOrDowngradeTransport() {
        UpdatePolicy.redirect("https://release-assets.githubusercontent.com/file?temporary=1");
        for (String url : new String[]{"http://github.com/yusufkaraaslan/tote/releases/download/x","https://evil.invalid/file","https://github.com/other/repo/file","https://u:p@release-assets.githubusercontent.com/file","https://release-assets.githubusercontent.com:444/file"}) assertThrows(IllegalArgumentException.class,()->UpdatePolicy.redirect(url));
    }
}
