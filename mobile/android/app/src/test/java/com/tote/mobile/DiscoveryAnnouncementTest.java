package com.tote.mobile;
import org.junit.Test;
import org.json.JSONObject;
import static org.junit.Assert.*;
public class DiscoveryAnnouncementTest {
    private final String valid = "{\"t\":\"tote:device\",\"v\":1,\"address\":\"100.64.1.2\",\"port\":47821,\"name\":\"Studio\"}";
    @Test public void acceptsMatchingTailnetSource() throws Exception {
        JSONObject result=DiscoveryAnnouncement.parse("100.64.1.2",valid);
        assertNotNull(result);assertEquals("Studio",result.getString("name"));assertEquals(47821,result.getInt("port"));
    }
    @Test public void filtersDirectoryHints() throws Exception {
        JSONObject message=new JSONObject(valid);
        message.put("peers",new org.json.JSONArray("[{\"address\":\"100.64.1.3\",\"port\":47821},{\"address\":\"192.168.1.3\",\"port\":47821},{\"address\":\"100.64.1.4\",\"port\":0}]"));
        JSONObject result=DiscoveryAnnouncement.parse("100.64.1.2",message.toString());
        assertEquals(1,result.getJSONArray("peers").length());
        assertEquals("100.64.1.3",result.getJSONArray("peers").getJSONObject(0).getString("address"));
    }
    @Test public void rejectsLanSpoofedMalformedAndIncompatibleHints() {
        assertNull(DiscoveryAnnouncement.parse("192.168.1.2",valid));
        assertNull(DiscoveryAnnouncement.parse("100.64.1.3",valid));
        assertNull(DiscoveryAnnouncement.parse("100.64.1.2","bad JSON"));
        assertNull(DiscoveryAnnouncement.parse("100.64.1.2",valid.replace("\"v\":1","\"v\":2")));
        assertNull(DiscoveryAnnouncement.parse("100.64.1.2",valid.replace("47821","0")));
        assertNull(DiscoveryAnnouncement.parse("100.64.1.2",valid.replace("47821","65536")));
        assertNull(DiscoveryAnnouncement.parse("100.64.1.2","x".repeat(1025)));
    }
}
