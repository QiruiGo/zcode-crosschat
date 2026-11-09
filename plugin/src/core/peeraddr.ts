/**
 * W3 addressing: name-is-address, name sanitation, `[ref]` disambiguation,
 * formerNames (alias) fallback and ambiguity classification.
 *
 * Source of truth: DESIGN-V0.3.md §5 (W3) + §9.2 (acceptance matrix),
 * SPEC-V0.3.md R-7/R-8/R-9/R-10/R-11/R-12, and the CC reverse report
 * `reports/11-cc逆向.md` §3.b ("Names are the address", `@8463641`;
 * `[ref]` disambiguation `@8463662`; "Do not guess between them" `@15688377`;
 * teammate-name regex + reserved names `@2355944`; control-char stripping
 * `lX` `@3269979`; route-id percent-encoding `We()` `@2355944`).
 *
 * Module boundary (DESIGN-V0.3.md §10.2): this module owns *addressing only*.
 * It never touches the filesystem and never talks to a pipe — the registry
 * (W1) supplies records, the transport (W2) moves frames, the message core
 * (W5) renders envelopes. To stay importable before/independently of W1, the
 * record shape consumed here is a *structural view* (`PeerRecordLike`) that
 * W1's `PeerRecord` satisfies field-for-field; W1 remains the owner of the
 * canonical record type and of persistence.
 *
 * @module core/peeraddr
 */

/** Addressable peer name grammar (SPEC R-8; CC teammate-name regex `RXi`
 *  `@2355944`, generalised to the cross-session address space). */
export const PEER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Names that may never be used as a cross-session address (SPEC R-11;
 *  CC `@2355944` + `@34233387`). */
export const PEER_RESERVED_NAMES = ['main', 'team-lead', 'user', 'system'] as const;

/** Control characters stripped before validation (CC `lX` `@3269979`:
 *  strip `[\x00-\x1f\x7f-\x9f]`). */
export const PEER_CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f]/g;

/** Maximum addressable name length (SPEC R-8: `{0,63}` after the first char). */
export const PEER_NAME_MAX_LENGTH = 64;

/** formerNames FIFO cap (SPEC R-10; CC token-list magnitude `Mjn=32`). */
export const PEER_FORMER_NAMES_LIMIT = 32;

/** Characters that survive route-id encoding untouched (SPEC R-8; CC `We()`
 *  `@2355944`: everything outside `[A-Za-z0-9:_/.\-]` is percent-encoded). */
export const PEER_ROUTE_SAFE_RE = /^[A-Za-z0-9:_/.\-]$/;

/** Row kinds (DESIGN-V0.3.md §5.2): this session, team member, other session. */
export type PeerRowKind = 'self' | 'member' | 'session';

/** Session status vocabulary carried on a row (DESIGN-V0.3.md §5.2). */
export type PeerStatus = 'busy' | 'shell' | 'idle' | 'waiting';

/**
 * One addressable row. A *row* is one (identity, addressable-name) pair:
 * the current name of a session, or one of its former names (alias).
 * Two rows may carry the same `name` (one current holder + one alias
 * holder) — that is exactly the disambiguation case of DESIGN-V0.3.md §5.3.
 */
export interface PeerRow {
  /** The addressable name of this row (current name, or the alias). */
  name: string;
  /** Which catalogue the row belongs to. */
  kind: PeerRowKind;
  /** True when `name` is a former name (alias) rather than the current one.
   *  Optional so that rows built elsewhere (e.g. the peer tool face) stay
   *  assignable to this shape. */
  former?: boolean;
  /** Session identity owning the row (one session => one identity). */
  sessionId?: string;
  /** Short disambiguator: last 8 characters of `sessionId` (SPEC R-9). */
  ref: string;
  /** Identity string `<name>@<pidDomain 前 8 hex>` (SPEC R-12; CC
   *  `RV(e,n)=name@domain` `@2355944`). Never rendered into the compact
   *  row text (DESIGN-V0.3.md §5.2) — structured payloads carry it. */
  identity: string;
  /** Current name of the owning session (for alias rows: the name the
   *  session uses now; equal to `name` for current rows). */
  currentName?: string;
  /** Working directory of the owning session. */
  cwd?: string;
  /** Session status. */
  status?: string;
  /** Last activity timestamp (epoch ms). */
  lastSeenMs?: number;
  /** For alias rows: when the name was released (epoch ms). */
  releasedAt?: number;
  /** Human-facing display name (may contain CJK; never addressable). */
  displayName?: string;
}

/**
 * Structural view of a registry record (W1's `PeerRecord` satisfies it).
 * Declared locally so W3 stays importable while W1 is still in flight.
 */
export interface PeerRecordLike {
  sessionId: string;
  pidDomain?: string;
  name?: string;
  displayName?: string;
  cwd?: string;
  status?: PeerStatus;
  lastSeen?: number;
  formerNames?: { name: string; releasedAt: number }[];
}

/** Outcome of resolving a `to` string (SPEC R-9). */
export type PeerTargetResolution =
  | { kind: 'found'; row: PeerRow }
  | { kind: 'ambiguous'; candidates: PeerRow[] }
  | { kind: 'not-found'; message: string };

// --- name sanitation -------------------------------------------------------

/**
 * Sanitise a user-supplied peer name (SPEC R-8): strip control characters
 * first (CC `lX` `@3269979`), then trim, then check the addressable grammar
 * and the reserved list (SPEC R-11).
 *
 * The name is *not* lower-cased and *not* folded: the cross-session address
 * space is case-sensitive, and the grammar already excludes everything that
 * could be confused with a path separator.
 */
export function sanitizePeerName(raw: string): { ok: true; name: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid-name: 名字必须是字符串' };
  const stripped = raw.replace(PEER_CONTROL_CHARS_RE, '');
  const trimmed = stripped.trim();
  if (trimmed === '') return { ok: false, reason: 'empty-name: 名字为空（控制符剥离后无内容）' };
  if ([...trimmed].length > PEER_NAME_MAX_LENGTH) {
    return { ok: false, reason: `name-too-long: 名字超过 ${PEER_NAME_MAX_LENGTH} 个字符` };
  }
  if (!PEER_NAME_RE.test(trimmed)) {
    return { ok: false, reason: 'invalid-name: 名字必须匹配 ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' };
  }
  if ((PEER_RESERVED_NAMES as readonly string[]).includes(trimmed.toLowerCase())) {
    return { ok: false, reason: `reserved-name: ${trimmed} 是保留名（${PEER_RESERVED_NAMES.join('/')}）` };
  }
  return { ok: true, name: trimmed };
}

/**
 * Percent-encode a name into a route id (SPEC R-8; CC `We()` `@2355944`):
 * characters outside `[A-Za-z0-9:_/.\-]` become `%XX` with **uppercase**
 * hex digits, encoding the UTF-8 bytes of the character.
 */
export function encodeRouteId(raw: string): string {
  let out = '';
  for (const ch of raw) {
    if (PEER_ROUTE_SAFE_RE.test(ch)) {
      out += ch;
      continue;
    }
    for (const byte of Buffer.from(ch, 'utf8')) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

// --- row construction ------------------------------------------------------

/** Short disambiguator for a session: the last 8 characters of its session
 *  id (SPEC R-9; CC precedent `remote-${id.slice(-8)}` `@1456422`). */
export function peerRef(sessionId: string): string {
  const s = typeof sessionId === 'string' ? sessionId : '';
  return s.length <= 8 ? s : s.slice(-8);
}

/** Identity string `<name>@<pidDomain 前 8 hex>` (SPEC R-12). */
export function peerIdentity(name: string, pidDomain: string | undefined): string {
  const domain = (pidDomain ?? '').slice(0, 8);
  return `${name}@${domain}`;
}

/**
 * Expand one registry record into its addressable rows: the current-name
 * row plus one row per live former name (alias).
 *
 * Aliases do not occupy a name (DESIGN-V0.3.md §5.5): they stay addressable
 * until the session exits, the record is swept, or the 32-entry FIFO drops
 * them — so the alias *is* how "same name, two identities" stays reachable.
 */
export function peerRowsFromRecord(rec: PeerRecordLike, kind: PeerRowKind): PeerRow[] {
  const ref = peerRef(rec.sessionId);
  const rows: PeerRow[] = [];
  const current = rec.name;
  if (typeof current === 'string' && current !== '') {
    rows.push({
      name: current,
      kind,
      former: false,
      sessionId: rec.sessionId,
      ref,
      identity: peerIdentity(current, rec.pidDomain),
      currentName: current,
      cwd: rec.cwd,
      status: rec.status,
      lastSeenMs: rec.lastSeen,
      displayName: rec.displayName,
    });
  }
  const former = Array.isArray(rec.formerNames) ? rec.formerNames : [];
  for (const alias of former.slice(-PEER_FORMER_NAMES_LIMIT)) {
    if (!alias || typeof alias.name !== 'string' || alias.name === '') continue;
    if (alias.name === current) continue; // same as the current name: not a second line
    rows.push({
      name: alias.name,
      kind,
      former: true,
      sessionId: rec.sessionId,
      ref,
      identity: peerIdentity(current ?? alias.name, rec.pidDomain),
      currentName: current ?? alias.name,
      cwd: rec.cwd,
      status: rec.status,
      lastSeenMs: rec.lastSeen,
      releasedAt: alias.releasedAt,
      displayName: rec.displayName,
    });
  }
  return rows;
}

/**
 * Names shared by **two or more distinct identities** (DESIGN-V0.3.md §5.3:
 * "同一名字被 ≥2 个身份共享时，所有共享该名字的行都带 `[ref]`").
 * Rows of the same session never make a name ambiguous.
 */
export function ambiguousNames(rows: PeerRow[]): Set<string> {
  const byName = new Map<string, Set<string>>();
  for (const row of rows) {
    const owners = byName.get(row.name) ?? new Set<string>();
    owners.add(identityKey(row));
    byName.set(row.name, owners);
  }
  const out = new Set<string>();
  for (const [name, owners] of byName) {
    if (owners.size >= 2) out.add(name);
  }
  return out;
}

/** Rows addressable from the cross-session domain (SPEC R-7 / §5.1: team
 *  members live in the team namespace and are *not* peer addresses). */
export function addressableRows(rows: PeerRow[]): PeerRow[] {
  return rows.filter((r) => r.kind === 'self' || r.kind === 'session');
}

// --- rendering -------------------------------------------------------------

/** Human-readable age of a `lastSeen` timestamp (row text field `seen=`). */
export function relativeAge(lastSeenMs: number | undefined, now: number = Date.now()): string {
  if (typeof lastSeenMs !== 'number' || !Number.isFinite(lastSeenMs)) return '未知';
  const delta = Math.max(0, now - lastSeenMs);
  if (delta < 5_000) return '刚刚';
  if (delta < 60_000) return `${Math.floor(delta / 1000)} 秒前`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

/** Label of the kind column; alias rows get the `·former` marker
 *  (DESIGN-V0.3.md §5.3: 别名行 `<旧名> [<kind>·former]`). */
export function peerRowKindLabel(row: PeerRow): string {
  return row.former ? `${row.kind}·former` : row.kind;
}

/**
 * Render one compact row (DESIGN-V0.3.md §5.2).
 *
 * Layout: `<name> [<kind>] [<ref>] cwd=<cwd> status=<status> seen=<age>`.
 * The `[ref]` suffix is appended **only when the bare name is not enough**
 * (CC `@8463662`): the caller passes `ambiguous` computed over the whole
 * row set. The structured payload always carries `ref` separately.
 */
export function formatPeerRowText(row: PeerRow, ambiguous: boolean, now: number = Date.now()): string {
  const head = `${row.name} [${peerRowKindLabel(row)}]`;
  const ref = ambiguous ? ` [${row.ref}]` : '';
  const cwd = row.cwd ? ` cwd=${row.cwd}` : '';
  const status = row.status ? ` status=${row.status}` : '';
  const seen = ` seen=${relativeAge(row.lastSeenMs, now)}`;
  const former = row.former ? ` (现名 ${row.currentName})` : '';
  return `${head}${ref}${cwd}${status}${seen}${former}`;
}

/**
 * Render the compact row of a registry record (DESIGN-V0.3.md §10.2
 * signature `formatPeerRow(rec, kind, ambiguous)`).
 */
export function formatPeerRow(rec: PeerRecordLike, kind: PeerRowKind, ambiguous: boolean, now: number = Date.now()): string {
  const rows = peerRowsFromRecord(rec, kind);
  const current = rows.find((r) => !r.former) ?? rows[0];
  if (!current) return `${rec.name ?? '(未命名)'} [${kind}]`;
  return formatPeerRowText(current, ambiguous, now);
}

/** Render a whole row set, computing the `[ref]` suffix automatically. */
export function formatPeerRows(rows: PeerRow[], now: number = Date.now()): string[] {
  const ambiguous = ambiguousNames(rows);
  return rows.map((r) => formatPeerRowText(r, ambiguous.has(r.name), now));
}

// --- target resolution -----------------------------------------------------

/**
 * Parse a `to` string: `<name>` or `<name> [<ref>]` (SPEC R-9).
 * The bracketed group is taken from the **end** of the string, so the kind
 * column of a compact row never leaks into the name.
 */
export function parsePeerTarget(to: string): { name: string; ref?: string } {
  const raw = typeof to === 'string' ? to.trim() : '';
  const m = /^(.*?)\s*\[([^\[\]]*)\]\s*$/.exec(raw);
  if (!m) return { name: raw };
  const name = (m[1] ?? '').trim();
  const ref = (m[2] ?? '').trim();
  return ref === '' ? { name } : { name, ref };
}

/** Identity key of a row: the owning session, falling back to the identity
 *  string / ref when the row carries no session id (rows built by the tool
 *  face may omit it). Two rows of the same identity must share this key. */
function identityKey(row: PeerRow): string {
  return row.sessionId ?? row.identity ?? row.ref ?? row.name;
}

/** Deduplicate hits: one row per owning identity, current row preferred. */
function dedupeByIdentity(rows: PeerRow[]): PeerRow[] {
  const bySession = new Map<string, PeerRow>();
  for (const row of rows) {
    const key = identityKey(row);
    const seen = bySession.get(key);
    if (!seen) {
      bySession.set(key, row);
      continue;
    }
    if (seen.former && !row.former) bySession.set(key, row);
  }
  return [...bySession.values()];
}

/** Describe candidate rows "by where they run" (SPEC R-9, CC `@15688356`). */
export function describeRows(rows: PeerRow[], limit = 8): string {
  const list = rows.slice(0, limit).map((r) => {
    const ref = ` [${r.ref}]`;
    const cwd = r.cwd ? ` cwd=${r.cwd}` : ' cwd=未知';
    const former = r.former ? ` (现名 ${r.currentName})` : '';
    return `${r.name}${ref} [${peerRowKindLabel(r)}]${cwd}${former}`;
  });
  if (rows.length > limit) list.push(`…共 ${rows.length} 个候选`);
  return list.join('；');
}

/**
 * Resolve a `to` string against the known rows (SPEC R-9 + DESIGN-V0.3.md
 * §5.3 resolution order).
 *
 * 1. `<name> [<ref>]` → exact (name, ref) match; hit wins even when the
 *    bare name is currently held by somebody else.
 * 2. bare `<name>` → every identity whose **addressable** name (current
 *    name *or* live alias) equals the string.
 * 3. exactly one identity → deliver.
 * 4. two or more → do not guess: `ambiguous` + candidate rows
 *    (CC "Do not guess between them" `@15688377`).
 * 5. several **alias** hits for the same string → newest releaser wins
 *    (SPEC R-10, the one scenario SPEC R-10 keeps; zcode-specific).
 * 6. zero hits → `not-found`.
 */
export function resolvePeerTarget(to: string, rows: PeerRow[]): PeerTargetResolution {
  const addressable = addressableRows(rows);
  const parsed = parsePeerTarget(to);

  if (parsed.name === '') {
    return { kind: 'not-found', message: '目标为空：to 必须是会话名或「名字 [ref]」。' };
  }

  if (parsed.ref !== undefined) {
    const byName = addressable.filter((r) => r.name === parsed.name);
    const exact = dedupeByIdentity(byName.filter((r) => r.ref === parsed.ref));
    if (exact.length === 1) return { kind: 'found', row: exact[0]! };
    if (exact.length > 1) {
      return { kind: 'ambiguous', candidates: exact };
    }
    const hint = byName.length > 0
      ? `名字「${parsed.name}」存在，但 [${parsed.ref}] 不匹配；该名字的 ref 是 ${byName.map((r) => r.ref).join('、')}。`
      : `没有名为「${parsed.name}」的可寻址会话（ref=${parsed.ref}）。`;
    const others = addressable.filter((r) => r.name !== parsed.name);
    return {
      kind: 'not-found',
      message: others.length > 0
        ? `${hint}本机可寻址会话：${describeRows(others)}。`
        : `${hint}本机没有其他可寻址会话。`,
    };
  }

  const hits = dedupeByIdentity(addressable.filter((r) => r.name === parsed.name));
  if (hits.length === 1) return { kind: 'found', row: hits[0]! };
  if (hits.length === 0) {
    const memberHit = rows.find((r) => r.kind === 'member' && r.name === parsed.name);
    const others = addressable.filter((r) => r.name !== parsed.name);
    const base = memberHit
      ? `「${parsed.name}」是队内成员（工作区花名），跨会话域不可寻址；请改用 peer 名字。`
      : `未找到名为「${parsed.name}」的可寻址会话。`;
    return {
      kind: 'not-found',
      message: others.length > 0
        ? `${base}本机可寻址会话：${describeRows(others)}。`
        : `${base}本机没有已注册且存活的 peer 会话。`,
    };
  }

  // Several hits: if *every* hit is an alias, the newest release wins
  // (SPEC R-10). A current-name holder plus an alias holder stay ambiguous.
  if (hits.every((r) => r.former)) {
    const winner = [...hits].sort((a, b) => (b.releasedAt ?? 0) - (a.releasedAt ?? 0))[0]!;
    return { kind: 'found', row: winner };
  }

  return { kind: 'ambiguous', candidates: hits };
}
