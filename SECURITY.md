# Security policy

## Reporting a vulnerability

Please report security issues privately. Use GitHub's private vulnerability
reporting for this repository (**Security → Report a vulnerability**) or
contact the maintainer [@spivakkrytoi](https://github.com/spivakkrytoi)
directly.

Do not open a public issue for:

- leaked bot tokens, API tokens, webhook secrets or database credentials;
- authentication or authorization bypasses;
- payment or refund manipulation;
- OTP delivery or signature-verification flaws;
- remote code execution or injection.

Include the affected version/commit, reproduction steps and the impact. We will
acknowledge the report and coordinate a fix and disclosure.

## Secrets in this repository

This repository intentionally contains no credentials. Configuration is read
from the environment. If you believe a secret has been committed, report it
privately so it can be rotated and removed from history.

Never paste live tokens, private keys or production database dumps into issues,
pull requests, discussions or CI logs.
