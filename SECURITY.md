# Security Policy

This repository holds the « Jurisprudence canadienne et greffes du Québec » MCP connector, a
read-only Cloudflare Worker used by a practising Quebec lawyer to verify case-law
citations. It handles no client data (see *Data handled* below), but it does hold a
personal CanLII API key and a shared authentication secret — both as Cloudflare
Worker secrets, never in this repository.

## Reporting a vulnerability

If you discover a security issue, **do not open a public GitHub issue**. Email the
maintainer directly:

**Contact:** Jason Poirier Lavoie — `jason@poirierlavoie.ca`

Please include:
- A description of the vulnerability
- Steps to reproduce (or a proof-of-concept)
- The potential impact you've identified
- Any suggested mitigation, if you have one

You'll get an initial acknowledgement within 72 hours. Coordinated disclosure is
appreciated — please give a reasonable window to patch before publishing details.

## Scope

In scope:
- The deployed Worker at `jurisprudence.poirierlavoie.ca`
- Code in this repository
- The MCP endpoint (`POST /mcp/<secret>`) and its authentication
- The public page (`GET /`)

Out of scope:
- Social engineering of the maintainer or anyone else
- Physical attacks
- DoS / volumetric attacks
- CanLII's own API, website or data — report those to CanLII
- Issues in third-party dependencies that don't affect this project's specific
  configuration (report those upstream). Note that this Worker ships with **zero
  runtime dependencies**; everything in `package.json` is development-only and never
  reaches the deployed bundle.

## Data handled

This connector is deliberately narrow. What leaves the infrastructure is **citations,
court identifiers and dates** — no client names, no case facts, no documents.

Three of the thirteen tools (`greffe_parse_court_file_number`, `palais_list`,
`palais_get`) make **no outbound request at all**, and **write nothing**. They read
in-memory tables of Quebec courthouses and registry codes compiled into the Worker.

A court file number submitted to them therefore never leaves the infrastructure, and
is not written to `search_log` either. That second part is deliberate, not an
oversight: a court file number identifies a **live matter** far more directly than a
case citation does, so the tuning value of logging it does not justify keeping it.
The tools are stateless by design, and a guard test enforces it.

One reservation, stated plainly because it is better known than discovered:
`canlii_find_case` accepts **party names**. If a name searched is that of a party to a
live matter rather than a published decision, the query discloses a research interest
to CanLII. The risk is low — CanLII is a Canadian non-profit and name-based case-law
research is the site's normal use — but it is not nil.

The D1 database stores public case-law metadata plus a `search_log` table used to tune
the citation parser. That log records the citation strings submitted, which for
`canlii_find_case` may include party names.

## Authentication model

The MCP endpoint is protected by a **256-bit shared secret**, accepted either as the
last path segment (`POST /mcp/<secret>`) or as an `Authorization: Bearer` header.
Comparison is constant-time over SHA-256 digests, which also neutralises any length
difference.

What this protects is **the CanLII API key and its quota**, not confidential content —
the metadata served is public. That proportionality is deliberate and documented in
§9.4 of the specification, along with the migration path to OAuth 2.1 should the
connector ever be shared.

**Browser origins.** `claude.ai` is a browser application, so the endpoint answers CORS
preflights and reflects `Access-Control-Allow-Origin`. Only an allow-listed origin is
served — `https://claude.ai`, `https://claude.com`, plus anything added via the
`ALLOWED_ORIGINS` variable. A browser `Origin` that is present but unrecognised is
refused with `403` **before authentication is even attempted**, which is the
DNS-rebinding defence the MCP specification requires. Requests with no `Origin` header
at all (server-to-server) are unaffected.

The preflight is answered *before* the secret is checked. That is deliberate and
necessary: browsers send `OPTIONS` without credentials, so requiring the secret there
would break every browser client while protecting nothing — a preflight discloses only
what the server accepts.

Known and accepted properties of this model:
- The secret travels in the URL path, so it must never be logged. `src/index.ts`
  carries an explicit prohibition on logging `request.url`, and every outbound URL is
  passed through `redactUrl()`.
- `GET /health` is unauthenticated and returns `200`. It confirms the service exists
  and nothing else. Setting `MCP_ENABLED=false` returns `404` on every route,
  `/health` included.
- Rotating the secret is a single `wrangler secret put MCP_SHARED_SECRET` followed by
  updating the connector URL; no redeployment of code is required.
- **Two secrets are accepted, with identical rights, so that either can be revoked on
  its own.** `MCP_SHARED_SECRET` is the claude.ai connector's; `MCP_SHARED_SECRET_ATHENA`
  — optional — belongs to the Pallas Athéna chat, which calls the same endpoint with
  `Authorization: Bearer` (spec §19). The second grants nothing extra: what D7 protects
  is the CanLII API key and its quota, not a data perimeter. They are separate only so
  that rotating or revoking one bearer does not take the other down with it. If neither
  is configured, everything is refused — the check fails CLOSED — and both failures
  return the same `401`; no response and no log line ever says which one matched.
- `GET /` serves a public documentation page. It is static, accepts no input, calls
  nothing and writes nothing. It never reads `MCP_SHARED_SECRET` — it documents the
  endpoint's *shape*, `/mcp/<secret>`, and a test rejects any 32+ hex-character
  string, any `Bearer`, and any mention of `api.canlii.org` or `api_key` in the body.
  It carries **no CORS headers**, so no other origin can read it; and it is served
  **outside** the `/mcp` guard block, so the DNS-rebinding origin check never applies
  to it. That check must never be hoisted to global scope: doing so would refuse the
  page to any visitor arriving from an external link.
- The page is served **even when `MCP_ENABLED=false`**, unlike `/health`. That is a
  deliberate exception: the kill switch protects the MCP surface — the API key and its
  quota — whereas a documentation page exists to be read, carries no secret and no
  live data, and is most wanted precisely when the connector is down.
- Serving `text/html` makes this a document origin, so `/` alone carries
  `Content-Security-Policy: default-src 'none'` (with `frame-ancestors 'none'`),
  `X-Content-Type-Options: nosniff` and `Referrer-Policy`. Nothing is loaded from a
  third party: no CDN, no font, no image, no analytics.

**Rate limiting.** The endpoint is limited to **60 requests per minute per IP**, enforced
inside the Worker via the `ratelimits` binding rather than by a zone WAF rule. Two
properties are worth stating rather than leaving to be discovered:

- The counter is **local to each Cloudflare location** and eventually consistent. A client
  spread across points of presence gets 60/min *per location*. This protects against
  runaway loops and request cost — it is not a defence against a distributed attacker.
- It **fails open**: if the binding is missing or the call throws, the request proceeds.
  That is deliberate, and the asymmetry is the point — authentication fails *closed* (with
  no `MCP_SHARED_SECRET`, everything is refused), whereas rate limiting protects only
  cost. Failing closed on an unavailable counter would take the connector down to protect
  a bill.

The limit is applied after the CORS preflight (a 429 on a preflight surfaces to a browser
only as an opaque CORS failure) and *before* authentication, so a burst of badly
authenticated requests stops costing anything.

## Reproducing the test suite

The full suite runs offline against frozen fixtures — **no API key, no network, no
Cloudflare account required**:

```bash
npm ci && npx wrangler types && npx vitest run
```

A test asserting that the API key never appears in any log output, and a guard suite
asserting that the connector's professional caveats never disappear from tool output,
are both part of that run.
