# HTTP authorities and forwarded endpoints

The daemon still binds only `127.0.0.1`. Before reading a request body, resolving protocol dependencies or opening a console stream, it requires exactly one valid `Host` header. By default that authority must be `localhost`, a numeric IPv4 loopback address, or bracketed IPv6 loopback (`[::1]`), with an optional decimal port from 1 to 65535. The port need not match the daemon's bound port.

Origin and Sec-Fetch protections remain additional checks. A trusted Host does not permit browser-originated writes or cross-origin requests. Forwarded-host headers never supply authority or grant access. The local framed input socket is not HTTP and has no Host requirement.

## `--env-endpoint` and `AIFY_ENV_ENDPOINT`

Comms' installer `--env-endpoint` and env clients' `AIFY_ENV_ENDPOINT` select a URL; they do not grant that URL's Host access. An operator-built forwarder can preserve a non-loopback authority even though the daemon itself listens only on loopback.

To trust that authority explicitly, put this in the existing host file `~/.aify/config.json`, preserving its other settings:

```json
{
  "http": {
    "trustedAuthorities": ["gateway.example:9443", "192.0.2.17:9443"]
  }
}
```

Use the authority the forwarder actually sends, not a URL with a scheme or path. A host-only entry grants that host on any port; `host:port` restricts it to that HTTP port (an omitted HTTP port means 80). DNS names are case-insensitive and IPv6 addresses are bracketed. Wildcards, userinfo, paths, ambiguous abbreviated/hex IPv4 spellings and invalid ports are refused.

The default list is empty. No LAN range, Docker hostname, client endpoint variable or request header adds trust automatically. One malformed list or entry disables **all extra authorities**, reports the `http.trustedAuthorities` problem at transport construction, and leaves normal loopback access available. The existing local-socket preference still recovers to its defaults independently.

This configuration is read when the daemon starts; editing it neither changes the bind address nor reloads a running daemon. Refused HTTP requests return 403 naming `http.trustedAuthorities`; Node's HTTP parser may reject malformed requests earlier with another 4xx.

An authority allowlist is not authentication. Keep any forwarder's network access and credentials under operator control. This setting does not make arbitrary remote access safe, add a new service registry writer, or change which process launches are permitted.
