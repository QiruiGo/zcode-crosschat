/**
 * W3 task-flow —— 观测快照（snapshot.json）的承载模块（DESIGN-V0.2.md §7.3.1，
 * 文件所有权表 §9.1「自 render.ts 迁入，W3 承载」）。
 *
 * 为什么归 W3：W3 的边沿包装（withTaskEdges）与 W4 的 Stop 钩子/lead 工具都要在
 * 「任务图真实变化后」刷新快照——把它放在两者的公共下游（W4→W3 是既有依赖方向）
 * 避免 W3↔W4 环（§7.3.1 落地段、§9.1 依赖方向）。
 *
 * 依赖纪律（§7.3.1 落地段）：**只 import M1**（core/*）——遵守 DESIGN.md §8.1
 * rule 1「M4 hooks → 仅 M1」：Stop 钩子（hooks/stop.ts）经本模块刷新快照时，
 * 本模块不得把 engine/mcp 拖进钩子的依赖面。XC_* env 的读取是进程环境访问而非
 * 模块依赖，V7/V18 防御语义与 engine/wake.ts 的 isWakeEnabled、resume-cli 的
 * wakeSpawnConfigFromEnv 保持同口径（就地实现，注释标明唯一定义处的语义来源）。
 *
 * schema 兼容（§11.1「schema 只增可选字段」）：v2 新字段（leadKey / members[].state,
 * identity, openTaskId / tasks[].blockedBy / dag / engine）全部**可选**——
 * tools.ts 的 xc_status（v0.1.0 字面量，W6 不改）构造的快照仍可赋值给本类型；
 * render.ts（W4）自本文件 re-export 类型。W2 落盘的成员 state/identity 以宽容
 * 读取消费（缺省 = §6.5 的 ready/self 语义，与 W2 访问器 memberState/memberIdentity
 * 的语义一致；本地副本避免对并行模块的编译依赖，字段唯一定义处仍是 core/types.ts）。
 *
 * 刷新机制（§7.3.1「无定时器」）：本模块只提供事件粒度的 refreshSnapshot——
 * 1. 事件粒度：W3 withTaskEdges 每次边沿动作（清扫/unblock/派发/report）后调用；
 * 2. 回合粒度：W4 Stop 钩子在会话收尾时调用（含 lead）；
 * 3. 无空闲轮询定时器（D0：无守护进程）。
 *
 * @module core/snapshot
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { snapshotFile } from "./paths.js";
import { readMailbox, isCurrentMail } from "./mailbox.js";
import { logEngineEvent } from "./log.js";
import { memberOpenTasks, readTeam, unsatisfiedDependencies } from "./teamstate.js";
import { DEFAULT_TEAM_ID, type TeamState } from "./types.js";

// ---------------------------------------------------------------------------
// 快照类型（v0.1.0 render.ts 的形状 + §7.3.1 的 v2 可选增量）
// ---------------------------------------------------------------------------

/** 快照里的单任务行（v0.1.0 字段 + v2 派生视图 blockedBy）。 */
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
  /** v2 派生视图：当前未满足（缺失或未 completed）的依赖 id（快照时算，§7.3.1）。 */
  blockedBy?: string[];
}

/** 快照里的单成员行（v0.1.0 字段 + v2 的 state/identity/openTaskId，全可选）。 */
export interface StatusSnapshotMember {
  key: string;
  sessionId: string;
  role: string;
  lastSeen: number;
  /** v2：供给/生命周期状态（W2 落盘；缺省 "ready" = §6.5 旧数据兼容语义）。 */
  state?: string;
  /** v2：身份来源（"engine" 引擎建会话 / "self" 自注册；缺省 "self"）。 */
  identity?: string;
  /** v2：该成员当前开放（claimed/in_progress）任务 id，无则 null。 */
  openTaskId?: string | null;
}

/** xc_status / snapshot.json 的结构化快照（DESIGN.md §2.8 + DESIGN-V0.2.md §7.3.1）。 */
export interface StatusSnapshot {
  teamId: string;
  generatedAt: number;
  phase: string;
  founderKey: string;
  /** v2：队长（§3.1 team.leadKey；W2 落盘的可选字段，未设置时省略）。 */
  leadKey?: string | null;
  members: StatusSnapshotMember[];
  tasks: StatusSnapshotTask[];
  unread: Record<string, number>;
  me?: { agentKey: string; unread: number };
  /** v2 派生视图：任务 id → 其依赖 id 列表（仅含有依赖的任务，§7.3.1 "dag"）。 */
  dag?: Record<string, string[]>;
  /** v2：引擎/配置面信息（§7.3.1 "engine"）。 */
  engine?: { wakeEnabled: boolean; maxMembers: number; inboundMode: string };
}

// ---------------------------------------------------------------------------
// env 防御解析（V7 / V18 同口径；语义唯一定义处在 engine/wake.ts 与 plugin.json）
// ---------------------------------------------------------------------------

/** max_members 缺省（plugin.json userConfig max_members.default，§10.1）。 */
export const DEFAULT_MAX_MEMBERS = 8;
/** stale_task_minutes 缺省（plugin.json userConfig stale_task_minutes.default，§5.4）。 */
export const DEFAULT_STALE_TASK_MINUTES = 30;

const INBOUND_MODES: readonly string[] = ["accept", "hold", "refuse"];

/**
 * XC_WAKE_ENABLED 严格判定：非 "true" 一律按关（V7；与 engine/wake.ts isWakeEnabled
 * 同语义的就地副本——本模块只 import M1，不引 engine）。
 */
export function wakeEnabledFromEnv(env: NodeJS.ProcessEnv): boolean {
  return env["XC_WAKE_ENABLED"] === "true";
}

/** XC_MAX_MEMBERS 防御解析：非有限正整数取默认值（V18，resume-cli.ts 同款防御）。 */
export function maxMembersFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env["XC_MAX_MEMBERS"];
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_MAX_MEMBERS;
}

/** XC_INBOUND_MODE 防御解析：非 accept/hold/refuse 的一切值取 accept（默认策略）。 */
export function inboundModeFromEnv(env: NodeJS.ProcessEnv): string {
  const raw = env["XC_INBOUND_MODE"];
  return typeof raw === "string" && INBOUND_MODES.includes(raw) ? raw : "accept";
}

// ---------------------------------------------------------------------------
// 快照构建（纯数据组装；邮箱未读计数触盘读）
// ---------------------------------------------------------------------------

/** 未读计数：未读 ∧ 未丢弃 ∧ isCurrentMail（与 tools.ts countUnread 同语义的 M1 复算）。 */
function countUnread(team: TeamState, messages: Awaited<ReturnType<typeof readMailbox>>): number {
  return messages.filter((m) => !m.readAt && !m.discardedAt && isCurrentMail(team, m)).length;
}

/**
 * 从团队真源构建一版 v2 快照（不落盘）。member state/identity/openTaskId、leadKey
 * 为 W2 落盘的可选字段：宽容读取 + §6.5 缺省语义（W2 落盘前后两种形态都正确）。
 */
export async function buildSnapshot(
  stateRoot: string,
  team: TeamState,
  options: { now?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<StatusSnapshot> {
  const now = options.now ?? Date.now();
  const env = options.env ?? process.env;

  const members = team.members.map((m) => {
    // W2 可选字段宽容读取（§6.5：m.state ?? "ready"、m.identity ?? "self"）。
    const record = m as { state?: string; identity?: string };
    const open = memberOpenTasks(team.tasks, m.key)[0];
    return {
      key: m.key,
      sessionId: m.sessionId,
      role: m.role,
      lastSeen: m.lastSeen,
      ...(record.state !== undefined ? { state: record.state } : {}),
      ...(record.identity !== undefined ? { identity: record.identity } : {}),
      openTaskId: open?.id ?? null,
    };
  });

  const tasks = team.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    assignee: t.assignee,
    attempt: t.attempt,
    attemptId: t.attemptId,
    dependsOn: [...t.dependsOn],
    createdBy: t.createdBy,
    result: t.result,
    error: t.error,
    evidenceCount: t.evidence.length,
    updatedAt: t.updatedAt,
    blockedBy: unsatisfiedDependencies(team.tasks, t.dependsOn),
  }));

  // dag 派生视图：仅含有依赖的任务（§7.3.1 示例 {"t2":["t1"]}——无依赖的 t1 不入图）。
  const dag: Record<string, string[]> = {};
  for (const t of team.tasks) {
    if (t.dependsOn.length > 0) dag[t.id] = [...t.dependsOn];
  }

  // 未读计数（读路径无锁，§2.7-5 rename 原子写保证读者看到完整文件）。
  const unread: Record<string, number> = {};
  for (const m of team.members) {
    const msgs = await readMailbox(stateRoot, team.teamId, m.key);
    unread[m.key] = countUnread(team, msgs);
  }

  const leadKey = (team as { leadKey?: string }).leadKey;
  return {
    teamId: team.teamId,
    generatedAt: now,
    phase: team.phase,
    founderKey: team.founderKey,
    ...(leadKey !== undefined ? { leadKey } : {}),
    members,
    tasks,
    unread,
    ...(Object.keys(dag).length > 0 ? { dag } : {}),
    engine: {
      wakeEnabled: wakeEnabledFromEnv(env),
      maxMembers: maxMembersFromEnv(env),
      inboundMode: inboundModeFromEnv(env),
    },
  };
}

// ---------------------------------------------------------------------------
// 刷新（build + 原子写；错误向上抛——调用方各自 best-effort 降级）
// ---------------------------------------------------------------------------

/**
 * 重建并落盘一版 snapshot.json（§7.3.1）。团队不存在（team.json 未建）→ 静默跳过
 * （无可观测对象；空队快照由 v0.1.0 的 xc_status 路径负责）。
 *
 * **错误向上抛**：本函数不做内部吞错——Stop 钩子（hooks/stop.ts）以 auditHookFailure
 * 兜底、lead 工具以 refreshSnapshotBestEffort 包裹、W3 边沿包装以 try/catch + 审计
 * 包裹（各调用方决定降级方式；观测面失败永不影响业务结果）。
 */
export async function refreshSnapshot(stateRoot: string, teamId: string = DEFAULT_TEAM_ID): Promise<void> {
  const team = await readTeam(stateRoot, teamId);
  if (team === undefined) return;
  const snapshot = await buildSnapshot(stateRoot, team);
  const file = snapshotFile(stateRoot, teamId);
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, JSON.stringify(snapshot, null, 2));
  await logEngineEvent(stateRoot, {
    event: "snapshot-refresh",
    teamId,
    generatedAt: snapshot.generatedAt,
    tasks: snapshot.tasks.length,
    members: snapshot.members.length,
  });
}
