import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type WebSocket from 'ws';
import type { JellyfinUser } from './identity';
import { sessionIsLive } from './liveness';

const IDEMPOTENCY_CAPACITY = 128;

/**
 * One remembered reply, for answering a replayed message id without re-applying it.
 *
 * An ack that carried a room is kept **without** it, beside the room's id (security review L9):
 * `room.create` and `room.join` acks embed the whole room, up to ~70 KB with a full queue, and 128
 * of them per session was ~9 MB a session. The replay re-reads the room instead, which is also the
 * more useful answer — the room as it is, not as it was when the lost ack was sent.
 */
export interface CachedReply {
  serialized: string;
  /** Set when the original reply carried this room's snapshot. */
  roomId?: string;
}
const COMMAND_RATE_PER_SECOND = 20;
const COMMAND_BURST = 40;
// sync.ping + client.position share a separate, 2x-generous bucket.
const REPORT_RATE_PER_SECOND = 40;
const REPORT_BURST = 80;
// Consecutive schema-invalid frames before the connection is closed (§ 6.4).
const INVALID_FRAME_LIMIT = 20;

/** Continuously refilling token bucket driven by the injected clock. */
export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly clock: () => number,
  ) {
    this.tokens = burst;
    this.lastRefillAt = clock();
  }

  tryTake(): boolean {
    const now = this.clock();
    const elapsedMs = Math.max(0, now - this.lastRefillAt);
    this.tokens = Math.min(this.burst, this.tokens + (elapsedMs / 1000) * this.ratePerSecond);
    this.lastRefillAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * One authenticated relay session. Its `sessionId` doubles as the
 * participantId in any room. Survives socket loss for `reconnectGraceMs`.
 */
export class Session {
  socket: WebSocket | null = null;
  userName: string;
  /**
   * What the client called itself in `session.hello.payload.client.deviceName`, or null when it
   * sent none (the field is optional on the wire). Refreshed on resume, because the same session
   * can come back from a renamed device. Read only to name this device to its own owner when
   * their account is already in a room somewhere else.
   */
  deviceName: string | null = null;
  /**
   * The account's Jellyfin maturity ceiling (`Policy.MaxParentalRating`), or null when it has none
   * — read off the same `/Users/Me` body that proves the identity, and kept on the same terms as
   * the token below: live memory only, never persisted, never logged.
   * Refreshed with the name on resume and on revalidation. A room reads it when this session
   * takes a seat, so the party's displayed level can say what constrains the room.
   */
  maturityCeiling: number | null;
  lastSeenAt: number;
  lastValidatedAt: number;
  disconnectedAt: number | null = null;
  /**
   * Since when this session's socket has held more than the soft outbound limit unread, or null
   * while it keeps up (security review H2). Read by the liveness sweep: a client that stops reading
   * is closed on the same clock as one that stops sending.
   */
  backloggedSince: number | null = null;
  /** Registry-expiry timer armed while the session is detached from a socket. */
  cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  readonly commandBucket: TokenBucket;
  readonly reportBucket: TokenBucket;
  /** Consecutive schema-invalid frames from this session. */
  private invalidFrames = 0;
  #jellyfinToken: string;
  /** Idempotency LRU: processed message id -> the reply, as `CachedReply` describes. */
  private readonly replies = new Map<string, CachedReply>();

  constructor(
    readonly sessionId: string,
    /** Sync-server-issued secret for session resumption; never logged. */
    readonly resumeToken: string,
    /** Proven by the configured Jellyfin server. */
    readonly userId: string,
    userName: string,
    maturityCeiling: number | null,
    jellyfinToken: string,
    clock: () => number,
  ) {
    this.userName = userName;
    this.maturityCeiling = maturityCeiling;
    this.#jellyfinToken = jellyfinToken;
    this.lastSeenAt = clock();
    this.lastValidatedAt = this.lastSeenAt;
    this.commandBucket = new TokenBucket(COMMAND_RATE_PER_SECOND, COMMAND_BURST, clock);
    this.reportBucket = new TokenBucket(REPORT_RATE_PER_SECOND, REPORT_BURST, clock);
  }

  /** Constant-time comparison of sha256 digests, per PROTOCOL.md § 16. */
  verifyResumeToken(candidate: string): boolean {
    const expected = createHash('sha256').update(this.resumeToken).digest();
    const presented = createHash('sha256').update(candidate).digest();
    return timingSafeEqual(expected, presented);
  }

  /** Count a schema-invalid frame; true when repeated violations should close the socket. */
  registerInvalidFrame(): boolean {
    this.invalidFrames += 1;
    return this.invalidFrames >= INVALID_FRAME_LIMIT;
  }

  resetInvalidFrames(): void {
    this.invalidFrames = 0;
  }

  currentJellyfinToken(): string {
    return this.#jellyfinToken;
  }

  updateJellyfinToken(token: string): void {
    this.#jellyfinToken = token;
  }

  cachedReply(messageId: string): CachedReply | undefined {
    const reply = this.replies.get(messageId);
    if (reply !== undefined) {
      // Refresh recency so retried ids outlive unrelated newer entries.
      this.replies.delete(messageId);
      this.replies.set(messageId, reply);
    }
    return reply;
  }

  cacheReply(messageId: string, reply: CachedReply): void {
    this.replies.delete(messageId);
    this.replies.set(messageId, reply);
    if (this.replies.size > IDEMPOTENCY_CAPACITY) {
      const oldest = this.replies.keys().next().value;
      if (oldest !== undefined) this.replies.delete(oldest);
    }
  }
}

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly clock: () => number) {}

  create(user: JellyfinUser, jellyfinToken: string): Session {
    const session = new Session(
      randomUUID(),
      randomBytes(32).toString('base64url'),
      user.userId,
      user.userName,
      user.maturityCeiling,
      jellyfinToken,
      this.clock,
    );
    this.sessions.set(session.sessionId, session);
    return session;
  }

  /** Count sessions for one identity proven by this relay's Jellyfin, socket or no socket. */
  countForUser(userId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.userId === userId) count += 1;
    }
    return count;
  }

  /**
   * This user's oldest session with no socket on it, or undefined when every one of them is live.
   *
   * `countForUser` counts bodies, and a body in its reconnect grace is not a connection. Without
   * this the per-user cap is really "N new connections per user per minute", and the eleventh is
   * refused for a slot that ten corpses are holding — see `./liveness.ts`. Oldest first, because
   * the longest-dropped session is the least likely to resume.
   */
  oldestDetachedForUser(userId: string): Session | undefined {
    let oldest: Session | undefined;
    for (const session of this.sessions.values()) {
      if (session.userId !== userId || sessionIsLive(session)) continue;
      if (oldest === undefined || (session.disconnectedAt ?? 0) < (oldest.disconnectedAt ?? 0)) {
        oldest = session;
      }
    }
    return oldest;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  size(): number {
    return this.sessions.size;
  }

  all(): Iterable<Session> {
    return this.sessions.values();
  }
}
