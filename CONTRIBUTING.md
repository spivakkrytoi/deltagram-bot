# Contributing

Thanks for taking the time to improve the DeltaGram bot.

## Before you start

- Use Node.js 22.13 or newer.
- Never commit real credentials: no bot tokens, database passwords, webhook
  secrets, API tokens, private keys or production data dumps.
- If you need a new setting, document it in `.env.example` with a safe empty
  default and use a clearly fake value in tests.

## Development

```bash
git clone https://github.com/<your-fork>/deltagram-bot.git
cd deltagram-bot
npm install
cp .env.example .env   # fill in local values; .env is git-ignored
npm test
```

`npm test` uses Node's built-in test runner. Database-backed tests are skipped
automatically when PostgreSQL is not reachable.

## Pull requests

1. Create a topic branch from `main`.
2. Keep the change focused; avoid unrelated formatting churn.
3. Add or update tests for behaviour changes.
4. Run `npm test` and `npm run check`.
5. Describe what changed, why, and how you tested it.

Please do not force-push over review comments. Small, reviewable commits are
preferred.

## Security-sensitive changes

Changes to the OTP webhook, signature verification, payment handling or the
owner panel should include tests and a short threat-model note in the pull
request. Report actual vulnerabilities privately via
[`SECURITY.md`](SECURITY.md), not in a public issue.
