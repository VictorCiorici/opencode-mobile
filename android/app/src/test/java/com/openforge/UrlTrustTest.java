package com.openforge;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class UrlTrustTest {
    @Test
    public void trustsBundledUiOrigin() {
        assertTrue(UrlTrust.isTrusted("https://appassets.androidplatform.net/assets/index.html"));
        assertTrue(UrlTrust.isTrusted("https://appassets.androidplatform.net/assets/index.html#/chat"));
    }

    @Test
    public void trustsDaemonLoopbackPortOnly() {
        assertTrue(UrlTrust.isTrusted("http://127.0.0.1:8787/ui"));
        assertTrue(UrlTrust.isTrusted("http://localhost:8787/ui"));
        assertFalse(UrlTrust.isTrusted("http://127.0.0.1:4100/"));
        assertFalse(UrlTrust.isTrusted("http://127.0.0.1/"));
        assertFalse(UrlTrust.isTrusted("https://127.0.0.1:8787/"));
    }

    @Test
    public void rejectsLookalikesAndExternalOrigins() {
        assertFalse(UrlTrust.isTrusted("http://appassets.androidplatform.net/assets/index.html"));
        assertFalse(UrlTrust.isTrusted("https://appassets.androidplatform.net.evil.com/"));
        assertFalse(UrlTrust.isTrusted("https://evil.com/?u=https://appassets.androidplatform.net"));
        assertFalse(UrlTrust.isTrusted("https://user@appassets.androidplatform.net/"));
        assertFalse(UrlTrust.isTrusted("http://127.0.0.1.nip.io:8787/"));
        assertFalse(UrlTrust.isTrusted("https://github.com/"));
        assertFalse(UrlTrust.isTrusted("file:///android_asset/web/index.html"));
        assertFalse(UrlTrust.isTrusted("javascript:alert(1)"));
        assertFalse(UrlTrust.isTrusted(""));
        assertFalse(UrlTrust.isTrusted(null));
        assertFalse(UrlTrust.isTrusted("not a url"));
    }
}
