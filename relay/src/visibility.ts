import { MaturityRatingSchema } from '@screenfin/protocol';
import { jellyfinAuthHeader, readBoundedJson } from './jellyfinHttp';

/**
 * The maturity rule — whether a party on media above a viewer's maturity ceiling is offered
 * at all. **The relay decides nothing Jellyfin has not already decided: it
 * asks.**
 *
 * ## Why this is not the arithmetic the maturity rule originally specified
 *
 * The maturity rule as written had the room advertise a *numeric* level and each client
 * compare it against its own `MaxParentalRating`. Measured against
 * a real Jellyfin 12.0.0, that is not buildable:
 *
 *  - `GET /Items/{id}` exposes **no numeric parental rating at all** — only
 *    `OfficialRating` as a string. Neither `ParentalRatingValue` nor
 *    `InheritedParentalRatingValue` is returned even when asked for by name.
 *  - `GET /Localization/ParentalRatings` returns 56 entries shaped
 *    `{Name, Value, RatingScore:{score, subScore}}`, and that ladder is
 *    **incomplete for the real library**: of the 12 distinct movie ratings
 *    present, `16+` and `M` are absent from it yet **blocked** by Jellyfin for
 *    an account whose ceiling is 7, while `NR`, `Not Rated` and `Unrated` are
 *    equally absent and **allowed**. "Absent from the ladder" is therefore
 *    ambiguous, and a ladder-derived gate is wrong on 2 of 12.
 *
 * So the gate is one question put to Jellyfin: `GET /Items?userId=…&ids=…`
 * returns **only the items that user may see**. Measured, asked
 * about 7 items as `test3` (ceiling 7) it returned exactly the `G`, unrated and
 * `NR` ones and withheld `R`, `16+`, `M` and `TV-MA`. One request answers a
 * whole queue, authoritatively, with zero rating arithmetic — which honours
 * The maturity rule's own "Jellyfin's, never ours" principle better than the numeric design
 * did.
 *
 * ## Miss and error policy — DO NOT INVERT THIS
 *
 * A **known withheld** fails closed: the room is hidden and the join refused.
 * A **failure to get an answer** fails **open**. The maturity rule: _"A failure to resolve
 * is not a refusal ... a network blip would otherwise hide legitimate parties
 * from the rail, turning a visible lie into an invisible one."_ So this cache
 * keys strictly on Jellyfin's answer:
 *
 *  - an id **absent from an `ids=` response** that returned 200 is `withheld`;
 *  - a 5xx, a timeout, a transport error or an unparseable body writes
 *    `unavailable` for the ids that request covered, on a **short** TTL of its
 *    own so a blip is retried soon rather than trusted for five minutes;
 *  - an id never asked about, or whose entry has aged out, is `unresolved`.
 *
 * ## Why `unknown` became two states — the unresolved-state change, measured
 *
 * Those last two used to be one value, `unknown`, and both failed open on the
 * strength of the paragraph above. **That paragraph is about errors**, and it
 * still is: `unavailable` fails open, exactly as before, and the maturity rule's sentence
 * describes it word for word.
 *
 * "Never asked" is not a blip. It is work the relay has not done yet and can
 * do, and collapsing the two made both maturity doors fail open on first contact
 * with an item — deterministically, not as a race, because **the add is what
 * changes the room's item set** and the warm that follows it therefore arrives
 * after the decision it was needed for. Measured against the deployed relay: the
 * first `playback.setItem` naming any item unresolved within the TTL was always
 * allowed with a ceiling-7 account seated, and the room then held over-ceiling
 * media with that viewer in it permanently, because nothing re-evaluates. A
 * newly created room was likewise advertised to that account for 170–320 ms
 * before the warm withdrew it, and a join at +6 ms succeeded.
 *
 * So `unresolved` fails **closed** at the three guards in `rooms/manager.ts`,
 * and the damage that direction can do is bounded in a way the other is not: a
 * room is missing from a rail for the ~170 ms a warm takes, and a door that
 * refuses says *"not yet, try again"* **and sets the answer going** rather than
 * pronouncing on anybody's account. The fail-open case keeps its own state and
 * its own name so that no later reader has to guess which of the two the maturity rule's
 * paragraph was written about.
 *
 * The tempting "fix" for a later reader is to treat a *failure* as a refusal,
 * because it looks safer. It is not, and it is not needed: **Jellyfin still
 * refuses the media itself** — `POST /Items/{id}/PlaybackInfo` is 404 for a
 * blocked account, with zero `MediaSources`. These guards protect the
 * *experience*; the server protects the child. Nobody may relax a Jellyfin-side
 * assumption because "the relay checks it".
 *
 * One consequence of keying strictly on the answer, stated so it is not
 * mistaken for a bug: an item **deleted** from the library is absent from every
 * user's response and so reads as `withheld` for everybody, which hides its
 * room. That is the honest answer — nobody can watch it — and it decays with
 * the entry's TTL if the item comes back.
 */

/**
 * What Jellyfin has said about one (user, item) pair, if anything.
 *
 * The two non-answers are deliberately distinct; see the header. `unresolved`
 * means *the relay has not asked, or its answer aged out* and fails closed;
 * `unavailable` means *the relay asked and could not be answered* and fails
 * open.
 */
export type ItemAccess = 'visible' | 'withheld' | 'unresolved' | 'unavailable';

/**
 * The display-only pair `RoomState.playback` carries (PROTOCOL.md § 8).
 *
 * It rode on `LobbyGroup` for a few hours; the operator ruled the room's level
 * is shown inside the room and not on the open-room card, so it moved to the
 * snapshot a client holds once it is seated.
 */
export interface RoomMaturity {
  /**
   * **What constrains the room**: when any seated
   * participant has a Jellyfin ceiling, the lowest such ceiling, named by the
   * server's ladder — otherwise the highest `OfficialRating` over the items, or
   * null when none is known. Excludes the not-rated names — see
   * `NOT_RATED_NAMES`.
   */
  maturityRating: string | null;
  /** Whether any item is on Jellyfin's unrated axis (`NOT_RATED_NAMES`). */
  containsUnrated: boolean;
}

/**
 * The **synchronous** half, and the only half the room guards may touch.
 *
 * `src/router.ts` is entirely synchronous, and so are
 * `RoomManager.lobbyFor` and `RoomManager.joinRoom`. Making them async to await
 * a Jellyfin round trip would refactor the relay's core message loop and its
 * arrival-order guarantees for a question that is nearly always already
 * answered. So every guard reads this cache and never performs I/O; the cache
 * is filled where async already exists (see `warm`).
 */
export interface ItemVisibility {
  access(userId: string, itemId: string): ItemAccess;
  /**
   * The display pair for a room holding `itemIds`, with `ceiling` the lowest
   * `MaxParentalRating` among its seated participants — or null when none of
   * them has one, in which case the pair is the media's alone.
   */
  summarize(itemIds: Iterable<string>, ceiling?: number | null): RoomMaturity;
  /**
   * The item's runtime in milliseconds, or null when it is not known — never asked
   * about, aged out, Jellyfin reported none or `0` (live TV), or its answer could not be had.
   *
   * Read off the **same** The maturity rule answer the rating rides in on: measured on the
   * operator's Jellyfin 12.0.0, `GET /Items?userId=…&ids=…` with no `Fields` returns
   * `RunTimeTicks` on every item (a 24-minute episode: 14 391 050 000 ticks, 1 439 105 ms), so knowing it
   * costs no request and no new kind of request. It is a fact about the item, like its rating,
   * so it is cached beside the rating rather than per account. What the room does with it is
   * `RoomManager`'s: stop its clock at the end when nothing is next.
   */
  runtimeMs(itemId: string): number | null;
}

/** The asynchronous half: filling the cache from the places that may await. */
export interface ItemVisibilityWarmer extends ItemVisibility {
  /**
   * Resolve everything in `itemIds` this user's entry set is missing, using
   * that user's own token. Resolves `true` when anything new was learned, so a
   * caller can re-push a lobby that may now look different. Never rejects: a
   * failure is a non-answer, not an error to propagate.
   */
  warm(userId: string, jellyfinToken: string, itemIds: Iterable<string>): Promise<boolean>;

  /**
   * Re-ask about ids whose answers are still live but past half their life —
   * The renewal work's half of the fix.
   *
   * `warm` deliberately asks nothing about an id it already holds an answer
   * for, which is what stops a burst of lobby pushes becoming a burst of
   * Jellyfin traffic. The consequence, measured on a running party,
   * is that **nothing re-asks about a room nobody is joining**: at the TTL the
   * entries simply expired, `summarize` skipped every one of them, and the
   * room's maturity stamp went to `null` for the rest of its life (`'G'` at
   * revision 256, `null` from revision 334 onward and in the persisted snapshot
   * sixteen minutes later). It came back only because a relay restart made every
   * client re-hello.
   *
   * So this is the same work as `warm` with a different freshness bar: renew
   * before the answer can lapse rather than after. Resolves `true` only when an
   * answer actually **moved**, because a caller re-pushes on `true` and a
   * refresh that confirms what everybody already has is not news. Never
   * rejects, for the same reason `warm` does not.
   */
  refresh(userId: string, jellyfinToken: string, itemIds: Iterable<string>): Promise<boolean>;
}

/**
 * Entry ceiling for the (user, item) cache.
 *
 * Bounded for the same reason the token cache is: a relay published to the
 * internet must not let session and room churn grow a map without limit. At
 * ~90 bytes per entry this is a couple of megabytes at worst, and it is far
 * above anything a household reaches — `MAX_LOBBY_GROUPS` (200) rooms times a
 * 500-item queue times a handful of accounts is the shape that would approach
 * it, and an evicted entry degrades to `unresolved`: a room withheld from a rail
 * until the next warm re-answers it, never a false refusal that persists. The
 * refusing doors ask for their own re-warm, so the recovery is one round trip.
 */
export const MAX_VISIBILITY_ENTRIES = 20_000;
/** Item ratings are user-independent, so far fewer entries are needed. */
export const MAX_RATING_ENTRIES = 5_000;
/** How long an answer is trusted before it is asked again. */
export const DEFAULT_VISIBILITY_TTL_MS = 300_000;
/**
 * How long a **failure** to get an answer is trusted.
 *
 * Far shorter than the success TTL on purpose: an `unavailable` entry fails
 * open, so it is the one state that should be revisited quickly. A blip should
 * be retried within seconds, not believed for five minutes — but it still has a
 * TTL rather than none, so a Jellyfin that is down does not turn every lobby
 * push into another round of doomed requests.
 */
export const DEFAULT_VISIBILITY_ERROR_TTL_MS = 15_000;
/**
 * Renew an answer once it is this far through its life (`refresh` only).
 *
 * Half, so a refresher running on any cadence below the TTL renews an answer
 * strictly before it can lapse — which is the whole of the renewal work's fix on this
 * side. `warm` passes 0 and so keeps its "never re-ask what we already know"
 * behaviour exactly.
 */
const REFRESH_AT_FRACTION_OF_TTL = 0.5;
/** The ladder changes with the server's locale setting, not by the minute. */
const LADDER_TTL_MS = 3_600_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
/**
 * Ids per `/Items` request. A room queue holds up to 500 entries
 * (`RoomPlaybackSchema`), and one query string carrying 500 GUIDs is both
 * unwieldy and at the mercy of an upstream proxy's URI limit.
 */
const IDS_PER_REQUEST = 100;
const MAX_ITEMS_BODY_BYTES = 8_388_608;
const MAX_LADDER_BODY_BYTES = 1_048_576;

interface AccessEntry {
  access: 'visible' | 'withheld' | 'unavailable';
  expiresAt: number;
}

interface RatingEntry {
  /** Jellyfin's `OfficialRating`, or null for an item that carries none. */
  officialRating: string | null;
  /**
   * The series this item belongs to, canonicalized — **where an episode's
   * rating actually lives.**
   *
   * Measured against a real Jellyfin 12.0.0: **383 of 3 406
   * episodes carry no `OfficialRating` of their own while their series carries
   * one**, across 36 of 63 series — they would inherit `TV-MA` (316), `TV-14`
   * (48) and `16` (19). A room on any of those read `Unrated`, which is both
   * wrong and wrong in the reassuring direction.
   *
   * There is no server-side answer to fall back on: `InheritedParentalRatingValue`
   * and `ParentalRatingValue` are **not returned even when asked for by name**
   * (re-measured on 12.0.0 while fixing this), which is the same finding this
   * file's header already records for the numeric gate. So the fallback is a
   * second question to Jellyfin about the series, and `summarize` joins them.
   *
   * `null` for an item that is not part of a series, and for a series itself —
   * Jellyfin puts `SeriesId` on episodes and seasons only, which is what bounds
   * the join to one hop.
   *
   * A **season** is deliberately not consulted: measured on the same server, a
   * season's own `OfficialRating` is `null` even when its series has one, so a
   * season hop would resolve nothing and cost a request.
   */
  seriesId: string | null;
  /**
   * Jellyfin's `RunTimeTicks` as milliseconds, or null when it carries none or a non-positive one
   * (see `ItemVisibility.runtimeMs`). Display-free and gate-free: nothing here refuses
   * anybody anything on the strength of it.
   */
  runtimeMs: number | null;
  expiresAt: number;
}

/** Jellyfin's ticks are 100 ns. */
const TICKS_PER_MS = 10_000;

/** `RunTimeTicks` as whole milliseconds, or null for anything that is not a positive number. */
function runtimeMsFromTicks(ticks: unknown): number | null {
  if (typeof ticks !== 'number' || !Number.isFinite(ticks) || ticks <= 0) return null;
  const ms = Math.floor(ticks / TICKS_PER_MS);
  return ms > 0 ? ms : null;
}

/** A ladder position: `R` is `(17, 0)` and `TV-MA` is `(17, 1)`. */
interface RatingScore {
  score: number;
  subScore: number;
}

export interface ItemVisibilityLogger {
  warn: (obj: object, msg?: string) => void;
}

export interface ItemVisibilityOptions {
  /** Already validated and normalized by loadConfig. */
  jellyfinUrl: string;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  ttlMs?: number;
  /** Defaults to `DEFAULT_VISIBILITY_ERROR_TTL_MS`, clamped to never exceed `ttlMs`. */
  errorTtlMs?: number;
  maxEntries?: number;
  requestTimeoutMs?: number;
  logger?: ItemVisibilityLogger;
  /**
   * The item ids some room currently holds, whose answers are evicted last (security review
   * M1). Read lazily and at most once a second, and only when the cache is full.
   */
  pinnedItemIds?: () => Iterable<string>;
}

const GUID_DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GUID_BARE = /^[0-9a-f]{32}$/i;

/**
 * Fold the two spellings of a Jellyfin GUID together, and leave every other id
 * exactly as it arrived.
 *
 * Jellyfin answers with a dashless lowercase `Id` whatever form it was asked
 * with, so a room holding the dashed form would otherwise never match its own
 * item in the response and would read as `withheld` — a silent, total refusal.
 * `ItemIdSchema` is an opaque 1–128 character string, though, so this must not
 * rewrite ids in general: an id that is not a GUID is compared verbatim.
 */
function canonicalItemId(itemId: string): string {
  return GUID_DASHED.test(itemId) || GUID_BARE.test(itemId)
    ? itemId.replace(/-/g, '').toLowerCase()
    : itemId;
}

/**
 * Whether this id can be put to Jellyfin at all.
 *
 * `ids=` is comma-separated, so an id containing a comma cannot be asked about:
 * Jellyfin would read it as two ids and the answer could never be matched back.
 * `ItemIdSchema` is an opaque 1–128 character string, so a client really can put
 * one in a room.
 *
 * Such an id is `unavailable` rather than `unresolved`, and the distinction is
 * load-bearing since the unresolved-state change: `unresolved` fails closed and is meant to be
 * cured
 * by asking, and **this one can never be asked**, so leaving it there would
 * refuse a legitimate item id forever rather than for one round trip. It is
 * answered without a cache entry because nothing about it can ever change.
 */
function isAskable(itemId: string): boolean {
  return itemId !== '' && !itemId.includes(',');
}

/**
 * `OfficialRating` names that are Jellyfin's **unrated** axis rather than a low
 * rung of its ladder. Lowercased; compared after trimming.
 *
 * Measured, by writing `BlockUnratedItems: ["Movie"]` onto a test
 * account and restoring it exactly afterwards: `GET /Items?userId=…&Ids=…`
 * withheld the items rated `NR`, `Not Rated` and `Unrated` **together with**
 * the ones carrying no rating at all, while `G`, `16+`, `M` and `TV-MA` stayed
 * visible. So those three names are this axis, and `16+`/`M` are genuinely
 * rated — merely missing from `/Localization/ParentalRatings`.
 *
 * `Unrated` is also the ladder's one scoreless entry (see `ensureLadder`), so
 * it is detectable twice over; the other two are not in the ladder at all,
 * which is why this list is explicit rather than derived.
 *
 * **This is a display heuristic and it gates nothing.** The gate is Jellyfin's
 * `Ids=` answer, which already enforces `BlockUnratedItems` server-side. The
 * whole downside of a non-English locale spelling "not rated" some other way is
 * a chip that reads slightly wrong, which is why the list stays short rather
 * than growing into a translation table.
 */
const NOT_RATED_NAMES = new Set(['nr', 'not rated', 'unrated']);

/** Whether a non-empty `OfficialRating` belongs on `containsUnrated` instead. */
function isNotRatedName(officialRating: string): boolean {
  return NOT_RATED_NAMES.has(officialRating.trim().toLowerCase());
}

function accessKey(userId: string, itemId: string): string {
  // \n cannot appear in a UserIdSchema value, so the two halves cannot collide.
  return `${userId}\n${canonicalItemId(itemId)}`;
}

/**
 * Least-recently-inserted eviction over a Map, which iterates in insertion
 * order. Expired entries go first because they are free; then entries `pinned`
 * does not protect; only then a pinned one. The same shape
 * `createJellyfinAuthenticator` uses, plus the pin.
 *
 * **Why the pin** (security review M1): the cache is shared by every account,
 * and a host can put 500 fresh ids in front of it per press. Plain oldest-first
 * then evicted the answers under *other* parties — which degrade to
 * `unresolved`, which fails closed, so those rooms dropped off every rail and
 * refused joins until re-warmed. Answers about items some room still holds are
 * now the last to go, and a flood of ids no room holds any more evicts itself.
 *
 * Evicts a tenth of the bound past the one entry needed, so a full cache is not
 * rescanned on every insert.
 */
function evictTo<K, V extends { expiresAt: number }>(
  map: Map<K, V>,
  limit: number,
  now: number,
  pinned?: (key: K) => boolean,
) {
  if (map.size < limit) return;
  for (const [key, entry] of map) {
    if (entry.expiresAt <= now) map.delete(key);
  }
  const target = limit - 1 - Math.floor(limit / 10);
  if (pinned !== undefined) {
    for (const key of map.keys()) {
      if (map.size <= target) return;
      if (!pinned(key)) map.delete(key);
    }
  }
  for (const key of map.keys()) {
    if (map.size <= target) return;
    map.delete(key);
  }
}

/** How long one reading of the pinned ids is reused while a warm fills the cache. */
const PINNED_SNAPSHOT_MS = 1_000;

export function createJellyfinItemVisibility(opts: ItemVisibilityOptions): ItemVisibilityWarmer {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const clock = opts.clock ?? ((): number => Date.now());
  const ttlMs = opts.ttlMs ?? DEFAULT_VISIBILITY_TTL_MS;
  // Clamped: a failure must never be trusted for longer than an answer would
  // have been, whatever the operator (or a test) sets the success TTL to.
  const errorTtlMs = Math.min(opts.errorTtlMs ?? DEFAULT_VISIBILITY_ERROR_TTL_MS, ttlMs);
  const maxEntries = opts.maxEntries ?? MAX_VISIBILITY_ENTRIES;
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const entries = new Map<string, AccessEntry>();
  const ratings = new Map<string, RatingEntry>();
  let pinnedSnapshot: Set<string> | null = null;
  let pinnedAt = 0;
  const pinnedIds = (): Set<string> => {
    const now = clock();
    if (pinnedSnapshot === null || now - pinnedAt >= PINNED_SNAPSHOT_MS) {
      pinnedSnapshot = new Set();
      for (const id of opts.pinnedItemIds?.() ?? []) pinnedSnapshot.add(canonicalItemId(id));
      pinnedAt = now;
    }
    return pinnedSnapshot;
  };
  const pinnedEntry =
    opts.pinnedItemIds === undefined
      ? undefined
      : (key: string): boolean => pinnedIds().has(key.slice(key.indexOf('\n') + 1));
  const pinnedRating =
    opts.pinnedItemIds === undefined ? undefined : (id: string): boolean => pinnedIds().has(id);
  /** Keyed like `entries`: a warm already asking about this pair. */
  const inFlight = new Map<string, Promise<void>>();
  /** Lowercased rating name -> ladder position. Empty until first resolved. */
  let ladder = new Map<string, RatingScore>();
  /**
   * Ladder value -> the **first** name the ladder gives it, in the server's own
   * order: how a seated ceiling is named.
   *
   * Measured on a real Jellyfin 12.0.0: 56 entries, `Value`
   * equal to `RatingScore.score` on every one, and several names per value —
   * `TV-Y7` then `TV-Y7-FV` at 7, `R` then `NC-17` and the `TV-MA` family at 17,
   * `Approved` then `G` at 0. First wins, so 7 reads `TV-Y7`. Filled in the
   * same pass as `ladder`, and empty on the same terms.
   */
  let ladderNames = new Map<number, string>();
  let ladderExpiresAt = 0;
  let ladderInFlight: Promise<void> | null = null;

  const request = async (path: string, token: string): Promise<Response> =>
    fetchImpl(`${opts.jellyfinUrl}${path}`, {
      headers: { Authorization: jellyfinAuthHeader(token) },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });

  /**
   * Fetch `/Localization/ParentalRatings` once per `LADDER_TTL_MS`.
   *
   * Only ever used to ORDER a display string. A failure here can therefore
   * never refuse anybody anything — `summarize` degrades to a deterministic
   * order over unranked names and the gate is untouched, because the gate never
   * reads the ladder at all.
   */
  const ensureLadder = async (token: string): Promise<void> => {
    if (ladderExpiresAt > clock()) return;
    if (ladderInFlight !== null) return ladderInFlight;
    ladderInFlight = (async (): Promise<void> => {
      try {
        const response = await request('/Localization/ParentalRatings', token);
        if (response.status !== 200) return;
        const body = await readBoundedJson(
          response,
          MAX_LADDER_BODY_BYTES,
          '/Localization/ParentalRatings',
        );
        if (!Array.isArray(body)) return;
        const next = new Map<string, RatingScore>();
        const nextNames = new Map<number, string>();
        for (const raw of body) {
          const row = raw as {
            Name?: unknown;
            Value?: unknown;
            RatingScore?: { score?: unknown; subScore?: unknown } | null;
          };
          if (typeof row?.Name !== 'string' || row.Name === '') continue;
          // Measured: `Unrated` really does ship with a Name and NOTHING else —
          // no Value, no RatingScore. It is the one entry that looks ranked and
          // is not, so a row without a usable score is deliberately left out of
          // the ladder rather than defaulted to zero.
          const score = row.RatingScore?.score ?? row.Value;
          if (typeof score !== 'number' || !Number.isFinite(score)) continue;
          const subScore = row.RatingScore?.subScore;
          next.set(row.Name.toLowerCase(), {
            score,
            subScore: typeof subScore === 'number' && Number.isFinite(subScore) ? subScore : 0,
          });
          // The name a ceiling is *sent* as: the first for its value that the
          // wire accepts. The ladder is operator data and `MaturityRatingSchema`
          // is a bounded string, so a name it would reject is passed over rather
          // than put on a `room.state` every client would then drop.
          if (!nextNames.has(score) && MaturityRatingSchema.safeParse(row.Name).success) {
            nextNames.set(score, row.Name);
          }
        }
        if (next.size === 0) return;
        ladder = next;
        ladderNames = nextNames;
        ladderExpiresAt = clock() + LADDER_TTL_MS;
      } catch (err) {
        opts.logger?.warn({ err }, 'jellyfin parental-rating ladder unavailable');
      } finally {
        ladderInFlight = null;
      }
    })();
    return ladderInFlight;
  };

  /**
   * Ask about one chunk as `userId`, and record the answer.
   *
   * The whole miss/error policy lives in these few lines: **a 200 is the only
   * thing that writes an entry**, ids present in it are `visible`, the rest of
   * the ids we asked about are `withheld`, and every other outcome writes
   * nothing at all.
   */
  const resolveChunk = async (userId: string, token: string, chunk: string[]): Promise<void> => {
    const query = new URLSearchParams({
      userId,
      // The ids as the rooms hold them: `canonicalItemId` is a matching rule,
      // not a rewrite, and Jellyfin accepts either GUID spelling.
      ids: chunk.join(','),
      limit: String(chunk.length),
      enableImages: 'false',
      enableUserData: 'false',
    });
    const response = await request(`/Items?${query.toString()}`, token);
    if (response.status !== 200) {
      throw new Error(`Jellyfin /Items answered ${response.status}`);
    }
    const body = (await readBoundedJson(response, MAX_ITEMS_BODY_BYTES, '/Items')) as {
      Items?: unknown;
    };
    if (!Array.isArray(body?.Items)) {
      throw new Error('Jellyfin /Items returned an unexpected body');
    }

    const now = clock();
    const expiresAt = now + ttlMs;
    const returned = new Set<string>();
    /** Series whose rating an episode in this chunk is going to need. */
    const seriesWanted = new Set<string>();
    for (const raw of body.Items) {
      const item = raw as {
        Id?: unknown;
        OfficialRating?: unknown;
        SeriesId?: unknown;
        RunTimeTicks?: unknown;
      };
      if (typeof item?.Id !== 'string') continue;
      const id = canonicalItemId(item.Id);
      returned.add(id);
      const officialRating = typeof item.OfficialRating === 'string' ? item.OfficialRating : null;
      // `SeriesId` comes back on this query with **no `Fields` at all** —
      // measured on the same request shape the line above reads
      // `OfficialRating` from — so the join costs nothing on the way out.
      const seriesId = typeof item.SeriesId === 'string' ? canonicalItemId(item.SeriesId) : null;
      evictTo(ratings, MAX_RATING_ENTRIES, now, pinnedRating);
      ratings.delete(id);
      // `RunTimeTicks` is in the same default BaseItemDto, with no `Fields` asked for (measured),
      // so the runtime the natural-end fix needs rides in on this answer at no cost.
      ratings.set(id, {
        officialRating,
        seriesId,
        runtimeMs: runtimeMsFromTicks(item.RunTimeTicks),
        expiresAt,
      });
      // Only an item that has no rating of its own needs its series, and only
      // if the series is not already answered. An episode that carries its own
      // rating — most of them do — costs no second request. See `RatingEntry.seriesId`.
      if (officialRating === null && seriesId !== null && seriesId !== id) {
        if (liveRating(seriesId, now) === undefined) seriesWanted.add(seriesId);
      }
    }
    for (const id of chunk) {
      evictTo(entries, maxEntries, now, pinnedEntry);
      const key = accessKey(userId, id);
      entries.delete(key);
      entries.set(key, {
        access: returned.has(canonicalItemId(id)) ? 'visible' : 'withheld',
        expiresAt,
      });
    }
    if (seriesWanted.size > 0) await resolveSeriesRatings(userId, token, [...seriesWanted]);
  };

  /**
   * Ask for the series behind the episodes this user has just been shown, and
   * record **only their ratings**.
   *
   * ## Why this writes no access entry
   *
   * Nobody asked whether this user may see the *series*. Writing `withheld` for
   * an id derived from an episode would put an answer to an unasked question
   * into the gate's cache, where a room whose queue happens to hold that series
   * id would then be hidden on the strength of it. The rating cache is display
   * copy (the maturity rule's "this is a caption"); the access cache is the guard. They stay
   * separate.
   *
   * ## It fails open, and it fails open quietly
   *
   * The episodes' own entries are already written by the time this runs, so a
   * failure here loses nothing that was there before: the episode keeps its null
   * rating and the room reads `Unrated`, which is exactly today's behaviour. The
   * error is caught rather than rethrown for that reason — propagating it would
   * make `warm` log the chunk as unavailable when the chunk in fact landed.
   *
   * It goes out with **that user's own token**, like every other request in this
   * file. A series the account may not see is simply absent from the answer and
   * its episodes stay unrated.
   */
  const resolveSeriesRatings = async (
    userId: string,
    token: string,
    seriesIds: string[],
  ): Promise<void> => {
    for (let i = 0; i < seriesIds.length; i += IDS_PER_REQUEST) {
      const chunk = seriesIds.slice(i, i + IDS_PER_REQUEST);
      try {
        const query = new URLSearchParams({
          userId,
          ids: chunk.join(','),
          limit: String(chunk.length),
          enableImages: 'false',
          enableUserData: 'false',
        });
        const response = await request(`/Items?${query.toString()}`, token);
        if (response.status !== 200) {
          throw new Error(`Jellyfin /Items answered ${response.status}`);
        }
        const body = (await readBoundedJson(response, MAX_ITEMS_BODY_BYTES, '/Items')) as {
          Items?: unknown;
        };
        if (!Array.isArray(body?.Items)) {
          throw new Error('Jellyfin /Items returned an unexpected body');
        }
        const now = clock();
        const expiresAt = now + ttlMs;
        for (const raw of body.Items) {
          const item = raw as { Id?: unknown; OfficialRating?: unknown };
          if (typeof item?.Id !== 'string') continue;
          const id = canonicalItemId(item.Id);
          evictTo(ratings, MAX_RATING_ENTRIES, now, pinnedRating);
          ratings.delete(id);
          ratings.set(id, {
            officialRating: typeof item.OfficialRating === 'string' ? item.OfficialRating : null,
            // A series has no series of its own, and stating it stops the join
            // recursing even if a future Jellyfin decides otherwise.
            seriesId: null,
            // A series is never on a room's timeline; its runtime is nobody's end.
            runtimeMs: null,
            expiresAt,
          });
        }
      } catch (err: unknown) {
        opts.logger?.warn(
          { err, userId, series: chunk.length },
          'jellyfin series rating unavailable',
        );
      }
    }
  };

  const liveEntry = (key: string, now: number): AccessEntry | undefined => {
    const hit = entries.get(key);
    if (hit === undefined) return undefined;
    if (hit.expiresAt <= now) {
      entries.delete(key);
      return undefined;
    }
    return hit;
  };

  const liveRating = (itemId: string, now: number): RatingEntry | undefined => {
    const id = canonicalItemId(itemId);
    const hit = ratings.get(id);
    if (hit === undefined) return undefined;
    if (hit.expiresAt <= now) {
      ratings.delete(id);
      return undefined;
    }
    return hit;
  };

  /**
   * Total order over rating names, highest last.
   *
   * `[unranked, score, subScore, name]` compared lexicographically. The first
   * component is the load-bearing one: **a name the ladder does not score sorts
   * ABOVE every name it does**, because measured `16+` and `M` are
   * exactly such names and Jellyfin blocks them for an account that may watch
   * `TV-Y7`. Treating one as "low" would be the unsafe way to be wrong about a
   * label. The trailing name keeps the answer independent of the order the
   * items happen to arrive in — including when the ladder could not be fetched
   * and every name is unranked.
   *
   * The not-rated names never reach here: `summarize` diverts them to
   * `containsUnrated` first, so "unranked" here means a **rated** name this
   * ladder does not list, which is the only case the rule above is about.
   */
  const sortKey = (name: string): [number, number, number, string] => {
    const position = ladder.get(name.toLowerCase());
    return position === undefined ? [1, 0, 0, name] : [0, position.score, position.subScore, name];
  };

  const outranks = (candidate: string, incumbent: string): boolean => {
    const a = sortKey(candidate);
    const b = sortKey(incumbent);
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] === b[i]) continue;
      return (a[i] as number | string) > (b[i] as number | string);
    }
    return false;
  };

  /**
   * Record "we asked about these and Jellyfin could not answer" for one chunk.
   *
   * This is the fail-open half of the policy at the top of this file, and it
   * still writes no refusal: `unavailable` passes every guard exactly as the old
   * single `unknown` did. What it buys is that the guards can tell **this** from
   * an id nobody has asked about yet, which since the unresolved-state change is the one that
   * waits.
   *
   * Written over any existing entry, expired or not: a stale `visible` from
   * five minutes ago is not evidence about a request that has just failed, and
   * the short `errorTtlMs` is what stops the failure being trusted for long.
   */
  const recordUnavailable = (userId: string, chunk: string[]): void => {
    const now = clock();
    const expiresAt = now + errorTtlMs;
    for (const id of chunk) {
      evictTo(entries, maxEntries, now, pinnedEntry);
      const key = accessKey(userId, id);
      entries.delete(key);
      entries.set(key, { access: 'unavailable', expiresAt });
    }
  };

  /**
   * The body of both `warm` and `refresh`; they differ only in how much life an
   * entry must have left to be accepted as it stands.
   *
   * `minRemainingMs` of 0 is `warm`: anything not yet expired is good enough,
   * so a burst of lobby pushes asks Jellyfin nothing. Half a TTL is `refresh`:
   * an answer past its half-life is re-asked and renewed **before** it can
   * lapse, which is what stops a live room's rating silently ageing out.
   */
  const resolve = async (
    userId: string,
    jellyfinToken: string,
    itemIds: Iterable<string>,
    minRemainingMs: number,
  ): Promise<boolean> => {
    const now = clock();
    const missing: string[] = [];
    const awaited: Array<Promise<void>> = [];
    const seen = new Set<string>();
    /** The ids this call is waiting on, against the answer they started from. */
    const before = new Map<string, ItemAccess>();
    for (const id of itemIds) {
      // An id that cannot be put to Jellyfin at all is answered by `access`
      // without a cache entry; sending a question whose answer could never be
      // matched back would read as a refusal. See `isAskable`.
      if (!isAskable(id) || seen.has(canonicalItemId(id))) continue;
      seen.add(canonicalItemId(id));
      const key = accessKey(userId, id);
      // Deliberately not `liveEntry`, which would DELETE an entry that is merely
      // near the end of its life — turning every refresh into a window where the
      // room is `unresolved` and therefore hidden. Read it, do not evict it.
      const held = entries.get(key);
      if (held !== undefined && held.expiresAt > now + minRemainingMs) continue;
      before.set(id, held !== undefined && held.expiresAt > now ? held.access : 'unresolved');
      // Somebody else is already asking about this exact pair. Join their
      // request rather than opening a second one: a burst of lobby pushes
      // must not become a burst of Jellyfin traffic.
      const pending = inFlight.get(key);
      if (pending !== undefined) {
        awaited.push(pending);
        continue;
      }
      missing.push(id);
    }
    if (missing.length === 0 && awaited.length === 0) return false;

    // Only warmed alongside real work, so an idle relay never polls for it.
    if (missing.length > 0) void ensureLadder(jellyfinToken);

    for (let i = 0; i < missing.length; i += IDS_PER_REQUEST) {
      const chunk = missing.slice(i, i + IDS_PER_REQUEST);
      const pending = resolveChunk(userId, jellyfinToken, chunk).catch((err: unknown) => {
        // Fail OPEN, and say which kind of open it is: every id in this chunk
        // becomes `unavailable`, which the guards pass exactly as they passed
        // the old `unknown`. See the policy note at the top of this file.
        recordUnavailable(userId, chunk);
        opts.logger?.warn(
          { err, userId, items: chunk.length },
          'jellyfin item visibility unavailable',
        );
      });
      for (const id of chunk) inFlight.set(accessKey(userId, id), pending);
      awaited.push(
        pending.finally(() => {
          for (const id of chunk) {
            if (inFlight.get(accessKey(userId, id)) === pending) {
              inFlight.delete(accessKey(userId, id));
            }
          }
        }),
      );
    }

    await Promise.all(awaited);
    // Did any answer actually MOVE? Only the ids this call was waiting on count,
    // and only a different answer counts: the caller re-pushes a lobby on
    // `true`, and a lobby that cannot have changed must not be re-pushed. A
    // recorded failure does count — `unresolved` hides a room and `unavailable`
    // lists it, so learning that Jellyfin cannot answer is a real change to what
    // a rail shows.
    const after = clock();
    for (const [id, was] of before) {
      const held = liveEntry(accessKey(userId, id), after)?.access ?? 'unresolved';
      if (held !== was) return true;
    }
    return false;
  };

  return {
    access(userId: string, itemId: string): ItemAccess {
      const held = liveEntry(accessKey(userId, itemId), clock())?.access;
      if (held !== undefined) return held;
      return isAskable(itemId) ? 'unresolved' : 'unavailable';
    },

    summarize(itemIds: Iterable<string>, ceiling: number | null = null): RoomMaturity {
      const now = clock();
      let maturityRating: string | null = null;
      let containsUnrated = false;
      for (const itemId of itemIds) {
        const rating = liveRating(itemId, now);
        // An item the relay has never resolved contributes nothing. It is not
        // evidence of an unrated item, and guessing one would put a wrong label
        // on a room the viewer is being offered.
        if (rating === undefined) continue;
        // **An episode's rating may live on its series, and usually the whole
        // season's does.** Measured on a real library: 383 episodes of
        // 3 406 carry none of their own while their series carries one, so a
        // party on any of 36 series stamped `Unrated`. The join is one lookup in
        // a cache `resolveChunk` has already filled — no arithmetic, no ladder,
        // and no guess: it is the same `OfficialRating` string, read off the
        // item Jellyfin actually put it on. See `RatingEntry.seriesId`.
        //
        // Only a **missing** rating falls back. An episode that carries `NR`
        // explicitly is making a statement, and inheriting over the top of it
        // would be overruling the item in favour of its parent.
        const officialRating =
          rating.officialRating ??
          (rating.seriesId === null
            ? null
            : (liveRating(rating.seriesId, now)?.officialRating ?? null));
        // No rating at all, or one of the names Jellyfin itself treats as
        // unrated. Excluding those from the maximum is what stops a room
        // holding `NR` and `TV-MA` from reporting `NR`: `NR` is absent from the
        // ladder, unranked sorts above everything, and the label came out
        // LOWER than the truth — the wrong direction even for display.
        if (officialRating === null || isNotRatedName(officialRating)) {
          containsUnrated = true;
          continue;
        }
        if (maturityRating === null || outranks(officialRating, maturityRating)) {
          maturityRating = officialRating;
        }
      }
      // **A seated ceiling is the level**. Found
      // on an iPhone: a lobby on unrated media read "unrated" while `test3`,
      // capped at 7, sat in it — and the number that actually constrains what
      // the room may add is that 7, not what the room happens to hold. So when
      // any seat has a ceiling the pair says so, over the media whether the
      // media is lower or higher, and it says it in the server's own words:
      // the ladder's first name for that value (7 → `TV-Y7` here), or the bare
      // number until the ladder has landed or for a value it does not carry.
      // `containsUnrated` is the media's axis and is untouched.
      //
      // Still no arithmetic and still not the gate: the ceiling is compared
      // with nothing, and the doors go on asking Jellyfin (`access`).
      if (ceiling !== null) {
        maturityRating = ladderNames.get(ceiling) ?? String(ceiling);
      }
      return { maturityRating, containsUnrated };
    },

    runtimeMs(itemId: string): number | null {
      return liveRating(itemId, clock())?.runtimeMs ?? null;
    },

    warm(userId: string, jellyfinToken: string, itemIds: Iterable<string>): Promise<boolean> {
      return resolve(userId, jellyfinToken, itemIds, 0);
    },

    refresh(userId: string, jellyfinToken: string, itemIds: Iterable<string>): Promise<boolean> {
      return resolve(userId, jellyfinToken, itemIds, ttlMs * REFRESH_AT_FRACTION_OF_TTL);
    },
  };
}
