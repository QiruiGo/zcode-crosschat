/**
 * M3 render：工具的人可读输出（一行摘要沿用 dsh tools.js render 思路）与
 * xc_status 快照落盘（DESIGN.md §2.8、§4.3）。
 *
 * 依赖纪律：对 M1 只 import writeFileAtomic（atomic.ts，Windows 原子写 §2.7-6）
 * 与 snapshotFile（paths.ts）。纯渲染函数不碰盘、可独立单测。
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileAtomic } from "../core/atomic.js";
import { snapshotFile } from "../core/paths.js";

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

export function renderInbox(consumed: number, discarded: number, unread: number): string {
  return `Inbox: ${consumed} message(s) consumed, ${discarded} stale discarded, ${unread} unread remain.`;
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

export interface StatusSnapshotTask {
  id: string;
  title: string;
  status: string;
  assignee: string | null;
  attempt: number;
  attemptId: string | null;
  dependsOn: string[];
  createdBy: string;
  result: string | null;
  error: string | null;
  evidenceCount: number;
  updatedAt: number;
}

export interface StatusSnapshot {
  teamId: string;
  generatedAt: number;
  phase: string;
  founderKey: string;
  members: Array<{ key: string; sessionId: string; role: string; lastSeen: number }>;
  tasks: StatusSnapshotTask[];
  unread: Record<string, number>;
  me?: { agentKey: string; unread: number };
}

const COL = { id: 6, status: 11, assignee: 10, att: 11, result: 24 };

function pad(text: string, width: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= width ? oneLine.padEnd(width, " ") : `${oneLine.slice(0, width - 1)}…`;
}

/** xc_status 的人可读任务板（六态 + 认领人 + attempt 代数 + 未读数，DESIGN §4.2）。 */
export function renderStatusTable(snapshot: StatusSnapshot): string {
  const lines: string[] = [];
  lines.push(`Team "${snapshot.teamId}" phase=${snapshot.phase} founder=${snapshot.founderKey} tasks=${snapshot.tasks.length}`);
  const memberCols = snapshot.members.map((m) => unreadText(snapshot, m.key)).join(" ");
  lines.push(`Members: ${memberCols || "(none)"}`);
  if (snapshot.tasks.length === 0) {
    lines.push("Tasks: (none)");
    return lines.join("\n");
  }
  lines.push(
    `${"ID".padEnd(COL.id)}  ${"STATUS".padEnd(COL.status)}  ${"ASSIGNEE".padEnd(COL.assignee)}  ` +
      `${"ATT".padEnd(COL.att)}  ${"RESULT/ERROR".padEnd(COL.result)}  TITLE`,
  );
  for (const t of snapshot.tasks) {
    const att = `${t.attempt}@${t.attemptId ? shortId(t.attemptId) : "-"}`;
    const outcome = t.error ? `ERR: ${t.error}` : (t.result ?? "");
    lines.push(
      `${pad(t.id, COL.id)}  ${pad(t.status, COL.status)}  ${pad(t.assignee ?? "-", COL.assignee)}  ` +
        `${pad(att, COL.att)}  ${pad(outcome, COL.result)}  ${t.title}`,
    );
  }
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
