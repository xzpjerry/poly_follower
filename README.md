# Polymarket Weather Follower

Event-scoped Polymarket weather copy-trading service. The current implementation is intentionally dry-run only: it discovers one Gamma Event, reads public leader/follower positions, builds a fee-aware target allocation under a hard event cap, and persists reconciliation decisions without signing or posting orders.

## Safety status

- No live executor is implemented.
- Runtime wallets and event slugs belong in ignored `config/runtime.yaml` or environment variables.
- Never commit private keys or CLOB credentials.

## Ubuntu / Docker quick start

```bash
cp config/example.yaml config/runtime.yaml
# Edit config/runtime.yaml with private runtime parameters.
mkdir -p data
docker compose build
docker compose run --rm follower
```

The Docker build runs TypeScript type checking, unit tests, and production compilation. Persistent dry-run state is stored under the ignored `data/` directory.
