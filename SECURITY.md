# Security policy

Ambient machine is a local tool: `server.py` binds to 127.0.0.1 only and proxies one
ElevenLabs endpoint so the API key never reaches the browser. The proxy refuses
cross-origin POSTs, so other websites can't spend your credits.

## Reporting a vulnerability

Please report security issues **privately**, not in a public issue: use
[GitHub private vulnerability reporting](https://github.com/glebis/ambient-machine/security/advisories/new)
with a description, steps to reproduce, and the affected commit.

Expect an acknowledgement within a few days. A disclosure timeline will be agreed
before any public details are shared.

## Supported versions

Only the latest commit on `main` receives fixes.
