# Polymarket Weather Follower

Event-scoped Polymarket weather copy-trading service. It discovers one exact Gamma Event or resolves a recurring Series plus calendar date to one Event, reads leader/follower positions, builds a fee-aware target allocation under a hard event cap, and reconciles that target without replaying historical buys.

## Safety status

- `dry-run` remains the default.
- `authenticated-readonly` verifies the signer/proxy relationship, derives or loads CLOB L2 credentials in memory, and reconciles authenticated open orders and trades without posting orders.
- `live` is guarded by an exact Event or Series environment confirmation, authenticated ledger agreement, balance/allowance preflight, one FOK order per cycle, User WebSocket terminal tracking, authenticated polling recovery, Pushover alerts, and a persistent kill switch.
- Runtime wallets and event slugs belong in ignored `config/runtime.yaml` or environment variables.
- Private keys and CLOB credentials are accepted only through `*_FILE` paths. Never commit or inject their values as plaintext environment variables.

## Ubuntu / Docker quick start

```bash
cp config/example.yaml config/runtime.yaml
# Edit config/runtime.yaml with private runtime parameters.
mkdir -p data
docker compose build
docker compose run --rm follower
```

The Docker build runs TypeScript type checking, unit tests, and production compilation. Persistent dry-run state is stored under the ignored `data/` directory.

## Event selection

For recurring daily weather markets, prefer structured Series/date discovery over substring matching:

```yaml
scope:
  series_slug: "shenzhen-daily-weather"
  event_date: "today" # today, tomorrow, or YYYY-MM-DD
  timezone: "Asia/Hong_Kong"
```

The service resolves the exact Series ID, queries Gamma by `series_id` and `event_date`, and proceeds only when exactly one Event has the expected `seriesSlug` and `eventDate`. Zero or multiple matches fail closed. To pin a single Event instead, configure only `scope.event_slug`. Dynamic live mode additionally requires `POLYMARKET_LIVE_TRADING_SERIES` to exactly equal the configured Series slug.

## Authenticated Ubuntu probe

Encrypted host credentials are loaded by systemd and exposed to Docker only as a runtime file. `compose.auth.yaml` requires `CREDENTIALS_DIRECTORY`, which systemd sets automatically. Keep `execution.mode` at `authenticated-readonly` for the first probe:

```bash
sudo systemd-run --wait --pipe --collect \
  --property=User=ubuntu \
  --property=SupplementaryGroups=docker \
  --property=WorkingDirectory=/home/ubuntu/Polymarket_weather_following \
  --property=LoadCredentialEncrypted=polymarket_private_key:/etc/credstore.encrypted/polymarket-weather-follower/polymarket_private_key.cred \
  /usr/bin/docker compose -f compose.yaml -f compose.auth.yaml run --rm follower \
    --once --config /app/config/runtime.yaml
```

The production unit template is `deploy/polymarket-weather-follower.service`. Do not install or enable it until the read-only probe passes and the runtime mode is deliberately selected.

## Decision audit notifications and live safety

Set `alerts.pushover.enabled: true` in `authenticated-readonly` to receive the authenticated startup/account summary and each new or changed actionable decision. Initial `HOLD` decisions are silent; `BUY`, `SELL`, and `SKIP` changes are sent, as is a later transition back to `HOLD`. Identical 15-second reconciliations are suppressed by a persisted decision fingerprint, while every complete plan remains in SQLite for audit.

Live mode requires alerts plus file-backed `PUSHOVER_APP_TOKEN_FILE` and `PUSHOVER_USER_KEY_FILE`. It sends separate priority-1 notifications for the decision, preflight failure, pre-submission intent, and exchange acceptance. `CONFIRMED` and `CANCELLATION` terminal states are also sent. Ambiguous submissions, `FAILED` trades, unhealthy User WebSocket outages, and execution attempts that remain non-terminal for `execution.terminal_timeout_seconds` (default 180 seconds) arm the persistent kill switch and send priority 2 with event/trade/attempt identifiers. If the pre-submission intent notification cannot be delivered, the attempt is aborted locally before any CLOB request and live trading is stopped.

Pushover delivery attempts, decision fingerprints, and emergency receipts are stored in SQLite without storing either credential. Titles/messages are capped at Pushover's 250/1,024-character API limits.

The kill switch is armed in both SQLite and `data/LIVE_TRADING_DISABLED`. Either source blocks every new live order. The fastest manual stop is safe even if the application cannot start:

```bash
touch data/LIVE_TRADING_DISABLED
```

The audited CLI can arm, inspect, or explicitly clear both sources. In the Ubuntu Docker environment:

```bash
docker compose run --rm --entrypoint node follower dist/src/kill-switch.js arm --config /app/config/runtime.yaml --reason "manual stop"
docker compose run --rm --entrypoint node follower dist/src/kill-switch.js status --config /app/config/runtime.yaml
docker compose run --rm --entrypoint node follower dist/src/kill-switch.js clear --confirm --config /app/config/runtime.yaml --reason "operator reviewed account state"
```

`--once` is intentionally rejected in live mode because an accepted order must remain under continuous User WebSocket and authenticated-poll monitoring until it reaches a terminal state.
