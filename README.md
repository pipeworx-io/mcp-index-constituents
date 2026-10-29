# @pipeworx/index-constituents

Current constituents, weights and sectors of six major US and developed-markets
equity indexes, plus a dated history of S&P 500 additions and removals —
point-in-time index membership built from a live ETF proxy, not a licensed
index feed.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `index_constituents(index, limit?, offset?, sector?)` — current equity
  constituents of one index (`sp500`, `sp400`, `sp600`, `russell1000`,
  `russell2000`, `eafe`): ticker, name, GICS sector, weight, and the fund's
  "as of" date. Sorted by weight descending. Cash/collateral/futures the
  tracking ETF also holds are excluded here (see `ishares_etf_holdings`). Default
  `limit` is 50; pass `limit: 600` (the max) to get the whole index in one
  call — a ~503-row S&P 500 answer is available on request, not by default.
- `ishares_etf_holdings(ticker, limit?, offset?, asset_class?)` — every reported
  position of one of the six tracking ETFs (`IVV`, `IJH`, `IJR`, `IWB`, `IWM`,
  `EFA`), including cash, collateral and futures, each labeled with its own
  `asset_class` so they are never silently folded in with equities.
- `constituent_changes(index, from?, to?, limit?)` — dated S&P 500 adds and
  removes (`index` must be `sp500`; the other five indexes have no public,
  dated changes table). `from`/`to` accept a bare year ("2024") or an ISO
  date.

## Auth

Keyless. Both upstreams are public, unauthenticated pages.

## Data sources

- iShares (BlackRock) — the daily holdings file each fund publishes for its
  own index-tracking ETF (IVV/S&P 500, IJH/S&P MidCap 400, IJR/S&P SmallCap
  600, IWB/Russell 1000, IWM/Russell 2000, EFA/MSCI EAFE). This is a PROXY for
  official index membership, not the index provider's own data: S&P and
  Russell do not publish their constituent files for free, so the fund's
  actual reported portfolio — which tracks its index closely — is the
  nearest public point-in-time stand-in. Weights are the ETF's own portfolio
  weights, not S&P/Russell's published index weights, and can differ slightly
  (cash drag, sampling, corporate-action timing).
- Wikipedia — "List of S&P 500 companies" and "Historical components of the
  S&P 500" (the latter is this pack's source for `constituent_changes`: a
  community-maintained, citation-backed table of every S&P-announced S&P 500
  swap since 1963, with its effective date and stated reason).

**Reuse note (checked 2026-10-12).** BlackRock's site terms
(blackrock.com/corporate/compliance/terms-and-conditions) say website content
is "solely for your personal, non-commercial use" and may not be "distribute[d],
modif[ied], transmit[ted], reuse[d], repost[ed]... for public or commercial
purposes... without BlackRock's written permission." This pack does not store,
mirror or redistribute the holdings file: every call fetches the fund's current
file live (cached at the edge for a day, the same way a normal browser would
cache it) and returns the parsed rows for that one call. Per the proxy-vs-mirror
rule (CLAUDE.md, fleet #1389 — "a live upstream call per request needs no
explicit grant; only bulk-copying/mirroring does"), that is proxying, not
redistribution; no dataset is baked into this pack or into Pipeworx's own
storage. Wikipedia's content is CC BY-SA 4.0, which permits reuse including
attribution-carrying commercial reuse — `source` on every response names
Wikipedia and the page.

## Notes

- The iShares holdings file's column layout is not identical across funds:
  IJH and IJR add a "Type" column and call the weight field "Market Weight"
  instead of "Weight (%)". This pack reads the header by NAME, not by
  position, so a reordered column does not silently misalign the data.
- `data_as_of` on every response is the fund's own "Fund Holdings as of" date
  from the file, not the time Pipeworx fetched it — use it to judge freshness.
- The S&P 500 holdings file carries a handful of non-equity rows (cash,
  collateral, a futures contract used to stay fully invested between
  rebalances) even though the fund is "all-equity" by mandate; these are
  excluded from `index_constituents` and labeled plainly in `ishares_etf_holdings`.
- `constituent_changes` only covers `sp500` today. The other five indexes
  have no equivalent free, dated, citation-backed changes table — adding one
  would mean a different, likely paid, source.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "index-constituents": {
      "url": "https://gateway.pipeworx.io/index-constituents/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/index-constituents/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/index_constituents \
  -H 'Content-Type: application/json' \
  -d '{"index":"sp500","limit":600}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/index_constituents`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-index-constituents` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/index-constituents/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "index-constituents": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-index-constituents"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Index Constituents data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
