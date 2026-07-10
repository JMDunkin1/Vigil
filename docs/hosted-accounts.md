# Hosted accounts foundation

Sentinel is local-first. Hosted accounts are disabled unless the server is started with an explicit public host allowlist:

```sh
SENTINEL_AUTH_ENABLED=1 \
SENTINEL_PUBLIC_HOSTS=sentinel.example.com \
npm start
```

Put the server behind an HTTPS reverse proxy and preserve the original `Host` and `X-Forwarded-Proto` headers. HTTPS requests receive `Secure`, HTTP-only, same-site session cookies. Do not bind the Node server directly to an internet-facing interface without a TLS proxy, firewall, logging, backups, and request-rate limits.

## Account behavior

- The first registered account becomes the administrator.
- Later registrations become members.
- Administrators can mutate protection and settings APIs.
- Members can read the shared workspace but cannot change it.
- Passwords are stored as salted scrypt hashes in ignored local application data.
- Sessions are signed, expire after seven days, and are sent in HTTP-only cookies.
- Set `SENTINEL_SIGNUPS_ENABLED=0` after creating the desired accounts to close open registration.
- Set `SENTINEL_LOCAL_ADMIN_NAME` to change the name shown for the default local-only administrator profile.

The account data lives beside Sentinel state in `accounts.json`; the signing secret is stored separately in `auth-secret.key`. Both files must remain private and should be included in encrypted server backups.

## Boundary of this foundation

This is a single shared Sentinel workspace, not tenant isolation. Authenticated users currently share the same policies, usage data, journal surface, and device controls. Before offering Sentinel as a public service for unrelated customers, move account and workspace data into a transactional database, add per-workspace ownership to every record and API, add email verification and password recovery, add login throttling and audit logs, and test authorization at every route. The local Mac enforcement and iPhone/MDM components also need an authenticated device-agent design; a hosted web process cannot directly enforce policies on a remote Mac by itself.
