# Security policy

## Supported versions

Security fixes target the current `main` branch and are included in the next release. Use the
latest published release for deployments and review its release notes before upgrading. Older
pre-1.0 releases do not have a separate maintenance branch or a guaranteed support period.

## Report a vulnerability

Do not publish exploit details or secrets in an issue. Use [GitHub private vulnerability reporting](https://github.com/0then0/CineClue/security/advisories/new)
if the repository exposes that option. Otherwise contact the repository owner through a private
contact method listed on their [GitHub profile](https://github.com/0then0). If neither channel is
available, open an issue requesting a private security contact, without reproduction steps,
affected endpoints, secrets or exploit details. Wait for a private channel before sharing the report.

Include the affected revision, reproduction steps, expected and actual behavior, and impact. Redact API tokens, visitor cookies and private database contents. Test with disposable local data; do not probe third-party or production systems without permission.

The maintainer will assess the report, request clarification where needed and coordinate a fix
and disclosure. This volunteer project does not promise a response deadline or a bug bounty.
Please allow coordination before publishing technical details.

## Hosting securely

Use HTTPS, a private `DAILY_SECRET` and deployment-specific database credentials. The default Compose setup binds to localhost and uses development settings. Visitor cookies grant access to anonymous games and must be treated as credentials. Database backups can contain those credentials.

See [deployment](docs/DEPLOYMENT.md) for proxy identity, request limits and backups. Factual catalog corrections belong in ordinary issues unless they expose private information.
