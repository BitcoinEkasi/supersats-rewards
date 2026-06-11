# SUPERSATS — Rewards Server

Built by [The Surfer Kids](https://bitcoinekasi.com) in collaboration with **Bitcoin Ekasi**, Mossel Bay, South Africa.

Handles Bitcoin reward payouts for the SUPERSATS programme — BoltCard NFC payments via LNURL-W, Lightning address refills via LNURL-P, and batch disbursements triggered by the companion [supersats-attendance](https://github.com/BitcoinEkasi/supersats-attendance) app at the end of each month.

---

## What it does

- **BoltCard payments (LNURL-W)** — NFC card taps resolve to LNURL-withdraw; the server checks the card balance and returns a Lightning invoice for the tap amount
- **Lightning address refills (LNURL-P)** — participants can receive sats to their card via a Lightning address (`user@yourdomain`)
- **Batch payout API** — the attendance app calls this at report approval to credit each participant's card balance with their monthly reward
- **Reserve management** — tracks a sats reserve; payouts draw from the reserve with invoice-based top-up when the reserve runs low
- **Admin dashboard** — manage cards, view balances, filter by group, monitor transactions
- **Blink integration** — connects to the [Blink](https://www.blink.sv) Lightning wallet via GraphQL API for real Bitcoin settlement

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 / Express 4 |
| Language | TypeScript |
| Database | SQLite via better-sqlite3 (synchronous) |
| Frontend | React + Vite + Tailwind CSS |
| Bitcoin | Blink GraphQL API + WebSocket |
| Deployment | Docker + GitHub Actions CI |

## Quick start

```bash
# 1. Clone and install
git clone https://github.com/BitcoinEkasi/supersats-rewards
cd supersats-rewards
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your values

# 3. Configure Blink credentials
cp blinkapicredentials.example blinkapicredentials
# Edit blinkapicredentials with your Blink API key and wallet ID

# 4. Start the dev server
npm run dev
```

## Environment variables

| Variable | Purpose |
|---|---|
| `BLINK_API_URL` | Blink GraphQL endpoint (`https://api.blink.sv/graphql`) |
| `BLINK_WS_URL` | Blink WebSocket endpoint (`wss://ws.blink.sv/graphql`) |
| `BLINK_API_KEY` | Your Blink API key |
| `BLINK_WALLET_ID` | Your Blink wallet ID |
| `DOMAIN` | Public domain of this server (used in LNURL construction) |
| `JWT_SECRET` | 64 random hex chars — signs admin session tokens |
| `DB_PATH` | Path to the SQLite database file |
| `PORT` | Server port (default `3001`) |
| `ADMIN_USERNAME` | Admin dashboard username |
| `ADMIN_PASSWORD` | Admin dashboard password (remove from env after first run) |

See `.env.example` for a full template.

## Blink credentials file

In addition to the env vars, create a `blinkapicredentials` file (see `blinkapicredentials.example` for the format). This file is gitignored and should never be committed.

## Deployment

Ships as a multi-stage Docker image. On push to `main`, GitHub Actions builds and pushes to GHCR. On the server:

```bash
docker compose pull
docker compose up -d
```

## API

The batch payout endpoint used by the attendance app:

```
POST /api/batch-payout
Authorization: Bearer <BOLT_API_KEY>
```

All other endpoints follow LNURL protocol specs.

## Companion project

Card balances are loaded by the **[supersats-attendance](https://github.com/BitcoinEkasi/supersats-attendance)** app, which generates monthly reports and calls this server's batch payout API at approval time.

## License

[MIT](LICENSE) © BitcoinEkasi
