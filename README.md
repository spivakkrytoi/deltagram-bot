# DeltaGram Telegram Bot

A self-hosted Telegram bot for the DeltaGram MTProto server: persistent phone
numbers, login-code delivery, Stars purchases, referrals, promos, support
tickets and an owner panel.

The bot runs independently from the MTProto server, so a bot outage does not
stop DeltaGram itself.

> **This repository contains no credentials.** Bot tokens, database passwords,
> webhook secrets and API tokens are supplied through the environment
> (`.env`, a secrets manager, or your orchestrator). Never commit `.env`.

## Features

- persistent number for every user on `/start` (random-number mode);
- real-number mode where users bind their own Telegram phone via contact sharing;
- login codes are delivered only through the configured server channel — the bot
  never accepts or relays Telegram OTPs typed by users;
- free number replacement and paid anonymous `+888` numbers;
- Premium, server Stars and collectible username purchases with Telegram Stars;
- invoices, payment deduplication and a durable sales journal;
- compensated refunds (Stars, Premium, usernames, paid numbers);
- daily bonuses, referrals and a weighted wheel;
- promo codes and button-based giveaways;
- optional owner-only “Свой NFT” shop tab for the Gift Lab Mini App (`GIFTLAB_URL`);
- support tickets;
- Russian and English localization;
- per-user language and notification settings;
- owner-only statistics, broadcasts, grants, invoices, refunds, login-code
  access, support replies and store configuration;
- optional required-channel membership gate;
- optional SOCKS5 proxy for the Telegram Bot API.

## Requirements

- Docker and Docker Compose v2+ (or Node.js 22.13+)
- a Telegram bot token from [@BotFather](https://t.me/BotFather)
- a DeltaGram Admin API instance and its bearer token
- PostgreSQL 16 (provided by the Compose file)

## Quick start

```bash
git clone https://github.com/spivakkrytoi/deltagram-bot.git
cd deltagram-bot
cp .env.example .env
# Edit .env and fill in the required values.
docker compose up -d --build
docker compose logs -f grammystore
```

On the first start the container applies the database schema from
`db/migrations/`, then starts the bot.

### Running without Docker

```bash
npm install
npm test
npm start
```

`npm start` applies migrations and starts the bot. A local PostgreSQL instance
is required; connection settings come from `POSTGRES_*` (see
`src/config.js`).

## Configuration

All settings are environment variables. The complete list with comments lives
in [`.env.example`](.env.example). The required ones are:

| Variable | Purpose |
| --- | --- |
| `BOT_TOKEN` | Telegram Bot API token from @BotFather |
| `OWNER_IDS` | Comma-separated Telegram user IDs with owner access |
| `GRAMSRV_API` | Base URL of the DeltaGram Admin API |
| `GRAMSRV_TOKEN` | Bearer token for the DeltaGram Admin API |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Database credentials |
| `CODE_WEBHOOK_SECRET` | HMAC secret for verifying server OTP webhook calls (24+ chars) |
| `DELTAMENT_AUTH_SECRET` | Shared secret for the Deltament auth bridge |

Optional settings include `BOT_MODE` (`random` or `real`), `PRODUCT_NAME`,
`PUBLIC_BASE_URL`, `DEFAULT_LANGUAGE`, `REQUIRED_CHANNEL`, referral/daily bonus
amounts, recurring Stars grants and a SOCKS5 proxy.

### Login-code delivery

The DeltaGram server calls the bot's HTTP webhook at `POST /v1/otp/deliveries`.
Every request is signed with `CODE_WEBHOOK_SECRET` (HMAC-SHA256 over the
timestamp and raw body). The bot stores the delivery idempotently and forwards
the code to the Telegram chat bound to that number. The endpoint is
`/healthz` for liveness checks.

See [`NUMBER_LIFECYCLE.md`](NUMBER_LIFECYCLE.md) for the number ownership and
retirement rules.

## Security

- Keep `.env` out of version control. `.gitignore` and `.dockerignore` already
  exclude it.
- Rotate `BOT_TOKEN`, `GRAMSRV_TOKEN`, `CODE_WEBHOOK_SECRET` and
  `DELTAMENT_AUTH_SECRET` if they are ever exposed.
- Do not paste tokens, private keys, session files or production database dumps
  into issues or pull requests.
- Please report vulnerabilities privately as described in
  [`SECURITY.md`](SECURITY.md).

## Tests

```bash
npm run check   # syntax check of the runtime modules
npm test        # Node test runner
```

The suite covers payments, refunds, OTP delivery, number lifecycle, admin
actions and localization. Some assertions still describe the previous
Stars-rate and number-replacement models; they are tracked as known failures
while the tests are aligned with the current production behaviour. Database
tests skip automatically when PostgreSQL is not reachable.

## Contributing

1. Fork the repository.
2. Create a branch: `git checkout -b feature/my-change`.
3. Keep credentials out of the diff and run `npm test`.
4. Open a pull request describing the change and how it was tested.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for details.

## License

MIT. See [`LICENSE`](LICENSE).
