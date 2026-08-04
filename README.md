# Alpha Realtime Bot

Render collector/API for Wave Alpha. The service reads Binance Alpha/market data, keeps a bounded RAM cache, and publishes compact snapshots to Cloudflare R2.

## Free-tier bandwidth controls

The defaults are deliberately conservative for Render's 5 GB monthly included bandwidth:

| Variable | Default | Purpose |
|---|---:|---|
| `REALTIME_POLL_MS` | `60000` | Aggregate-volume refresh cadence. |
| `LIMIT_REFRESH_MS` | `300000` | Limit/CEX aggregate refresh cadence. Reuses the last good snapshot between refreshes. |
| `CONFIG_SYNC_MS` | `900000` | Supabase tournament-config refresh cadence. |
| `COMPETITION_LIVE_WRITE_MS` | `300000` | Minimum R2 write interval for `competition-live.json`; unchanged payloads are skipped. |
| `PRICE_SYNC_MS` | `900000` | Missing competition boundary-price scan cadence. |
| `ENABLE_TICK_CACHE` | `false` | Opt-in five-symbol aggTrade collector. Keep disabled unless a live consumer requires raw ticks. |

`GET /api/bandwidth-stats` is protected by the normal `x-api-key` middleware and reports HTTP output, upstream responses, WebSocket ingress, R2 traffic, Supabase estimates, and a 750-hour projection.

## Competition price series

Boundary prices are stored in R2 as `competition-price-series.json`. A seven-period competition has eight price points: the exact start boundary plus seven period-end boundaries. The collector requests narrow Binance Alpha kline windows, rejects responses whose timestamps are too far from the requested boundary, and never fabricates missing prices.

- `GET /api/competition-price-series?ids=<db_id,...>` returns a compact batch.
- `POST /api/admin/backfill-competition-prices` accepts `{ "includeHistory": true, "maxFetches": 25, "dryRun": false }`.
- Backfill is bounded and idempotent by tournament/slot.

## Tests

```bash
npm test
```
