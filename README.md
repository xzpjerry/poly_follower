# Polymarket Weather Follower

Event-scoped Polymarket weather copy-trading service. It discovers one Gamma Event, reads leader/follower positions, builds a fee-aware target allocation under a hard event cap, and reconciles that target without replaying historical buys.

## Safety status

- `dry-run` remains the default.
- `authenticated-readonly` verifies the signer/proxy relationship, derives or loads CLOB L2 credentials in memory, and reconciles authenticated open orders and trades without posting orders.
- `live` is guarded by an exact event-slug environment confirmation, authenticated ledger agreement, balance/allowance preflight, one FOK order per cycle, and fail-closed ambiguous-attempt recovery.
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
