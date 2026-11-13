/**
 * M3/W4 render：工具的人可读输出（一行摘要沿用 dsh tools.js render 思路）、
 * xc_status 任务板与 v0.2 全景渲染（DESIGN.md §2.8/§4.3；DESIGN-V0.2.md §7.3.1）。
 *
 * v0.2（W4 改动边界，DESIGN-V0.2 §9.1）：
 * - StatusSnapshot/StatusSnapshotTask 类型改从 core/snapshot.ts 导入（W3 承载，
 *   「自 render.ts 迁入」）；此处 re-export 保持 v0.1.0 消费方（tools.ts 的
 *   `import type { StatusSnapshot } from "./render.js"`）不动。
 * - 新增 renderPanorama：v2 全景渲染 = 成员状态表（working/idle/provisioning/
 *   failed/removed，含 lead 标注）+ 任务板 + DAG 一行图（`t1 ─▶ t2`）。
 * - renderStatusTable 升级为双形态：快照带全景字段（leadKey/dag/engine，W3
 *   refreshSnapshot 的 v2 形状）→ 全景渲染；v0.1.0 形状（tools.ts xc_status 构造）
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

export function renderDispatch(taskId: string, to: string, delivered: string): string {
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

export function renderReport(taskId: string, status: string, receiptTo: string | null, wakeBack: string): string {
  const to = receiptTo ? `receipt sent to ${receiptTo}` : "no receipt (non-terminal)";
  return `Task ${taskId} ${status}; ${to}; wake back via ${wakeBack}.`;
}

export function renderMessage(messageId: string, from: string, to: string, delivered: string): string {
  return `Message ${shortId(messageId)} ${from} → ${to} delivered via ${delivered}.`;
}

// ---------------------------------------------------------------------------
// v0.2 全景（§7.3.1 xc_status v2 / snapshot.json v2）
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
 * v2 全景渲染（§7.3.1）：成员状态表（working/idle/provisioning/failed/removed，
 * lead 有 ★ 标注）+ 任务板（v0.1.0 列不变）+ DAG 一行图（`t1 ─▶ t2`）。
 * 依据只来自快照本身，不触盘。
 */
export function renderPanorama(snapshot: StatusSnapshot & PanoramaExtras): string {
  const lines: string[] = [];
  const lead = snapshot.leadKey ?? snapshot.founderKey;
  lines.push(
    `Team "${snapshot.teamId}" phase=${snapshot.phase} lead=${lead} founder=${snapshot.founderKey} `
      + `tasks=${snapshot.tasks.length} members=${snapshot.members.length}`,
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
// 任务板（v0.1.0 列形态原样保留；renderStatusTable/renderPanorama 共用）
// ---------------------------------------------------------------------------

const COL = { id: 6, status: 11, assignee: 10, att: 11, result: 24 };

function pad(text: string, width: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= width ? oneLine.padEnd(width, " ") : `${oneLine.slice(0, width - 1)}…`;
}

/** 任务板表头行（renderTaskTable 用；预算窗口的固定面记账同款，避免两处字面量漂移）。 */
export const STATUS_TASK_TABLE_HEADER =
  `${"ID".padEnd(COL.id)}  ${"STATUS".padEnd(COL.status)}  ${"ASSIGNEE".padEnd(COL.assignee)}  `
  + `${"ATT".padEnd(COL.att)}  ${"RESULT/ERROR".padEnd(COL.result)}  TITLE`;

/**
 * 单条任务的人可读板面行（renderTaskTable 逐行同款）。
 * v0.5.2（SCALE-1 修复）导出：xc_status 的板面注入预算窗口要按「人可读行 + JSON
 * 条目」的联合成本估窗（与 xc_check_inbox 的 inboxEntry 成本口径一致），此处是
 * 人可读面成本的单一事实源。
 */
export function statusTaskRowText(task: StatusSnapshotTask): string {
  const att = `${task.attempt}@${task.attemptId ? shortId(task.attemptId) : "-"}`;
  const outcome = task.error ? `ERR: ${task.error}` : (task.result ?? "");
  return (
    `${pad(task.id, COL.id)}  ${pad(task.status, COL.status)}  ${pad(task.assignee ?? "-", COL.assignee)}  `
    + `${pad(att, COL.att)}  ${pad(outcome, COL.result)}  ${task.title}`
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
    + `其余任务用 xc_status({offset:${shown}}) 分页读，snapshot.json 仍含全量]`
  );
}

/** 截断指针行的字符上限（窗口预算的固定面预留量；数字位数已含余量）。 */
export const BOARD_TRUNCATION_NOTE_MAX_CHARS = 220;

/**
 * xc_status 的人可读任务板（v0.1.0 输出形态原样保留，DESIGN §4.2）；
 * 快照带 v2 全景字段（leadKey/dag/engine）时升级为全景渲染（§7.3.1，W4）。
 */
export function renderStatusTable(snapshot: StatusSnapshot & PanoramaExtras): string {
  if (hasPanoramaFields(snapshot)) return renderPanorama(snapshot);
  const lines: string[] = [];
  lines.push(`Team "${snapshot.teamId}" phase=${snapshot.phase} founder=${snapshot.founderKey} tasks=${snapshot.tasks.length}`);
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
 * xc_status 快照落盘（DESIGN §2.8：人可读观测面 snapshot.json；§4.3 观测点之一）。
 * 整文件 → 走 M1 的 Windows 原子写（写临时文件 → rename，EPERM/EACCES/EBUSY 重试）；
 * writeFileAtomic 不建父目录（M1 各调用方均先 mkdir），团队未建时此处自建。
 */
export async function writeSnapshot(stateRoot: string, teamId: string, snapshot: StatusSnapshot): Promise<void> {
  const file = snapshotFile(stateRoot, teamId);
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, JSON.stringify(snapshot, null, 2));
}
