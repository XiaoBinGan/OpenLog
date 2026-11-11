# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Report privately via
GitHub's [Security Advisories](https://github.com/XiaoBinGan/OpenLog/security/advisories/new).

Include the affected version, a description of the issue, and reproduction steps if you
have them. You can expect an initial response within a few days.

## Threat model

OpenLog is designed for **self-hosted deployment on a trusted network**. It executes shell
commands, reads logs, and talks to Docker daemons and SSH hosts — that is its purpose, not
a flaw. Deploy it accordingly.

### What the project does to reduce risk

- **Access token required on every API call.** The token is read from the environment or
  the data file. The frontend sends it in a request header rather than a URL query
  parameter, and the WebSocket handshake carries it as a subprotocol, so it does not end
  up in reverse-proxy access logs.
- **Secrets are masked on read.** Credentials in API responses are reduced to a few
  leading and trailing characters. The write path rejects masked placeholders, so a
  masked string can never be persisted as a real credential.
- **Shell execution is risk-classified.** Destructive commands require explicit
  confirmation. The AI Shell runs with a step limit, a time limit, and an abort path, and
  every command it runs is recorded.
- **Image input is restricted to data URLs** with a MIME allowlist, which blocks
  server-side request forgery via remote image URLs.
- **Static asset handling fails closed.** A missing asset path returns 404 rather than
  falling back to the application shell, so a stale bundle reference cannot silently
  serve HTML where JavaScript was expected.

### What you must do

- Use a long, random access token. Do not reuse a password.
- Terminate TLS in front of the app if it is reachable from anything but localhost.
- Do not expose the Docker socket, SSH credentials, or the container-exec feature to
  untrusted networks.
- Rotate any credential that has ever been committed to a repository. Deleting the file in
  a later commit does not remove it from history.

## Supported versions

Security fixes land on `main`. Run a current build.
