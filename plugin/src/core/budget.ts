/**
 * v0.5 轴③：接收方注入预算与分页原语（DESIGN-V0.5.md §5.1）。
 *
 * 基准常量 = CC 实证值（SPEC-V0.5 §3.1）：单条 4000（CC IDLE_RESULT_MAX_LENGTH，
 * `var G9=4000` @9943602）、批次 16000（CC IDLE_RESULT_TOTAL_BUDGET `LLi` 同切片）。
 * CC 只有固定常量；per-receiver 缩放是 zcode 增设（SPEC R-17）。
 *
 * 纪律：
 * - 预算只作用于渲染/注入层；磁盘真源（队列/邮箱 JSONL、team.json）永远全文（R-21）。
 * - 误声明只影响刻度：偏小=多截断（安全方向），偏大=不劣于 v0.4（R-18/V-1）。
 * - 回退：XC_INJECT_ITEM_CHARS / XC_INJECT_TOTAL_CHARS 设极大值 = v0.4 行为（R-25）。
 * - 排布对齐 CC gca()（@9949851/@9950292）：逐条先截 item；总预算按 recency 新→旧花费；
 *   超支的最旧条目降一行摘要；保底一条；再超硬切。
 *
 * @module core/budget
 */

export const INJECT_DEFAULT_CONTEXT_CHARS = 200_000;
export const INJECT_ITEM_BASE = 4_000;
export const INJECT_TOTAL_BASE = 16_000;
export const INJECT_SCALE_MIN = 0.25;
export const INJECT_SCALE_MAX = 4;
export const INJECT_ITEM_MIN = 1_000;
export const INJECT_ITEM_MAX = 16_000;
export const INJECT_TOTAL_MIN = 4_000;
export const INJECT_TOTAL_MAX = 64_000;
/** 分页读工具单次返回上限（R-22）。 */
export const READ_PAGE_MAX_CHARS = 64_000;

function envPositiveInt(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** 接收方上下文字符数（声明值，R-18/V-1）：XC_CONTEXT_CHARS，非法/未设 → 200_000。 */
export function contextCharsFromEnv(env: NodeJS.ProcessEnv): number {
  return envPositiveInt(env, "XC_CONTEXT_CHARS") ?? INJECT_DEFAULT_CONTEXT_CHARS;
}

export interface InjectBudget { item: number; total: number; scale: number }

/** 预算函数（R-17）。XC_INJECT_* 覆盖预算函数输出（测试与调参，R-25；0/非法=未设）。 */
export function receiverInjectBudget(
  contextChars: number,
  env: NodeJS.ProcessEnv = process.env,
): InjectBudget {
  const ctx = Number.isFinite(contextChars) && contextChars > 0
    ? contextChars : INJECT_DEFAULT_CONTEXT_CHARS;
  const scale = Math.min(INJECT_SCALE_MAX, Math.max(INJECT_SCALE_MIN, ctx / INJECT_DEFAULT_CONTEXT_CHARS));
  const item = envPositiveInt(env, "XC_INJECT_ITEM_CHARS")
    ?? Math.min(INJECT_ITEM_MAX, Math.max(INJECT_ITEM_MIN, Math.round(INJECT_ITEM_BASE * scale)));
  const total = envPositiveInt(env, "XC_INJECT_TOTAL_CHARS")
    ?? Math.min(INJECT_TOTAL_MAX, Math.max(INJECT_TOTAL_MIN, Math.round(INJECT_TOTAL_BASE * scale)));
  return { item, total: Math.max(total, item), scale };
}

export type InjectPointer = "peer" | "mail";

/** 截断尾注（R-20；对齐 CC "[result truncated — ask the agent for the rest…]" @9943602）。 */
export function truncateNote(pointer: InjectPointer, id: string, shown: number, total: number): string {
  return pointer === "peer"
    ? `[消息已截断：显示 ${shown}/${total} 字符 —— 用 xc_peer_read({msgId:"${id}"}) 取全文/分页]`
    : `[消息已截断：显示 ${shown}/${total} 字符 —— 用 xc_mail_read({messageId:"${id}"}) 取全文/分页]`;
}

export interface InjectBlock {
  msgId: string;
  from: string;
  origin?: "user" | "agent";
  ts: number;
  /** 渲染完成的完整注入块（信封+尾注；跨会话域调用方保证超 item 时已先落全文 store）。 */
  rendered: string;
  /** 超支时的一行摘要（含 msgId/from/origin 与省略说明）。 */
  summaryLine: string;
}

export interface LayoutResult {
  blocks: string[];
  truncatedCount: number;
  budgetTruncated: boolean;
  totalChars: number;
}

/**
 * 注入排布（R-17）。花费按 ts 新→旧（CC gca recency 语义）；输出保持传入顺序
 * （到达序，行为兼容优先）。调用方对被截的跨会话域条目已先行 store 全文（R-21）。
 */
export function layoutInjectBlocks(
  blocks: readonly InjectBlock[],
  budget: InjectBudget,
  pointer: InjectPointer,
): LayoutResult {
  const itemCut = (b: InjectBlock): { text: string; cut: boolean } => {
    if (b.rendered.length <= budget.item) return { text: b.rendered, cut: false };
    const shown = Math.max(0, budget.item - 1);
    return { text: `${b.rendered.slice(0, shown)}\n${truncateNote(pointer, b.msgId, shown, b.rendered.length)}`, cut: true };
  };
  const order = blocks.map((b, i) => ({ b, i }));
  order.sort((x, y) => y.b.ts - x.b.ts);            // 新→旧花费；稳定（ts 相同保序）
  const spent: (string | undefined)[] = new Array<string | undefined>(blocks.length).fill(undefined);
  let remaining = budget.total;
  let truncatedCount = 0;
  let degradedCount = 0;
  for (const { b, i } of order) {
    const { text, cut } = itemCut(b);
    if (cut) truncatedCount += 1;
    if (text.length <= remaining) { spent[i] = text; remaining -= text.length; continue; }
    // 超支：降一行摘要（最旧先牺牲——此时起后续（更旧）条目只尝试摘要行）。
    degradedCount += 1;                              // 该条未以全文/item 截断文完整进入（R-24 降级）
    if (b.summaryLine.length <= remaining) { spent[i] = b.summaryLine; remaining -= b.summaryLine.length; }
  }
  // 保底一条：一块未放进 → 新块硬切到 total。
  // （布尔中转避免 TS 5.5 对 `spent.every(s => s === undefined)` 的元素收窄把
  //   spent 缩成 undefined[] —— 与 DESIGN §6.3-1 原式同语义。）
  const nothingPlaced = spent.every((s): boolean => s === undefined) && order.length > 0;
  if (nothingPlaced) {
    const first = order[0]!;
    const hard = first.b.rendered.slice(0, Math.max(0, budget.total));
    if (hard.length < first.b.rendered.length) {
      truncatedCount += 1;                           // 硬切也是截断（R-24 budget_truncated）
      spent[first.i] = `${hard}\n${truncateNote(pointer, first.b.msgId, hard.length, first.b.rendered.length)}`;
    } else {
      spent[first.i] = hard;
    }
    remaining = 0;
  }
  const out = spent.filter((s): s is string => s !== undefined);
  // budgetTruncated = 发生了任何降级（item 截断/摘要降级/整条省略/硬切）。
  // 修正（相对 DESIGN §6.3-1 初稿公式 `truncatedCount>0 || out.length<blocks.length`）：
  // 摘要降级在 out.length===blocks.length 且无 item 截断时也必须上报（CC gca
  // `budget_truncated` @9950292 语义；SPEC R-17 ③④）。
  return { blocks: out, truncatedCount, budgetTruncated: truncatedCount > 0 || degradedCount > 0 || out.length < blocks.length, totalChars: budget.total - remaining };
}

/** 字段截断（status/snapshot 任务 result/error 与邮箱 payload content 共用，R-23）。 */
export interface TruncatedField { text: string; truncated?: { shown: number; total: number; sha256: string } }

export function truncateField(text: string, itemBudget: number, sha256Of: (s: string) => string): TruncatedField {
  if (text.length <= itemBudget) return { text };
  const shown = Math.max(0, itemBudget - 1);
  return { text: text.slice(0, shown), truncated: { shown, total: text.length, sha256: sha256Of(text) } };
}

/** 分页原语（R-22 通用约束）：非法入参由调用面映射 invalid_params；越界安全。 */
export function paginateText(
  text: string, offset: number | undefined, limit: number | undefined, defaultLimit: number,
): { total: number; offset: number; text: string; hasMore: boolean } {
  const total = text.length;
  const off = Math.max(0, offset ?? 0);
  if (off >= total) return { total, offset: off, text: "", hasMore: false };
  const len = Math.min(Math.max(1, limit ?? defaultLimit), READ_PAGE_MAX_CHARS);
  const slice = text.slice(off, off + len);
  return { total, offset: off, text: slice, hasMore: off + slice.length < total };
}
