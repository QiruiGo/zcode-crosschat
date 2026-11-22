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
 * v0.9.8（J1，方案 §二 组J）→ v0.9.9（V098-11 收敛）：**interrupt/steer 纠错优先级
 * 不在本模块**。v0.9.8 曾在本模块预留一个 `priority:true` 优先级面（单独预留预算、
 * 置顶、绝不降级成摘要），但出厂包内没有任何生产路径构造优先级块（对抗轮 adv-2 F2，
 * P3 死代码：三个生产调用面全是 peer 域，而 peer 轴不携带 interrupt/steer 元数据；
 * 队内域的纠错置顶在消费窗口实现——见 {@link layoutInjectBlocks} 的注记）。
 * v0.9.9 删除该分支与相应文案承诺：本模块恢复 v0.9.7 单路排布算法，纠错优先的
 * 行为承诺指向真实实现处（mcp/tools-read.ts 的 inbox 批次窗口，即 xc_read 的
 * scope=inbox 消费面）。
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

/** 截断尾注（R-20；对齐 CC "[result truncated — ask the agent for the rest…]" @9943602）。
 *  v0.7（M6）：尾注是可行动指令（每条被截断消息都带），旧读面名随旧名移除同步改为
 *  xc_read 的 scope 形态——否则照旧文本行事的回合会撞 Tool not found。 */
export function truncateNote(pointer: InjectPointer, id: string, shown: number, total: number): string {
  return pointer === "peer"
    ? `[消息已截断：显示 ${shown}/${total} 字符 —— 用 xc_read({scope:"peer-msg", id:"${id}"}) 取全文/分页]`
    : `[消息已截断：显示 ${shown}/${total} 字符 —— 用 xc_read({scope:"mail", id:"${id}"}) 取全文/分页]`;
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
 * 单块的 item 截断（R-20；对齐 CC gca 的逐条截断）。
 * 导出供**批次窗口记账**复用：xc_read 各 scope / 快照板面在「消费前」
 * 必须按同一口径预估每条的成本（截断后长度含尾注），否则窗口算小了会把装不下的
 * 条目也算进窗口、排布阶段再降级成占位摘要（v0.5.2 SCALE-3 的「消费即省略」根因）。
 */
export function cutInjectBlock(
  block: InjectBlock,
  budget: InjectBudget,
  pointer: InjectPointer,
): { text: string; cut: boolean } {
  if (block.rendered.length <= budget.item) return { text: block.rendered, cut: false };
  const shown = Math.max(0, budget.item - 1);
  return { text: `${block.rendered.slice(0, shown)}\n${truncateNote(pointer, block.msgId, shown, block.rendered.length)}`, cut: true };
}

/** 单块在本预算下的注入成本（= item 截断后的字符数；窗口记账用）。 */
export function injectBlockCost(
  block: InjectBlock,
  budget: InjectBudget,
  pointer: InjectPointer,
): number {
  return cutInjectBlock(block, budget, pointer).text.length;
}

/**
 * 一组块的排布（v0.9.7 的原算法，J1 起抽成可复用原语）：
 * 花费按 ts 新→旧（CC gca recency 语义）；输出保持传入顺序（到达序）。
 *
 * 返回的 `texts` 与入参**逐下标对齐**（undefined = 该块未以任何形态进入——调用方
 * 决定这是「整条省略」还是「让位」）；`remaining` = 未花掉的预算。
 */
function placeGroup(
  blocks: readonly InjectBlock[],
  budget: InjectBudget,
  pointer: InjectPointer,
): { texts: (string | undefined)[]; truncatedCount: number; degradedCount: number; remaining: number } {
  const itemCut = (b: InjectBlock): { text: string; cut: boolean } => cutInjectBlock(b, budget, pointer);
  const order = blocks.map((b, i) => ({ b, i }));
  order.sort((x, y) => y.b.ts - x.b.ts);            // 新→旧花费；稳定（ts 相同保序）
  const spent: (string | undefined)[] = new Array<string | undefined>(blocks.length).fill(undefined);
  let remaining = budget.total;
  let truncatedCount = 0;
  let degradedCount = 0;
  // v0.5.2（SCALE-3 修正）：三个消费面（A 钩子 / B 工具间隙 / C peer 排空面）
  // 都是**先消费后排布**——排布时块对应的队列项已被取走。因此第一块（最新）
  // 在 item 截断后仍装不下时，必须硬切到剩余预算 + 指针，**绝不许降级成
  // 「已省略」占位摘要**：占位摘要 = 消费即省略（红队 #20 的根因形态）。
  // 旧块（在第一块完整呈现之后）仍按 CC gca 语义降一行摘要。
  let presentedFull = false;
  for (const { b, i } of order) {
    const { text, cut } = itemCut(b);
    if (cut) truncatedCount += 1;
    if (text.length <= remaining) { spent[i] = text; remaining -= text.length; presentedFull = true; continue; }
    if (!presentedFull) {
      // 保底一条：硬切到剩余预算 + 尾注（对齐 CC budget_truncated；消费面纪律）。
      truncatedCount += 1;
      const hard = b.rendered.slice(0, Math.max(0, remaining));
      spent[i] = `${hard}\n${truncateNote(pointer, b.msgId, hard.length, b.rendered.length)}`;
      remaining = 0;
      presentedFull = true;
      continue;
    }
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
  return { texts: spent, truncatedCount, degradedCount, remaining };
}

/** 面形状收口：{texts, counters} → LayoutResult（与 v0.9.7 的返回形状逐字段一致）。 */
function finishLayout(
  blockCount: number,
  ordered: readonly string[],
  counters: { truncatedCount: number; degradedCount: number },
  totalChars: number,
): LayoutResult {
  // budgetTruncated = 发生了任何降级（item 截断/摘要降级/整条省略/硬切）。
  // 修正（相对 DESIGN §6.3-1 初稿公式 `truncatedCount>0 || out.length<blocks.length`）：
  // 摘要降级在 out.length===blocks.length 且无 item 截断时也必须上报（CC gca
  // `budget_truncated` @9950292 语义；SPEC R-17 ③④）。
  return {
    blocks: [...ordered],
    truncatedCount: counters.truncatedCount,
    budgetTruncated: counters.truncatedCount > 0 || counters.degradedCount > 0 || ordered.length < blockCount,
    totalChars,
  };
}

/**
 * 注入排布（R-17）。花费按 ts 新→旧（CC gca recency 语义）；输出保持传入顺序
 * （到达序，行为兼容优先）。调用方对被截的跨会话域条目已先行 store 全文（R-21）。
 *
 * v0.9.9（V098-11）：**优先级面已删**——v0.9.8 的 `priority:true`（interrupt/steer）
 * 分支在出厂包内零生产流量：本函数的三个生产调用面全是 **peer 域**（hooks 面 A /
 * mcp/peer-drain.ts 面 B / xc_read 的 peer scope 面 C），而 peer 轴不携带
 * interrupt/steer 元数据（PeerQueueItem 只有 urgent/refs——J1 优先级只覆盖
 * 队内域）；队内域的纠错置顶在**消费窗口**实现（mcp/tools-read.ts 的
 * `xc_read` scope=inbox：`interruptFirst` 排序 + 批次窗口先给纠错面开窗、普通面用剩余
 * 预算），因为消费面「先消费后渲染」，把已消费的块交给本函数的摘要降级就是
 * 「已消费却没进上下文」（v0.5.2 SCALE-3 根因形态）。本函数恢复 v0.9.7 单路算法，
 * 与无优先级块时的旧路径逐字节同行为。
 */
export function layoutInjectBlocks(
  blocks: readonly InjectBlock[],
  budget: InjectBudget,
  pointer: InjectPointer,
): LayoutResult {
  const placed = placeGroup(blocks, budget, pointer);
  const ordered = placed.texts.filter((s): s is string => s !== undefined);
  return finishLayout(blocks.length, ordered, placed, budget.total - placed.remaining);
}

/** 字段截断（status/snapshot 任务 result/error 与邮箱 payload content 共用，R-23）。 */
export interface TruncatedField { text: string; truncated?: { shown: number; total: number; sha256: string } }

export function truncateField(text: string, itemBudget: number, sha256Of: (s: string) => string): TruncatedField {
  if (text.length <= itemBudget) return { text };
  const shown = Math.max(0, itemBudget - 1);
  return { text: text.slice(0, shown), truncated: { shown, total: text.length, sha256: sha256Of(text) } };
}

/**
 * 批次窗口计数（v0.5.1 SCALE-1 修复引入，v0.5.2 起三个批量面共用）：
 * 给定每条消息在本响应两个面（机器 JSON 面 + 注入信封面）的联合成本，按**到达序
 * 前缀**累加，返回能放进 `budgetTotal` 的条数。保底第一条（单条超预算也返回 1，
 * 由调用方的 item 截断兜住单条上限）；`costs` 为空返回 0。
 *
 * 与 layoutInjectBlocks（peer 面 A/B/C 的注意力排布：新→旧花费、旧条降摘要）的
 * 差异是**有意的**：xc_read 各 scope / xc_overview 板面是消费面/观测面，
 * 被窗口留在外面的消息保持未读（或留在队列）、下一批继续消费，不需要降级摘要行；
 * 预算口径同源（budget.total）。
 *
 * 调用方纪律：成本必须按 {@link injectBlockCost}（item 截断后长度）计，不能按
 * 原始渲染长度计——否则窗口内仍会装下超 item 的条目，排布阶段把它们降级成
 * 「已省略」占位符，出现「已消费但没进上下文」的假消费（v0.5.2 SCALE-3）。
 */
export function batchWindowCount(costs: readonly number[], budgetTotal: number): number {
  let sum = 0;
  let count = 0;
  for (const cost of costs) {
    if (count > 0 && sum + cost > budgetTotal) break;
    sum += cost;
    count += 1;
  }
  return count;
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
