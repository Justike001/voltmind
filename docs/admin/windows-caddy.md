# Windows Admin UI → Ubuntu VoltMind Host

The Windows machine serves the existing SPA and proxies all Host-only paths to Ubuntu. The browser never receives a Supabase password, Gogs token/private key, OAuth client-secret hash, or Ubuntu filesystem path.
`VOLTMIND_GOGS_ADMIN_TOKEN` is read only by Ubuntu for the redacted `/gogs` health probe.

## Ubuntu service

Run VoltMind on loopback when Caddy is on the same Ubuntu host, or on a VPN-only address when Caddy is on Windows. Set the public Admin origin to the exact HTTPS origin shown in the browser:

```bash
export VOLTMIND_ADMIN_BOOTSTRAP_TOKEN='<strong 32+ character secret>'
export VOLTMIND_ADMIN_PUBLIC_URL='https://admin.example.internal'
export VOLTMIND_GOGS_ADMIN_TOKEN='<Host-only Gogs PAT>'
voltmind serve --http --bind 100.64.0.10 --port 3131 \
  --admin-api-only --suppress-bootstrap-token
```

Firewall port 3131 to the Windows/Tailscale address only. Do not publish it to the Internet. `--public-url` remains the OAuth/MCP issuer and is intentionally separate from `--admin-public-url`.

## Windows Caddyfile

```caddyfile
admin.example.internal {
    encode zstd gzip

    @voltmind path /admin/api/* /admin/login /admin/auth/* /admin/events
    reverse_proxy @voltmind 100.64.0.10:3131 {
        header_up Host {host}
        header_up X-Forwarded-Proto {scheme}
    }

    root * C:\\voltmind-admin\\dist
    try_files {path} /index.html
    file_server
}
```

Use one origin: frontend requests must use relative URLs such as `/admin/api/v1/sources`. Do not enable CORS credentials. Login or the one-time `/admin/auth/...` magic link sets an HttpOnly, SameSite=Strict cookie on the Windows public origin. The frontend first calls `GET /admin/api/v1/session`, keeps the returned CSRF token in memory, and sends it as `X-VoltMind-CSRF` on every POST/PUT/PATCH/DELETE.

Archive is the only source deletion operation exposed by v1. It revokes source-bound OAuth clients and bearer tokens. Restore never restores old credentials; create or rotate a client explicitly.
