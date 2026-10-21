package com.openforge;

import java.net.URI;

/** Origin policy for the WebView: which pages may receive the daemon token. */
final class UrlTrust {
    static final String ASSET_HOST = "appassets.androidplatform.net";
    static final int DAEMON_PORT = 8787;

    private UrlTrust() {}

    static boolean isTrusted(String url) {
        if (url == null || url.isEmpty()) return false;
        URI u;
        try {
            u = new URI(url);
        } catch (Exception e) {
            return false;
        }
        String scheme = u.getScheme();
        String host = u.getHost();
        if (scheme == null || host == null || u.getUserInfo() != null) return false;
        if ("https".equalsIgnoreCase(scheme) && ASSET_HOST.equalsIgnoreCase(host)) return true;
        // Loopback only on the daemon's own port — engines and LAN AI servers
        // listen on other loopback ports and must not receive the token.
        return "http".equalsIgnoreCase(scheme) && u.getPort() == DAEMON_PORT
                && ("127.0.0.1".equals(host) || "localhost".equalsIgnoreCase(host));
    }
}
