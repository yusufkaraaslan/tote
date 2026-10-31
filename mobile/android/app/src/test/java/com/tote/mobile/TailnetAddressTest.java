package com.tote.mobile;
import org.junit.Test;
import static org.junit.Assert.*;
public class TailnetAddressTest {
    @Test public void acceptsOnlyLiteralTailnetIPv4() {
        assertTrue(TailnetAddress.valid("100.64.0.1"));
        assertTrue(TailnetAddress.valid("100.127.255.254"));
        for (String address : new String[]{"127.0.0.1","100.63.1.1","100.128.1.1","100.64.0.256","100.64.1.1:80","100.64.1.1/path","host.ts.net","100.064.1.1",null}) assertFalse(TailnetAddress.valid(address));
    }
}
