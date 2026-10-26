interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * Index constituents and holdings, point-in-time.
 *
 * Two live upstreams, both proxied per call (no stored dataset — see the
 * README for the reuse-terms note):
 *
 *   - iShares (BlackRock) fund holdings files for six index-tracking ETFs —
 *     the actual portfolio an ETF reports it holds today, which is the
 *     closest public point-in-time proxy for an index's membership and
 *     weights (S&P and Russell do not publish their official constituent
 *     files for free).
 *   - Wikipedia, "Historical components of the S&P 500" — a dated table of
 *     every S&P 500 addition/removal, used for `constituent_changes`.
 *
 * hosting-claims-ok: this file names the two publishers above the fetch
 * helpers, not a route or file name, per CLAUDE.md step 9b.
 */


const UA = 'Mozilla/5.0 (compatible; pipeworx-mcp-index-constituents/1.0; +https://pipeworx.io)';

async function fetchIshares(url: string | URL): Promise<Response> {
  return fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, 'iShares (BlackRock) fund holdings');
}

async function fetchWikipedia(url: string | URL): Promise<Response> {
  return fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, 'Wikipedia');
}

// ---------------------------------------------------------------------------
// Index -> fund map. The iShares ETF is the live proxy for each index; its
// daily holdings file carries the actual weight each name has in the fund,
// which tracks the index closely but is the FUND's weight, not S&P/Russell's
// own published index weight (they don't give that away for free).
// ---------------------------------------------------------------------------

interface IndexDef {
  index: string;
  label: string;
  ticker: string;
  fundId: string;
  slug: string;
}

const INDEXES: Record<string, IndexDef> = {
  sp500: { index: 'sp500', label: 'S&P 500', ticker: 'IVV', fundId: '239726', slug: 'ishares-core-s-p-500-etf' },
  sp400: { index: 'sp400', label: 'S&P MidCap 400', ticker: 'IJH', fundId: '239763', slug: 'ishares-core-s-p-mid-cap-etf' },
  sp600: { index: 'sp600', label: 'S&P SmallCap 600', ticker: 'IJR', fundId: '239774', slug: 'ishares-core-s-p-small-cap-etf' },
  russell1000: { index: 'russell1000', label: 'Russell 1000', ticker: 'IWB', fundId: '239707', slug: 'ishares-russell-1000-etf' },
  russell2000: { index: 'russell2000', label: 'Russell 2000', ticker: 'IWM', fundId: '239710', slug: 'ishares-russell-2000-etf' },
  eafe: { index: 'eafe', label: 'MSCI EAFE (developed markets ex-US/Canada)', ticker: 'EFA', fundId: '239623', slug: 'ishares-msci-eafe-etf' },
};

const INDEXES_BY_TICKER: Record<string, IndexDef> = Object.fromEntries(
  Object.values(INDEXES).map((d) => [d.ticker, d]),
);

const SUPPORTED_INDEXES = Object.keys(INDEXES).join(', ');
const SUPPORTED_TICKERS = Object.keys(INDEXES_BY_TICKER).join(', ');

function resolveIndex(raw: unknown): IndexDef {
  const key = String(raw ?? '').trim().toLowerCase();
  const def = INDEXES[key];
  if (!def) {
    throw new Error(`Unsupported index "${raw}". Supported indexes: ${SUPPORTED_INDEXES}.`);
  }
  return def;
}

function resolveTicker(raw: unknown): IndexDef {
  const key = String(raw ?? '').trim().toUpperCase();
  const def = INDEXES_BY_TICKER[key];
  if (!def) {
    throw new Error(`Unsupported ticker "${raw}". Supported ETFs: ${SUPPORTED_TICKERS}.`);
  }
  return def;
}

// ---------------------------------------------------------------------------
// iShares holdings CSV: fetch, cache at the edge for a day, parse.
// ---------------------------------------------------------------------------

interface HoldingRow {
  ticker: string;
  name: string;
  sector: string;
  asset_class: string;
  weight_pct: number | null;
  market_value_usd: number | null;
  quantity: number | null;
  price: number | null;
  location: string;
  exchange: string;
}

interface ParsedHoldings {
  fund_name: string;
  data_as_of: string;
  rows: HoldingRow[];
}

// Fresh for most of a trading day; served stale for up to 5 days if a refetch
// fails, same shape as the FDA Orange Book cache elsewhere in this repo. The
// file itself only moves once a trading day, so this is still "cache only
// what a normal client would".
const CACHE_FRESH_SEC = 20 * 3600;
const CACHE_STALE_MAX_SEC = 5 * 86_400;
const CACHE_FETCHED_AT_HEADER = 'x-pw-fetched-at';

function holdingsCacheKey(ticker: string): string {
  return `https://index-constituents.pipeworx.invalid/holdings/${ticker}`;
}

async function cacheReadHoldings(ticker: string): Promise<{ text: string; ageSec: number } | null> {
  if (typeof caches === 'undefined') return null;
  const hit = await caches.default.match(new Request(holdingsCacheKey(ticker))).catch(() => undefined);
  if (!hit) return null;
  const at = Number(hit.headers.get(CACHE_FETCHED_AT_HEADER) ?? 0);
  if (!at) return null;
  const text = await hit.text();
  if (!text) return null;
  return { text, ageSec: Math.max(0, Math.round((Date.now() - at) / 1000)) };
}

async function cacheWriteHoldings(ticker: string, text: string): Promise<void> {
  if (typeof caches === 'undefined') return;
  await caches.default
    .put(
      new Request(holdingsCacheKey(ticker)),
      new Response(text, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'Cache-Control': `s-maxage=${CACHE_STALE_MAX_SEC}`,
          [CACHE_FETCHED_AT_HEADER]: String(Date.now()),
        },
      }),
    )
    .catch(() => undefined);
}

const HOLDINGS_INFLIGHT = new Map<string, Promise<string>>();

async function downloadHoldingsCsv(def: IndexDef): Promise<string> {
  const url = `https://www.ishares.com/us/products/${def.fundId}/${def.slug}/latest-holdings.csv`;
  const res = await fetchIshares(url);
  if (!res.ok) throw await httpError(res, 'iShares (BlackRock) fund holdings');
  const text = await res.text();
  if (!text || text.length < 200) {
    throw new Error(`iShares holdings file for ${def.ticker} came back empty or truncated.`);
  }
  return text;
}

async function loadHoldingsCsv(def: IndexDef): Promise<{ text: string; stale: boolean }> {
  const cached = await cacheReadHoldings(def.ticker);
  if (cached && cached.ageSec < CACHE_FRESH_SEC) return { text: cached.text, stale: false };

  try {
    let inflight = HOLDINGS_INFLIGHT.get(def.ticker);
    if (!inflight) {
      inflight = downloadHoldingsCsv(def).finally(() => HOLDINGS_INFLIGHT.delete(def.ticker));
      HOLDINGS_INFLIGHT.set(def.ticker, inflight);
    }
    const text = await inflight;
    await cacheWriteHoldings(def.ticker, text);
    return { text, stale: false };
  } catch (err) {
    if (cached && cached.ageSec < CACHE_STALE_MAX_SEC) return { text: cached.text, stale: true };
    throw err;
  }
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** "Oct 09, 2026" -> "2026-10-09". Returns null rather than throwing on a
 *  format change — callers decide whether a missing date is fatal. */
function parseMonthDayYear(s: string): string | null {
  const m = s.trim().match(/^([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const mm = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[2].padStart(2, '0')}`;
}

function parseNum(s: string | undefined): number | null {
  if (!s) return null;
  const t = s.trim();
  if (!t || t === '-') return null;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Parses the iShares "latest-holdings.csv" shape: a short preamble (fund
 *  name, as-of date, inception, shares out, ...), a blank line, a header row,
 *  then one row per holding. Column ORDER and NAMES vary between funds (IJH
 *  and IJR add a "Type" column and call weight "Market Weight" instead of
 *  "Weight (%)"), so this reads the header by name rather than by position. */
function parseHoldingsCsv(text: string, ticker: string): ParsedHoldings {
  const lines = text.split(/\r?\n/);
  const fund_name = (lines[0] ?? '').trim();

  let data_as_of: string | null = null;
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const raw = lines[i];
    if (!raw) continue;
    if (!data_as_of && raw.startsWith('Fund Holdings as of')) {
      const cells = parseCsvLine(raw);
      data_as_of = parseMonthDayYear(cells[1] ?? '');
    }
    const cells0 = parseCsvLine(raw);
    if (cells0[0]?.trim() === 'Ticker' && cells0[1]?.trim() === 'Name') {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new Error(`iShares holdings file for ${ticker}: could not find the "Ticker,Name,..." header row — the file format may have changed.`);
  }
  if (!data_as_of) {
    throw new Error(`iShares holdings file for ${ticker}: could not find the "Fund Holdings as of" date — the file format may have changed.`);
  }

  const header = parseCsvLine(lines[headerIdx]).map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  const iTicker = idx('Ticker');
  const iName = idx('Name');
  const iSector = idx('Sector');
  const iAssetClass = idx('Asset Class');
  const iMarketValue = idx('Market Value');
  const weightCol = idx('Weight (%)') !== -1 ? idx('Weight (%)') : idx('Market Weight');
  const iQuantity = idx('Quantity');
  const iPrice = idx('Price');
  const iLocation = idx('Location');
  const iExchange = idx('Exchange');

  const rows: HoldingRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || !raw.trim()) continue;
    const cells = parseCsvLine(raw);
    const ticker_ = (cells[iTicker] ?? '').trim();
    const name = (cells[iName] ?? '').trim();
    if (!ticker_ && !name) continue;
    rows.push({
      ticker: ticker_,
      name,
      sector: (cells[iSector] ?? '').trim(),
      asset_class: (cells[iAssetClass] ?? '').trim(),
      weight_pct: weightCol !== -1 ? parseNum(cells[weightCol]) : null,
      market_value_usd: parseNum(cells[iMarketValue]),
      quantity: parseNum(cells[iQuantity]),
      price: parseNum(cells[iPrice]),
      location: (cells[iLocation] ?? '').trim(),
      exchange: (cells[iExchange] ?? '').trim(),
    });
  }
  return { fund_name, data_as_of, rows };
}

async function getHoldings(def: IndexDef): Promise<{ parsed: ParsedHoldings; stale: boolean }> {
  const { text, stale } = await loadHoldingsCsv(def);
  return { parsed: parseHoldingsCsv(text, def.ticker), stale };
}

// ---------------------------------------------------------------------------
// Wikipedia "Historical components of the S&P 500" — dated add/remove table.
// ---------------------------------------------------------------------------

interface ChangeRow {
  effective_date: string;
  added_ticker: string | null;
  added_name: string | null;
  removed_ticker: string | null;
  removed_name: string | null;
  reason: string;
}

const WIKI_PAGE = 'Historical_components_of_the_S%26P_500';
const WIKI_CACHE_FRESH_SEC = 12 * 3600;
const WIKI_CACHE_STALE_MAX_SEC = 7 * 86_400;
const WIKI_CACHE_KEY = 'https://index-constituents.pipeworx.invalid/wikitext/sp500-changes';

async function cacheReadWikitext(): Promise<{ text: string; ageSec: number } | null> {
  if (typeof caches === 'undefined') return null;
  const hit = await caches.default.match(new Request(WIKI_CACHE_KEY)).catch(() => undefined);
  if (!hit) return null;
  const at = Number(hit.headers.get(CACHE_FETCHED_AT_HEADER) ?? 0);
  if (!at) return null;
  const text = await hit.text();
  if (!text) return null;
  return { text, ageSec: Math.max(0, Math.round((Date.now() - at) / 1000)) };
}

async function cacheWriteWikitext(text: string): Promise<void> {
  if (typeof caches === 'undefined') return;
  await caches.default
    .put(
      new Request(WIKI_CACHE_KEY),
      new Response(text, {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'Cache-Control': `s-maxage=${WIKI_CACHE_STALE_MAX_SEC}`,
          [CACHE_FETCHED_AT_HEADER]: String(Date.now()),
        },
      }),
    )
    .catch(() => undefined);
}

let WIKI_INFLIGHT: Promise<string> | null = null;

async function downloadWikitext(): Promise<string> {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${WIKI_PAGE}&prop=wikitext&format=json`;
  const res = await fetchWikipedia(url);
  if (!res.ok) throw await httpError(res, 'Wikipedia');
  const body = (await res.json()) as { parse?: { wikitext?: { '*'?: string } }; error?: { info?: string } };
  const text = body.parse?.wikitext?.['*'];
  if (!text) {
    throw new Error(`Wikipedia: ${body.error?.info ?? 'the S&P 500 changes page came back without wikitext'}.`);
  }
  return text;
}

async function loadWikitext(): Promise<string> {
  const cached = await cacheReadWikitext();
  if (cached && cached.ageSec < WIKI_CACHE_FRESH_SEC) return cached.text;
  try {
    WIKI_INFLIGHT ??= downloadWikitext().finally(() => { WIKI_INFLIGHT = null; });
    const text = await WIKI_INFLIGHT;
    await cacheWriteWikitext(text);
    return text;
  } catch (err) {
    if (cached && cached.ageSec < WIKI_CACHE_STALE_MAX_SEC) return cached.text;
    throw err;
  }
}

/** Strips wiki markup down to plain text: [[Link]] / [[Link|Display]] -> the
 *  display text, <ref ...>...</ref> and self-closing <ref .../> removed
 *  entirely, HTML comments removed, remaining double-brace templates removed. */
function stripWikiMarkup(s: string): string {
  return s
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/'''?/g, '')
    .trim();
}

function parseEffectiveDate(s: string): string | null {
  const m = s.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const mm = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[2].padStart(2, '0')}`;
}

/** Parses the MediaWiki wikitable (id="changes") into rows. One cell per
 *  line, each prefixed with "|" or "||" — both are valid MediaWiki syntax for
 *  "start a new cell here" and this page uses both across its history, so the
 *  parser treats them the same rather than assuming one. */
function parseChangesTable(wikitext: string): ChangeRow[] {
  const startMarker = wikitext.indexOf('id="changes"');
  if (startMarker === -1) {
    throw new Error('Wikipedia: could not find the S&P 500 "changes" table on the historical-components page — the page layout may have changed.');
  }
  const tableStart = wikitext.indexOf('\n', startMarker);
  const tableEnd = wikitext.indexOf('\n|}', tableStart);
  const body = wikitext.slice(tableStart, tableEnd === -1 ? undefined : tableEnd);

  const rowBlocks = body.split(/\n\|-/).slice(1); // drop the header-definition block before the first "|-"
  const rows: ChangeRow[] = [];
  for (const block of rowBlocks) {
    const cells = block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('|') && !l.startsWith('|-'))
      .map((l) => stripWikiMarkup(l.replace(/^\|{1,2}/, '').trim()));
    if (cells.length < 6) continue; // malformed/legacy row shape — skip rather than guess

    const effective_date = parseEffectiveDate(cells[0]);
    if (!effective_date) continue;

    const added_ticker = cells[1] || null;
    const added_name = cells[2] || null;
    const removed_ticker = cells[3] || null;
    const removed_name = cells[4] || null;
    const reason = cells[5] || '';

    rows.push({ effective_date, added_ticker, added_name, removed_ticker, removed_name, reason });
  }
  return rows;
}

/** Accepts a bare 4-digit year ("2024") as well as an ISO date, since that's
 *  the natural way to ask "what changed in 2024". */
function normalizeBound(raw: unknown, endOfYear: boolean): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).trim();
  if (/^\d{4}$/.test(s)) return endOfYear ? `${s}-12-31` : `${s}-01-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  throw new Error(`"${raw}" is not a year (e.g. "2024") or an ISO date (e.g. "2024-06-30").`);
}

// ---------------------------------------------------------------------------
// Shared pagination helpers — defaults kept small on purpose; the full S&P
// 500 (~503 rows) or the full changes table is available on request via a
// higher `limit`, not by default.
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 600;

function clampLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function clampOffset(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const tools: McpToolExport['tools'] = [
  {
    name: 'index_constituents',
    description:
      'Current constituents of a major US or developed-markets equity index — ticker, name, GICS sector, and weight — sourced from the matching iShares index-tracking ETF\'s daily holdings file (the closest free, point-in-time proxy for official index membership and weights; S&P/Russell do not publish those for free). Answers "what\'s in the S&P 500 right now", "top holdings of the Russell 2000 by weight", "which sectors make up the S&P MidCap 400". Cash, collateral and futures positions the ETF holds are excluded here — use ishares_etf_holdings for those.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        index: {
          type: 'string',
          description: `Which index. One of: ${SUPPORTED_INDEXES}.`,
          enum: Object.keys(INDEXES),
        },
        limit: { type: 'number', description: `Max rows to return, sorted by weight descending (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT} — pass the max to get the full index in one call).` },
        offset: { type: 'number', description: 'Rows to skip, for paging past `limit` (default 0).' },
        sector: { type: 'string', description: 'Optional GICS sector filter, case-insensitive substring match (e.g. "Health Care", "Energy").' },
      },
      required: ['index'],
    },
  },
  {
    name: 'ishares_etf_holdings',
    description:
      'Full reported holdings of one of six iShares index-tracking ETFs (IVV, IJH, IJR, IWB, IWM, EFA) as of the fund\'s own "as of" date — every position including cash, collateral and futures, each labeled with its asset class so they are never silently mixed in with equities. Answers "what does IVV actually hold today", "how much cash does this ETF carry". For just the equity index membership, use index_constituents instead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticker: {
          type: 'string',
          description: `One of the supported iShares ETFs: ${SUPPORTED_TICKERS}.`,
          enum: Object.keys(INDEXES_BY_TICKER),
        },
        limit: { type: 'number', description: `Max rows to return, sorted by market value descending (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
        offset: { type: 'number', description: 'Rows to skip, for paging past `limit` (default 0).' },
        asset_class: { type: 'string', description: 'Optional filter, case-insensitive exact match against the fund\'s own asset-class label (e.g. "Equity", "Cash", "Futures", "Cash Collateral and Margins", "Money Market").' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'constituent_changes',
    description:
      'Dated additions and removals from the S&P 500, sourced from Wikipedia\'s maintained "Historical components of the S&P 500" table (every S&P-announced swap since 1963, each with its effective date, the ticker/company added, the ticker/company removed, and the stated reason). Answers "what changed in the S&P 500 in 2024", "when was X removed from the S&P 500 and what replaced it". Only sp500 is covered — the iShares-backed indexes above have no equivalent public, dated changes table.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        index: { type: 'string', description: 'Only "sp500" is supported.', enum: ['sp500'] },
        from: { type: 'string', description: 'Earliest effective date to include, as a year ("2024") or ISO date ("2024-01-01"). Omit for no lower bound.' },
        to: { type: 'string', description: 'Latest effective date to include, as a year ("2024") or ISO date ("2024-12-31"). Omit for no upper bound.' },
        limit: { type: 'number', description: `Max rows to return, most recent first (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
      },
      required: ['index'],
    },
  },
];

async function toolIndexConstituents(args: Record<string, unknown>): Promise<unknown> {
  const def = resolveIndex(args.index);
  const limit = clampLimit(args.limit);
  const offset = clampOffset(args.offset);
  const sectorFilter = typeof args.sector === 'string' && args.sector.trim() ? args.sector.trim().toLowerCase() : null;

  const { parsed, stale } = await getHoldings(def);
  let equities = parsed.rows.filter((r) => r.asset_class.toLowerCase() === 'equity');
  if (sectorFilter) equities = equities.filter((r) => r.sector.toLowerCase().includes(sectorFilter));
  equities = equities.slice().sort((a, b) => (b.weight_pct ?? 0) - (a.weight_pct ?? 0));

  const total = equities.length;
  const page = equities.slice(offset, offset + limit);

  return {
    index: def.index,
    label: def.label,
    source: `${parsed.fund_name} (${def.ticker}) holdings, iShares (BlackRock)`,
    data_as_of: parsed.data_as_of,
    stale,
    sector_filter: sectorFilter,
    total,
    returned: page.length,
    offset,
    truncated: offset + page.length < total,
    constituents: page.map((r) => ({
      ticker: r.ticker,
      name: r.name,
      sector: r.sector,
      weight_pct: r.weight_pct,
      data_as_of: parsed.data_as_of,
    })),
  };
}

async function toolEtfHoldings(args: Record<string, unknown>): Promise<unknown> {
  const def = resolveTicker(args.ticker);
  const limit = clampLimit(args.limit);
  const offset = clampOffset(args.offset);
  const assetClassFilter = typeof args.asset_class === 'string' && args.asset_class.trim() ? args.asset_class.trim().toLowerCase() : null;

  const { parsed, stale } = await getHoldings(def);
  let rows = parsed.rows;
  if (assetClassFilter) rows = rows.filter((r) => r.asset_class.toLowerCase() === assetClassFilter);
  rows = rows.slice().sort((a, b) => (b.market_value_usd ?? 0) - (a.market_value_usd ?? 0));

  const total = rows.length;
  const page = rows.slice(offset, offset + limit);

  return {
    ticker: def.ticker,
    fund_name: parsed.fund_name,
    tracks: def.label,
    data_as_of: parsed.data_as_of,
    stale,
    asset_class_filter: assetClassFilter,
    total,
    returned: page.length,
    offset,
    truncated: offset + page.length < total,
    holdings: page,
  };
}

async function toolConstituentChanges(args: Record<string, unknown>): Promise<unknown> {
  const indexArg = String(args.index ?? '').trim().toLowerCase();
  if (indexArg !== 'sp500') {
    throw new Error(`constituent_changes only covers the S&P 500 right now — Wikipedia's dated changes table is S&P-500-specific. Supported: sp500.`);
  }
  const from = normalizeBound(args.from, false);
  const to = normalizeBound(args.to, true);
  const limit = clampLimit(args.limit);

  const wikitext = await loadWikitext();
  let changes = parseChangesTable(wikitext);
  if (from) changes = changes.filter((c) => c.effective_date >= from);
  if (to) changes = changes.filter((c) => c.effective_date <= to);
  changes = changes.slice().sort((a, b) => (a.effective_date < b.effective_date ? 1 : -1));

  const total = changes.length;
  const page = changes.slice(0, limit);

  return {
    index: 'sp500',
    source: 'Wikipedia, "Historical components of the S&P 500"',
    from,
    to,
    total,
    returned: page.length,
    truncated: page.length < total,
    changes: page,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'index_constituents':
      return toolIndexConstituents(args);
    case 'ishares_etf_holdings':
      return toolEtfHoldings(args);
    case 'constituent_changes':
      return toolConstituentChanges(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
