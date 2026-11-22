/**
 * M3/W4 render：工具的人可读输出（一行摘要沿用 dsh tools.js render 思路）、
 * xc_overview 任务板与 v0.2 全景渲染（DESIGN.md §2.8/§4.3；DESIGN-V0.2.md §7.3.1）。
 *
 * v0.2（W4 改动边界，DESIGN-V0.2 §9.1）：
 * - StatusSnapshot/StatusSnapshotTask 类型改从 core/snapshot.ts 导入（W3 承载，
 *   「自 render.ts 迁入」）；此处 re-export 保持 v0.1.0 消费方（tools.ts 的
 *   `import type { StatusSnapshot } from "./render.js"`）不动。
 * - 新增 renderPanorama：v2 全景渲染 = 成员状态表（working/idle/provisioning/
 *   failed/removed，含 lead 标注）+ 任务板 + DAG 一行图（`t1 ─▶ t2`）。
 * - renderStatusTable 升级为双形态：快照带全景字段（leadKey/dag/engine，W3
 *   refreshSnapshot 的 v2 形状）→ 全景渲染；v0.1.0 形状（tools.ts 板面构造）
 *   → 输出与 v0.1.0 逐字符一致（回归锁定，render.test.ts 双路径覆盖）。
 *
 * 依赖纪律：对 M1 只 import writeFileAtomic（atomic.ts，Windows 原子写 §2.7-6）
 * 与 snapshotFile（paths.ts）；类型来自 core/snapshot.ts（W3，只依赖 M1）。
 * 纯渲染函数不碰盘、可独立单测。
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileAtomic } from "../core/atomic.js";
import { snapshotFile } from "../core/paths.js";
import type { StatusSnapshot, StatusSnapshotTask } from "../core/snapshot.js";

export type { StatusSnapshot, StatusSnapshotTask };

/** dsh 风格短 id：前 8 位即可在人可读行里辨认。 */
export function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

export function renderRegister(agentKey: string, sessionId: string, teamId: string, roster: Array<{ key: string }>, warnings: string[]): string {
  const names = roster.map((m) => m.key).join(", ") || "(empty)";
  const warn = warnings.length > 0 ? `; warnings: ${warnings.join("; ")}` : "";
  return `Session bound: ${agentKey} (${shortId(sessionId)}) → team "${teamId}"; roster: ${names}${warn}.`;
}

/**
 * xc_dispatch 的一行摘要。
 *
 * v0.9.7（W3/V096-01）：wake 态补**三态**参数——失败态（两轮唤醒全失败，回执时刻
 * 已见失败证据）不再写 "via wake"（那会把失败读成成功），改写失败措辞 + 邮箱兜底
 * 指引；未见启动证据态追加「已发起但未见启动证据（非送达确认）」。缺省（不传 wake）
 * 输出与 v0.9.6 逐字节一致（旧调用方零行为变化）。
 */
export function renderDispatch(
  taskId: string,
  to: string,
  delivered: string,
  wake?: WakeReceiptState,
): string {
  if (delivered === "wake") {
    const failure = wakeReceiptFailurePhrase(wake);
    if (failure !== undefined) return `Task ${taskId} dispatched to ${to}: ${failure}.`;
    if (wake?.startConfirmed === false) {
      return `Task ${taskId} dispatched to ${to} via wake（已发起但未见启动证据，非送达确认）.`;
    }
  }
  return `Task ${taskId} dispatched to ${to} via ${delivered}.`;
}

export function renderInbox(consumed: number, discarded: number, unread: number, malformed = 0, batchPointer = ""): string {
  const base = `Inbox: ${consumed} message(s) consumed, ${discarded} stale discarded, ${unread} unread remain`;
  // v0.5.1（故障注-3 修复）：不可解析坏行计数披露——此前坏行被静默跳过（仅审计
  // 留痕），整箱乱码时静默当空箱，调用方无从得知有消息协议层不可恢复。
  const bad = malformed > 0 ? `; ${malformed} unreadable line(s) skipped` : "";
  // v0.5.1（SCALE-1 修复）：批次窗口截断的续读指针（窗口外消息保持未读，下一批继续消费）。
  const batch = batchPointer === "" ? "" : `; ${batchPointer}`;
  return `${base}${bad}${batch}.`;
}

export function renderClaim(taskId: string, attempt: number, attemptId: string): string {
  return `Task ${taskId} claimed (attempt ${attempt}, attemptId ${shortId(attemptId)}).`;
}

/**
 * xc_report 的一行摘要。
 *
 * v0.9.7（W3/V096-01）：wake 态补**三态**参数——两轮唤醒全失败时不再写
 * "wake back via wake"（V096-01 实测该形态），改写失败措辞 + 邮箱兜底指引；
 * 未见启动证据态追加「已发起但未见启动证据」。缺省输出与 v0.9.6 逐字节一致。
 */
export function renderReport(
  taskId: string,
  status: string,
  receiptTo: string | null,
  wakeBack: string,
  wake?: WakeReceiptState,
): string {
  const to = receiptTo ? `receipt sent to ${receiptTo}` : "no receipt (non-terminal)";
  if (wakeBack === "wake") {
    const failure = wakeReceiptFailurePhrase(wake);
    if (failure !== undefined) return `Task ${taskId} ${status}; ${to}; 回执${failure}.`;
    if (wake?.startConfirmed === false) {
      return `Task ${taskId} ${status}; ${to}; wake back via wake（已发起但未见启动证据，非送达确认）.`;
    }
  }
  return `Task ${taskId} ${status}; ${to}; wake back via ${wakeBack}.`;
}

/**
 * v0.9.4（A3，tools-team 同款措辞）：通知类回执的投递结果措辞——wake 成功才可写
 * 「已发起唤醒」（且仍非送达确认）；mailbox 降级（wake-skipped：分层闸/在途 nonce/
 * 成员状态/容量闸/spawn 失败）只写「仅落邮箱（未唤醒，pull 兜底）」。v0.9.5（A4/V094-06）把它
 * 提升到本模块供 {@link renderMessage} 复用——xc_relay 主消息路径旧文案
 * "delivered via mailbox" 会把「仅落邮箱」读成「已送达」，A4 判据（wake-skipped 场景
 * 禁出现已送达/已消费）据此收口。与 tools-team.ts 的同名函数措辞逐字一致（两处
 * 分属不同组装链；文案漂移由两侧定向测试逐字对拍锁定）。
 *
 * v0.9.6（V095-14）：wake 态增**启动两态**参数——`startConfirmed:false`（已发起但
 * 未见启动证据）不再与确认态混写同一句（adv3-F1 TC3：两态披露只进 note 散文）。
 * 缺省（undefined）保持 v0.9.4 措辞（旧调用方零行为变化）。
 */
export function renderDeliveryOutcome(delivered: "wake" | "mailbox", startConfirmed?: boolean): string {
  return delivered === "wake"
    ? startConfirmed === false
      ? "已发起唤醒但未见启动证据（wake，非送达确认）"
      : "已发起唤醒（wake，非送达确认）"
    : "仅落邮箱（未唤醒，pull 兜底）";
}

/**
 * v0.9.7（V096-01/24，组 W W3）：wake 回执的**三态结构化输入**——dispatch / report /
 * relay 三面同形，字段与 engine/wake.ts 的 {@link WakeResult} 同名字段一一对应：
 * - `startConfirmed`：启动确认两态（false = 已发起但未见启动证据）；
 * - `wakeTiers`：三级指标回执面快照（spawnOk/childAlive/consumed）；
 * - `wakeFailureSeen` + `failureEvidence`：**失败第三态**——回执时刻对 wake 日志的
 *   有界回读已见失败证据（sessionNotFound 等正向失败形态）。
 *
 * 三面调用方从 attemptWake 的返回值透传（v0.9.6 起 tools-team 六处回执点已接线；
 * v0.9.7 补齐 dispatch/report/relay 三面——V096-01/24 的结构性丢键）。
 */
export interface WakeReceiptState {
  startConfirmed?: boolean;
  wakeFailureSeen?: boolean;
  failureEvidence?: string;
  wakeTiers?: { spawnOk: "ok"; childAlive: "ok" | "no"; consumed: "pending" };
}

/**
 * v0.9.7（W3）：**失败措辞**（回执时刻已见失败证据时）；无失败证据 → undefined。
 *
 * 两轮唤醒全失败（主唤醒 + sessionNotFound 自动重绑重试）时，人可读行不得再写
 * "dispatched via wake" / "wake back via wake"——那会把「发起了但失败了」读成成功
 * （V096-01 实侧：两轮全失败仍写 via wake）。失败措辞优先于 via wake，并保留
 * 「消息已在邮箱、pull 兜底、勿按已开工处理」的行动指引。
 */
export function wakeReceiptFailurePhrase(wake: WakeReceiptState | undefined): string | undefined {
  if (wake?.wakeFailureSeen !== true) return undefined;
  const evidence = wake.failureEvidence?.trim();
  const shown = evidence !== undefined && evidence !== "" ? `：${evidence.slice(0, 160)}` : "";
  return `唤醒失败（回执时刻 wake 日志已见失败证据${shown}）——消息已在邮箱（pull 兜底），请勿按已开工处理`;
}

/**
 * v0.9.8（S5，组 S）：**steer 回执的三态结构化输入**——字段与 engine/wake.ts 的
 * {@link SteerOutcome} 同形（requested/result/reason/stopped/turn）：
 * - `result:"preempted"`：终止→续跑真发生（stopped + turn 两块实况在场）；
 * - `result:"deferred-next-turn"`：降级（目标空闲/闸挡下/终止或 spawn 失败）——
 *   纠偏随投递送达，收方下回合生效；
 * - `result:"unsupported"`：交互式会话（插件无权终止，只有用户 Esc）。
 *
 * 人可读行由 {@link steerReceiptPhrase} 产出——三态措辞分流，失败/降级不写「抢占成功」。
 */
export interface SteerReceiptState {
  requested: true;
  result: "preempted" | "deferred-next-turn" | "unsupported";
  reason: string;
  stopped?: { pid: number; graceful: boolean; waitedMs: number };
  turn?: { nonce: string; startConfirmed: boolean };
}

/**
 * v0.9.8（S5）：steer 回执的人可读短语（三态分流；无 steer → undefined）。
 *
 * - preempted：⛔ 抢占成功 + 终止实况（pid/graceful|forced/等待 ms）+ 新回合启动两态 +
 *   「未落盘进度可能丢失」披露（强杀副作用，方案 §五 边界）；
 * - deferred-next-turn：⛔ steer 降级 + 原因（idle/闸挡/失败）——不写「已抢占」；
 * - unsupported：⛔ 不支持抢占 + 原因（交互式会话只有用户 Esc）+ 软中断兜底指引。
 */
export function steerReceiptPhrase(steer: SteerReceiptState | undefined): string | undefined {
  if (steer === undefined || steer.requested !== true) return undefined;
  if (steer.result === "preempted") {
    const stopped = steer.stopped !== undefined
      ? `（终止 pid ${steer.stopped.pid}，${steer.stopped.graceful ? "graceful" : "forced"}，等待 ${steer.stopped.waitedMs}ms）`
      : "";
    const turn = steer.turn !== undefined
      ? steer.turn.startConfirmed
        ? "；新回合已启动（start-confirmed）"
        : "；新回合已发起但未见启动证据（非送达确认）"
      : "";
    return `⛔ steer 抢占成功${stopped}：旧回合已终止，纠偏是新回合首条指令${turn}；旧回合未落盘进度可能丢失`;
  }
  if (steer.result === "unsupported") {
    return `⛔ steer 不支持抢占：${steer.reason}`;
  }
  return `⛔ steer 降级（未抢占）：${steer.reason}`;
}

/**
 * xc_relay 主消息路径（队内轴；peer 轴发送走 relayPeerSend 自己的信封渲染）的一行摘要。
 *
 * v0.9.5（A4/V094-06）：**文案如实**——旧实现三态都写 "delivered via X"：
 * - `mailbox`（wake 关闭/分层闸/在途/容量闸/spawn 失败等一切未唤醒路径）实为
 *   「仅落邮箱（未唤醒）：消息未送达也未消费」，旧文案读成「已送达」= 对用户撒谎；
 *   现按 {@link renderDeliveryOutcome} 分流，并透传 note（attemptWake 的降级原因，
 *   mailboxOnlyNote 族）到人可读行；
 * - `duplicate` 是去重命中（消息未重发），不是投递——旧文案 "delivered via duplicate"
 *   同样失实，改为「未重发」；
 * - `wake` 保持「已发起（非送达确认）」口径——「送达」只在消费确认后才可写。
 * `note`（WakeResult.note）缺省/空串不渲染（duplicate 路径没有 note）。
 *
 * v0.9.6（V095-14/adv3-F1）：wake 分支补两态参数 `startConfirmed`（调用方可从
 * WakeResult.startConfirmed 透传）并**渲染 note**——旧实现 wake 分支丢弃 note
 * （mailbox 分支才带），「已发起但未见启动证据」与失败侦听措辞进不了文本行。
 * 三个可选参都缺省时输出与 v0.9.5 逐字节一致（旧调用方零行为变化）。
 *
 * v0.9.7（W3/V096-24）：wake 分支再补**失败第三态** `wake`（WakeReceiptState）——
 * 回执时刻已见失败证据时文本行改写失败措辞（不再写「已发起唤醒」），并保留 note 原文。
 *
 * v0.9.8（S5）：补第八个可选参 `steer`（SteerReceiptState）——steer 请求时文本行追加
 * 三态短语（⛔ 抢占成功/降级/不支持）；缺省（undefined）输出与 v0.9.7 逐字节一致
 * （旧调用方零行为变化）。
 */
export function renderMessage(
  messageId: string,
  from: string,
  to: string,
  delivered: string,
  note?: string,
  startConfirmed?: boolean,
  wake?: WakeReceiptState,
  steer?: SteerReceiptState,
): string {
  const steerPhrase = steerReceiptPhrase(steer);
  if (delivered === "mailbox") {
    const reason = note !== undefined && note.trim() !== "" ? `：${note}` : "";
    return `Message ${shortId(messageId)} ${from} → ${to} ${renderDeliveryOutcome("mailbox")}${reason}`
      + (steerPhrase !== undefined ? `；${steerPhrase}` : "") + ".";
  }
  if (delivered === "duplicate") {
    return `Message ${shortId(messageId)} ${from} → ${to} 未重发（已存在同文未读件，duplicate；pull 兜底可读）`
      + (steerPhrase !== undefined ? `；${steerPhrase}` : "") + ".";
  }
  const reason = note !== undefined && note.trim() !== "" ? `：${note}` : "";
  const failure = wakeReceiptFailurePhrase(wake);
  if (failure !== undefined) {
    return `Message ${shortId(messageId)} ${from} → ${to} ${failure}${reason}`
      + (steerPhrase !== undefined ? `；${steerPhrase}` : "") + ".";
  }
  return `Message ${shortId(messageId)} ${from} → ${to} ${renderDeliveryOutcome("wake", startConfirmed)}${reason}`
    + (steerPhrase !== undefined ? `；${steerPhrase}` : "") + ".";
}

// ---------------------------------------------------------------------------
// v0.2 全景（§7.3.1 overview v2 / snapshot.json v2）
// ---------------------------------------------------------------------------

/**
 * v2 全景的增量字段（W3 refreshSnapshot 产出的 v2 快照携带；全部可选——
 * 交叉类型与 W3 的 StatusSnapshot 定义在「字段必选/可选」两种形态下都兼容，
 * 缺省时渲染回落 v0.1.0 形态）。
 */
export interface PanoramaExtras {
  /** 队长（§3.1 team.leadKey）。 */
  leadKey?: string | null;
  /** 任务 DAG 的派生视图：任务 id → 其依赖 id 列表（§7.3.1 "dag"）。 */
  dag?: Record<string, string[]>;
  /** 引擎/配置面信息（§7.3.1 "engine"）。 */
  engine?: { wakeEnabled?: boolean; maxMembers?: number; inboundMode?: string };
  /**
   * v0.5.3（A13 修复）：任务板窗口化时的任务总数。摘要行 `tasks=` 恒显示该总数，
   * 窗口行数另列 `shown=`——此前 tasks=N 显示的是注入窗口行数（201 单显示 tasks=53），
   * 运维一眼误读任务规模；真值只能从 JSON boardTruncated.total 挖。缺省（未窗口化）
   * 时回落 tasks.length，v0.1.0 形态输出逐字符不变。
   */
  boardTotal?: number;
}

/** 成员记录的 v2 增量字段（W2 落盘的可选字段；宽容读取，缺省 = §6.5 ready/peer 语义）。 */
type MemberExtras = { state?: string; identity?: string; openTaskId?: string | null };

/** 成员供给状态 → 渲染状态（§7.3.1：working/idle/provisioning/failed/removed）。 */
function memberDisplayState(m: MemberExtras): string {
  const state = m.state ?? "ready";
  if (state === "ready" || state === "") return m.openTaskId ? "working" : "idle";
  return state;
}

/**
 * 全景检测：快照带任一 v2 全景字段即按全景渲染（运行时判定，与类型声明无关——
 * tools.ts v0.1.0 构造的快照没有这些字段，走旧渲染，行为回归锁定）。
 */
function hasPanoramaFields(snapshot: StatusSnapshot & PanoramaExtras): boolean {
  return (
    (snapshot.leadKey !== undefined && snapshot.leadKey !== null)
    || snapshot.dag !== undefined
    || snapshot.engine !== undefined
  );
}

/**
 * 摘要行 tasks= 片段（v0.5.3 A13 修复）：带 boardTotal 时显示任务总数，窗口行数
 * 另列 shown=；未带（未窗口化）时与旧行为逐字符一致。
 */
function summaryTasksPart(snapshot: StatusSnapshot & PanoramaExtras): string {
  const total = snapshot.boardTotal ?? snapshot.tasks.length;
  return total !== snapshot.tasks.length ? `tasks=${total} shown=${snapshot.tasks.length}` : `tasks=${total}`;
}

/**
 * v2 全景渲染（§7.3.1）：成员状态表（working/idle/provisioning/failed/removed，
 * lead 有 ★ 标注）+ 任务板（v0.1.0 列不变）+ DAG 一行图（`t1 ─▶ t2`）。
 * 依据只来自快照本身，不触盘。
 */
export function renderPanorama(snapshot: StatusSnapshot & PanoramaExtras): string {
  const lines: string[] = [];
  const lead = snapshot.leadKey ?? snapshot.founderKey;
  lines.push(
    `Team "${snapshot.teamId}" phase=${snapshot.phase} lead=${lead} founder=${snapshot.founderKey} `
      + `${summaryTasksPart(snapshot)} members=${snapshot.members.length}`,
  );
  if (snapshot.engine !== undefined) {
    const e = snapshot.engine;
    lines.push(
      `Engine: wake=${e.wakeEnabled === true ? "on" : "off"} maxMembers=${e.maxMembers ?? "?"} inbound=${e.inboundMode ?? "accept"}`,
    );
  }
  // 成员状态表：key(state, openTaskId, unread)；lead 加 ★。
  const memberCols = snapshot.members.map((m) => {
    const extras = m as MemberExtras;
    const unread = snapshot.unread[m.key] ?? 0;
    const mark = m.key === lead ? "★" : "";
    const state = memberDisplayState(extras);
    const open = extras.openTaskId ? `,${extras.openTaskId}` : "";
    const unreadPart = unread > 0 ? `,${unread}unread` : "";
    return `${mark}${m.key}(${state}${open}${unreadPart})`;
  });
  lines.push(`Members: ${memberCols.join(" ") || "(none)"}`);
  // DAG 一行图：上游 ─▶ 下游（边来自 dag 派生视图，缺省从 tasks[].dependsOn 推）。
  const edges = dagEdges(snapshot);
  lines.push(`DAG: ${edges.length > 0 ? edges.join("  ") : "(none)"}`);
  lines.push(renderTaskTable(snapshot));
  return lines.join("\n");
}

/** DAG 边（上游 ─▶ 下游）：优先用快照的 dag 派生视图，否则从 tasks[].dependsOn 推导。 */
function dagEdges(snapshot: StatusSnapshot & PanoramaExtras): string[] {
  const edges: string[] = [];
  if (snapshot.dag !== undefined) {
    for (const [taskId, deps] of Object.entries(snapshot.dag)) {
      for (const dep of deps) edges.push(`${dep} ─▶ ${taskId}`);
    }
    edges.sort();
    return edges;
  }
  for (const t of snapshot.tasks) {
    for (const dep of t.dependsOn) edges.push(`${dep} ─▶ ${t.id}`);
  }
  return edges;
}

// ---------------------------------------------------------------------------
// 任务板（列布局自 v0.1.0 演进：STATUS/ASSIGNEE/ATT/TITLE 沿用原列序与宽度；
//   ID 与 RESULT/ERROR 两列按 v0.7.2 C9-B1/C9-B2 修复调整——25-能力反向检验）：
// - **ID 列加宽到 14**（`<8hex>-t<N>` 全形，如 `755d9697-t12`）。此前固定 6 字符，
//   同一波派发的任务共享 8hex 时间前缀、区分用的 `-t<N>` 后缀正好被切掉——文本面
//   三行全同形，而 journal 路径 / xc_read(journal) / xc_claim 都要用被切掉的 taskId。
//   超宽（seq 位数很多）时按**保尾**截断（`…<尾部>`），区分后缀永远可见。
// - **RESULT/ERROR 列取消固定 24 字符截断**：C9 承诺「看到板面指针即算落盘」，
//   journal 路径（`.crosschat/tasks/<taskId>/journal.md`）此前在文本面被切成
//   `…；journal…`，路径本体不可见。行宽改由注入预算窗口统一兜底（xc_overview 的
//   boardCosts 已按人可读行长度记账，超预算自然分页 + boardTruncated 指针），
//   JSON 面本就全量、不受影响。
// ---------------------------------------------------------------------------

const COL = { id: 14, status: 11, assignee: 10, att: 11 };

function pad(text: string, width: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= width ? oneLine.padEnd(width, " ") : `${oneLine.slice(0, width - 1)}…`;
}

/** ID 列专用：超宽时保尾截断（`…<尾部>`）——时间前缀可省，`-t<N>` 区分后缀不可省。 */
function padId(text: string, width: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= width ? oneLine.padEnd(width, " ") : `…${oneLine.slice(oneLine.length - (width - 1))}`;
}

/** 任务板表头行（renderTaskTable 用；预算窗口的固定面记账同款，避免两处字面量漂移）。 */
export const STATUS_TASK_TABLE_HEADER =
  `${"ID".padEnd(COL.id)}  ${"STATUS".padEnd(COL.status)}  ${"ASSIGNEE".padEnd(COL.assignee)}  `
  + `${"ATT".padEnd(COL.att)}  RESULT/ERROR  TITLE`;

/**
 * 单条任务的人可读板面行（renderTaskTable 逐行同款）。
 * v0.5.2（SCALE-1 修复）导出：xc_overview 的板面注入预算窗口要按「人可读行 + JSON
 * 条目」的联合成本估窗（与 xc_read inbox 的 inboxEntry 成本口径一致），此处是
 * 人可读面成本的单一事实源。
 */
export function statusTaskRowText(task: StatusSnapshotTask): string {
  const att = `${task.attempt}@${task.attemptId ? shortId(task.attemptId) : "-"}`;
  const outcome = task.error ? `ERR: ${task.error}` : (task.result ?? "");
  // v0.7.2（C9-B1）：RESULT/ERROR 不截断——journal 指针必须在文本面可定位；
  // 仍折叠为单行（多行 result 不破坏板面一行一任务的形态）。
  const outcomeOneLine = outcome.replace(/\s+/g, " ").trim();
  return (
    `${padId(task.id, COL.id)}  ${pad(task.status, COL.status)}  ${pad(task.assignee ?? "-", COL.assignee)}  `
    + `${pad(att, COL.att)}  ${outcomeOneLine}  ${task.title}`
  );
}

function renderTaskTable(snapshot: StatusSnapshot): string {
  const lines: string[] = [];
  if (snapshot.tasks.length === 0) {
    lines.push("Tasks: (none)");
    return lines.join("\n");
  }
  lines.push(STATUS_TASK_TABLE_HEADER);
  for (const t of snapshot.tasks) {
    lines.push(statusTaskRowText(t));
  }
  return lines.join("\n");
}

/**
 * 任务板截断指针行（v0.5.2 SCALE-1 修复）。
 * 板面按注入预算开窗口后，窗口外的任务不进本响应——人可读面给这一行，payload 面给
 * `boardTruncated{shown,total,offset,budgetChars}`；`snapshot.json` 落盘的仍是全量
 * （磁盘真源不受预算约束，R-21）。
 */
export function renderBoardTruncationNote(shown: number, total: number, budgetChars: number): string {
  return (
    `[任务板已按注入预算（${budgetChars} 字符）截断：本页 ${shown}/${total} 条；`
    + `其余任务用 xc_overview({offset:${shown}}) 分页读，snapshot.json 仍含全量]`
  );
}

/** 截断指针行的字符上限（窗口预算的固定面预留量；数字位数已含余量）。 */
export const BOARD_TRUNCATION_NOTE_MAX_CHARS = 220;

/**
 * xc_overview 的人可读任务板（v0.1.0 输出形态原样保留，DESIGN §4.2）；
 * 快照带 v2 全景字段（leadKey/dag/engine）时升级为全景渲染（§7.3.1，W4）。
 */
export function renderStatusTable(snapshot: StatusSnapshot & PanoramaExtras): string {
  if (hasPanoramaFields(snapshot)) return renderPanorama(snapshot);
  const lines: string[] = [];
  lines.push(`Team "${snapshot.teamId}" phase=${snapshot.phase} founder=${snapshot.founderKey} ${summaryTasksPart(snapshot)}`);
  const memberCols = snapshot.members.map((m) => unreadText(snapshot, m.key)).join(" ");
  lines.push(`Members: ${memberCols || "(none)"}`);
  // v0.5.1（故障注-2 修复）：孤儿任务引用告警行——邮箱信封指向不存在的任务，
  // 说明真源任务段丢失（被清空/截断/整队重置）。仅在非空时出现（回归锁定不变）。
  const orphanTasks = snapshot.orphanTasks;
  if (orphanTasks !== undefined && Object.keys(orphanTasks).length > 0) {
    const parts = Object.entries(orphanTasks).map(([key, ids]) => `${key}: ${ids.join(", ")}`);
    lines.push(`WARNING orphan task references (envelopes point to tasks missing from team.json): ${parts.join("; ")}`);
  }
  lines.push(renderTaskTable(snapshot));
  return lines.join("\n");
}

function unreadText(snapshot: StatusSnapshot, key: string): string {
  const n = snapshot.unread[key] ?? 0;
  return n > 0 ? `${key}:${n}unread` : key;
}

/**
 * xc_overview 快照落盘（DESIGN §2.8：人可读观测面 snapshot.json；§4.3 观测点之一）。
 * 整文件 → 走 M1 的 Windows 原子写（写临时文件 → rename，EPERM/EACCES/EBUSY 重试）；
 * writeFileAtomic 不建父目录（M1 各调用方均先 mkdir），团队未建时此处自建。
 */
export async function writeSnapshot(stateRoot: string, teamId: string, snapshot: StatusSnapshot): Promise<void> {
  const file = snapshotFile(stateRoot, teamId);
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, JSON.stringify(snapshot, null, 2));
}
