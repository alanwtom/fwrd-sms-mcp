import { DurableObject } from "cloudflare:workers";
import { extractCode } from "./code";

/** Texts are never kept longer than this, whatever KEEP_SECONDS says. */
const MAX_KEEP_SECONDS = 15 * 60;

/** One forwarded text, as Fwrd sent it, plus when it arrived and the code found in it. */
export interface StoredText {
  id: number;
  /** Milliseconds since 1970, set when the text reached this server. */
  receivedAt: number;
  content: string;
  sender: string | null;
  code: string | null;
}

type Row = {
  id: number;
  received_at: number;
  content: string;
  sender: string | null;
  code: string | null;
};

const COLUMNS = "id, received_at, content, sender, code";

/**
 * The inbox: one SQLite-backed Durable Object per deployment holds the texts Fwrd posts.
 * A single instance is right here, because one deployment serves one person's phone and
 * texts arrive a few at a time.
 */
export class Inbox extends DurableObject<Env> {
  /**
   * Tool calls waiting for the next text. Each entry only wakes its caller, which then reads
   * SQLite again, so nothing is lost if the object restarts: the texts are in storage.
   */
  private readonly waiters = new Set<() => void>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS texts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          received_at INTEGER NOT NULL,
          content TEXT NOT NULL,
          sender TEXT,
          code TEXT,
          idempotency_key TEXT UNIQUE,
          handed_out_at INTEGER
        )`);
      this.ctx.storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS texts_by_time ON texts (received_at)",
      );
    });
  }

  /**
   * Stores one text from Fwrd. Returns false when it's a retry of a text already stored:
   * Fwrd keeps the same Idempotency-Key when it retries, so a repeat key is a duplicate.
   */
  async addText(
    content: string,
    sender: string | null,
    idempotencyKey: string | null,
  ): Promise<boolean> {
    this.deleteExpired();
    const inserted =
      this.ctx.storage.sql
        .exec(
          `INSERT INTO texts (received_at, content, sender, code, idempotency_key)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id`,
          Date.now(),
          content,
          sender,
          extractCode(content),
          idempotencyKey,
        )
        .toArray().length > 0;
    if (inserted) {
      for (const wake of [...this.waiters]) wake();
      await this.scheduleCleanup(false);
    }
    return inserted;
  }

  /**
   * The newest code that arrived at or after `notBefore`, matches `contains` and hasn't been
   * handed out. Waits up to `waitMs` for one to arrive. Doesn't hand it out: the caller
   * does that with handOut(), once it knows its client is still there to receive it.
   */
  async nextCode(contains: string, notBefore: number, waitMs: number): Promise<StoredText | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      this.deleteExpired();
      const rows = this.ctx.storage.sql
        .exec<Row>(
          `SELECT ${COLUMNS} FROM texts
           WHERE code IS NOT NULL AND handed_out_at IS NULL AND received_at >= ?
           ORDER BY received_at DESC, id DESC`,
          notBefore,
        )
        .toArray();
      const match = rows.map(toStoredText).find((text) => mentions(text, contains));
      if (match) return match;
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await this.nextArrival(left);
    }
  }

  /** Marks a code as handed out. Returns it, or null if another call took it first. */
  handOut(id: number): StoredText | null {
    const rows = this.ctx.storage.sql
      .exec<Row>(
        `UPDATE texts SET handed_out_at = ? WHERE id = ? AND handed_out_at IS NULL
         RETURNING ${COLUMNS}`,
        Date.now(),
        id,
      )
      .toArray();
    return rows.length > 0 ? toStoredText(rows[0]) : null;
  }

  /** Texts that arrived at or after `since` and match `contains`, newest first. */
  recentTexts(since: number, contains: string, limit: number): StoredText[] {
    this.deleteExpired();
    return this.ctx.storage.sql
      .exec<Row>(
        `SELECT ${COLUMNS} FROM texts WHERE received_at >= ? ORDER BY received_at DESC, id DESC`,
        since,
      )
      .toArray()
      .map(toStoredText)
      .filter((text) => mentions(text, contains))
      .slice(0, limit);
  }

  /** Runs when the oldest text is due to expire, even if no request comes in. */
  async alarm(): Promise<void> {
    this.deleteExpired();
    await this.scheduleCleanup(true);
  }

  private keepMs(): number {
    const seconds = Number(this.env.KEEP_SECONDS);
    const valid = Number.isFinite(seconds) && seconds >= 1;
    return Math.min(valid ? seconds : MAX_KEEP_SECONDS, MAX_KEEP_SECONDS) * 1000;
  }

  private deleteExpired(): void {
    this.ctx.storage.sql.exec("DELETE FROM texts WHERE received_at <= ?", Date.now() - this.keepMs());
  }

  /** Sets the alarm for when the oldest stored text expires. */
  private async scheduleCleanup(replace: boolean): Promise<void> {
    const { oldest } = this.ctx.storage.sql
      .exec<{ oldest: number | null }>("SELECT MIN(received_at) AS oldest FROM texts")
      .one();
    if (oldest === null) return;
    // An alarm that's already set is for an older text, so it fires no later than needed.
    if (!replace && (await this.ctx.storage.getAlarm()) !== null) return;
    await this.ctx.storage.setAlarm(oldest + this.keepMs() + 1000);
  }

  /** Resolves when the next text is stored, or after `ms`, whichever comes first. */
  private nextArrival(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }
}

function toStoredText(row: Row): StoredText {
  return {
    id: row.id,
    receivedAt: row.received_at,
    content: row.content,
    sender: row.sender,
    code: row.code,
  };
}

/** True when `contains` is empty, or appears in the text or its sender (any case). */
function mentions(text: StoredText, contains: string): boolean {
  if (contains === "") return true;
  const needle = contains.toLowerCase();
  return (
    text.content.toLowerCase().includes(needle) ||
    (text.sender ?? "").toLowerCase().includes(needle)
  );
}
