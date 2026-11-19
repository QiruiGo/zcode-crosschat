/**
 * v0.5 轴②：用户原话记录与盖章匹配（DESIGN-V0.5.md §4.3；SPEC R-12）。
 *
 * 机理对齐 CC「归属由 harness 从服务端归属生成，绝不依据消息内容」@8685923：
 * origin=user 的唯一产生路径 = 钩子（harness 侧）记录用户原始提示 + 工具落盘前
 * 逐字节匹配。工具没有 origin 参数；正文自称无效。
 *
 * 记录形态（复核 P4 改环形）：{sessionId, updatedAt, prompts:[{ts,text,uses}]×≤8}——
 * 用户第一条转达指令不被后续 prompt 覆盖；窗口外/超长的原话不参与匹配（A5-L8）。
 *
 * 威胁模型边界（V-2，如实声明）：同机模型主动伪造本记录文件可绕过匹配。不做密码学
 * 防御（与 CC verifiedPeerPid 同级）；防线=①钩子进程独写+uservoice-hit 事件与消息
 * 事件交叉审计、②接收侧永不因 origin=user 放宽任何权限、③本条公开声明。
 *
 * 并发声明：钩子进程写与 MCP 进程消费是两个进程，uses 读改写有丢更新窗口；
 * uses 只是节流阀（≤3 次），最坏多一次使用，可接受，不做跨进程锁。
 *
 * @module core/uservoice
 */
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomic, stripLeadingBom } from './atomic.js';
import { peerUservoiceFile } from './peerdir.js';
import { readSession } from './registry.js';
import { scanPeers } from './peerregistry.js';

/** 单条原话上限（R-12：钩子记录不是消息本体）。 */
export const USERVOICE_TEXT_MAX_CHARS = 64 * 1024;
/** 单条使用上限（R-12：每记录 ≤3 次）。 */
export const USERVOICE_MAX_USES = 3;
/** 环形容量（复核 P4）：保留最近 8 条用户 prompt。 */
export const USERVOICE_RING_CAPACITY = 8;
export const USERVOICE_TTL_DEFAULT_MS = 600_000;

export interface UservoiceEntry { ts: number; text: string; uses: number }
export interface UservoiceRecord { sessionId: string; updatedAt: number; prompts: UservoiceEntry[] }

function ttlFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env['XC_USERVOICE_TTL_MS'];
  if (raw === undefined || raw.trim() === '') return USERVOICE_TTL_DEFAULT_MS;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : USERVOICE_TTL_DEFAULT_MS;
}

/** 钩子侧：记录本轮用户原始提示（追加进环形、超容挤掉最旧；与最新一条相同文本则只刷 ts）。 */
export async function uservoiceWrite(
  root: string, sessionId: string, text: string, now: number,
): Promise<void> {
  const capped = text.length > USERVOICE_TEXT_MAX_CHARS
    ? `${text.slice(0, USERVOICE_TEXT_MAX_CHARS)}\n[uservoice truncated at ${USERVOICE_TEXT_MAX_CHARS} chars]`
    : text;
  const file = peerUservoiceFile(root, sessionId);
  await mkdirFor(file);
  const prev = await readRecord(root, sessionId);
  const prompts = [...(prev?.prompts ?? [])];
  const last = prompts[prompts.length - 1];
  if (last !== undefined && last.text === capped) {
    prompts[prompts.length - 1] = { ...last, ts: now };   // 同文本重发：刷新时间窗，不重复占位
  } else {
    prompts.push({ ts: now, text: capped, uses: 0 });
  }
  const record: UservoiceRecord = {
    sessionId, updatedAt: now, prompts: prompts.slice(-USERVOICE_RING_CAPACITY),
  };
  await writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
}

async function mkdirFor(file: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dirname(file), { recursive: true });
}

async function readRecord(root: string, sessionId: string): Promise<UservoiceRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(stripLeadingBom(await readFile(peerUservoiceFile(root, sessionId), 'utf8')));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const r = parsed as Record<string, unknown>;
    if (typeof r['sessionId'] !== 'string' || !Array.isArray(r['prompts'])) return undefined;
    const prompts: UservoiceEntry[] = [];
    for (const raw of r['prompts']) {
      if (typeof raw !== 'object' || raw === null) continue;
      const e = raw as Record<string, unknown>;
      if (typeof e['ts'] !== 'number' || typeof e['text'] !== 'string' || typeof e['uses'] !== 'number') continue;
      prompts.push({ ts: e['ts'], text: e['text'], uses: e['uses'] });
    }
    return { sessionId: r['sessionId'], updatedAt: typeof r['updatedAt'] === 'number' ? r['updatedAt'] : 0, prompts };
  } catch {
    return undefined;
  }
}

export type UservoiceMatch =
  | { hit: true; uses: number }
  | { hit: false; reason: 'no-record' | 'expired' | 'uses-exhausted' | 'no-match' };

/**
 * 工具侧：待发正文与本会话环形记录逐条匹配（新→旧，首个命中即用）；命中 → 该条 uses+1 原子覆写。
 * 匹配方向（复核 P5 澄清，R-12 原文语义）：outgoing 是用户 prompt 的**一段**——
 * `outgoing.trim() === entry.text`（全文相等）或 `outgoing.trim().length >= 8 && entry.text.includes(outgoing.trim())`。
 * 「原话拼进自产内容」不构成 prompt 的连续子串 → includes 失败 → origin=agent（piggyback 不可行，§4.3）。
 * 单条目过期/耗尽 → 跳过；全部过期 → 'expired'，全部耗尽 → 'uses-exhausted'；未命中不消耗 uses。
 */
export async function uservoiceMatchAndConsume(
  root: string, sessionId: string, outgoingText: string, now: number, env: NodeJS.ProcessEnv = process.env,
): Promise<UservoiceMatch> {
  const record = await readRecord(root, sessionId);
  if (record === undefined || record.prompts.length === 0) return { hit: false, reason: 'no-record' };
  const ttl = ttlFromEnv(env);
  const trimmed = outgoingText.trim();
  if (trimmed === '') return { hit: false, reason: 'no-match' };
  const live = record.prompts.filter((e) => now - e.ts <= ttl);
  if (live.length === 0) return { hit: false, reason: 'expired' };
  const available = live.filter((e) => e.uses < USERVOICE_MAX_USES);
  if (available.length === 0) return { hit: false, reason: 'uses-exhausted' };
  let matchedIndex = -1;
  for (let i = available.length - 1; i >= 0; i -= 1) {          // 新→旧
    const e = available[i]!;
    if (trimmed === e.text || (trimmed.length >= 8 && e.text.includes(trimmed))) {
      matchedIndex = record.prompts.indexOf(e);
      break;
    }
  }
  if (matchedIndex < 0) return { hit: false, reason: 'no-match' };
  const prompts = [...record.prompts];
  const matched = prompts[matchedIndex]!;
  prompts[matchedIndex] = { ...matched, uses: matched.uses + 1 };
  await writeFileAtomic(peerUservoiceFile(root, sessionId),
    `${JSON.stringify({ ...record, prompts }, null, 2)}\n`);
  return { hit: true, uses: matched.uses + 1 };
}

// ---------------------------------------------------------------------------
// v0.5.2（二番战 SEC-1）：origin=user 盖章权的活性/锚定双重验证
// ---------------------------------------------------------------------------

/** 盖章权验证结论。 */
export type StampAuthorityVerdict =
  | { ok: true }
  | { ok: false; reason: 'unanchored' | 'session-id-held-elsewhere' };

/**
 * 盖章权验证选项。
 * v0.9.1（G-11）：`voiceOwner` = 调用方连接经**唤醒 nonce 证明**继承到的原会话
 * （xc_identify 的 wakeToken 路径从 nonce.voiceOwner 转记，见 mcp/identity.ts）。
 * 与 `sessionId` 相等时，第 1 条拒绝线（sid 被别的活进程持有）对**本 sid** 放宽——
 * 无头 --resume 回合与桌面原会话共享 sid，按 sid 独占一票否决会让被唤醒回合永远
 * 无法转达用户原话（生产 4 次 session-id-held-elsewhere 拒绝）。放宽仅对
 * voiceOwner === 本 sid 生效——外部会话/peer 冒充（无 nonce）的拒绝线不放松。
 *
 * v0.9.1 打回第 1 轮（V091-01/V091-02）口径校正：原注释声称 nonce「只随唤醒
 * prompt 到无头进程」——adv-1 实测该保密性前提不成立（nonce 曾明文落共享日志）。
 * 现行信任基础 = mcp/identity.ts 三层收窄（nonce 真值不落共享日志只留摘要；
 * wakeToken 路径拒「别的 sid 的活注册会话」消费令牌；放宽仅限本 sid），残余边界
 * （无 peer 活记录的脚本形态 + 同状态根可读真源）与 README 已知限制 12 同族，
 * 在此如实声明，不假装成密码学防御。
 */
export interface StampAuthorityOptions {
  voiceOwner?: string;
}

/**
 * origin=user 盖章前的会话归属核验（工具层在 {@link uservoiceMatchAndConsume}
 * 之前调用；peer 轴与队内轴共用）。
 *
 * 背景（红队二番战 SEC-1，rtsec C2）：xc_peer_register 此前不校验 sessionId 归属，
 * 攻击者纯 API 冒充受害者 sid → uservoiceMatchAndConsume 读到**受害者**的
 * uservoice 记录 → 偷取 origin=user 权威标记。注册层的归属硬校验（peer-tools 的
 * `session_id_in_use` 闸）堵住活体冒充的主路径；本函数是盖章面的第二道闸，两条
 * 拒绝线（任一命中即拒绝）：
 *
 * 1. `session-id-held-elsewhere`：机器全局注册表里该 sid 被一个**别的活进程**持有
 *    ——真实归属者正在活动，本进程不可能是它（覆盖旧版本遗留/直写注册表的冒充态）。
 *    v0.9.1（G-11）例外：`options.voiceOwner === sessionId`（唤醒续跑证明）时本线
 *    对本 sid 放宽——共享 sid 的无头回合是原会话的合法续跑，不是冒充；
 * 2. `unanchored`：本会话的工作区没有钩子锚定的会话记录
 *    （`.crosschat/registry/sessions/<sid>.json`——SessionStart/refreshSessionLastSeen
 *    对每个真会话都写）。跨工作区偷 sid 时，受害者的锚定记录在**受害者**的工作区，
 *    攻击者工作区没有 → 拒绝。注意不能把「peers/base/<sid>.json 存在」当作锚：
 *    该文件机器全局，偷来的 sid 同样查得到（非判别信号）；也不能把「本进程注册过
 *    该 sid」当作锚——那正是冒充者自己造的状态。**本线不因 voiceOwner 放宽**：
 *    唤醒路径的 xc_identify 会服务端代写锚定记录，合法续跑本就满足。
 *
 * 残余边界（如实声明）：受害者已死亡且与攻击者同工作区时，锚定记录仍在、注册表
 * 记录已被清扫 → 无法区分「复活的本人」与「小偷」——与 README 已知限制 12 的
 * 威胁模型边界一致（不做密码学防御）。
 */
export async function verifyUservoiceStampAuthority(
  root: string,
  stateRoot: string,
  sessionId: string,
  options: StampAuthorityOptions = {},
): Promise<StampAuthorityVerdict> {
  // v0.9.1（G-11）：唤醒续跑证明在场时，第 1 条线对本 sid 免检（第 2 条锚定线照旧）。
  const wakeContinuation = options.voiceOwner !== undefined && options.voiceOwner === sessionId;
  if (!wakeContinuation) {
    const scanned = await scanPeers(root);
    const holder = scanned.active.find((record) => record.sessionId === sessionId);
    if (holder !== undefined && holder.pid !== process.pid) {
      return { ok: false, reason: 'session-id-held-elsewhere' };
    }
  }
  const anchored = await readSession(stateRoot, sessionId).catch(() => undefined);
  if (anchored !== undefined) return { ok: true };
  return { ok: false, reason: 'unanchored' };
}
