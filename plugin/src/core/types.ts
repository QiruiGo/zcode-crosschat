/**
 * M1 core-store: protocol types + durable-boundary validation.
 *
 * This module is the SINGLE definition point for every persisted field name
 * and enum value (DESIGN.md §8.1 rule 3): team.json / message JSONL / session
 * records / wake nonces. Other modules must import from here, never re-declare.
 *
 * Task state machine is a 1:1 port of dsh TASK_TRANSITIONS
 * (dsh-agent-teams-0.1.29/lib/state.js:114-123), including the
 * pending -> cancelled edge that has no v1 tool entry (kept for v1.5
 * halt/reassign; DESIGN.md §2.6).
 *
 * Pure types + validators only: no filesystem, no engine, no MCP imports.
 * @module core/types
 */

/**
 * Task machine statuses (DESIGN.md §2.6).
 * v0.6（C2，DESIGN-V0.6.md §3.2）：扩为七态——`blocked` 是「认领者显式申报的暂停」：
 * 唯一入口 = 认领者 xc_report(status:"blocked", error=阻塞原因必填)（attempt 保留）；
 * 退出 = xc_team unblock（回 preBlockedStatus）/ 认领者自解 report(in_progress) / cancel。
 */
export const TASK_STATUSES = [
  'pending',
  'claimed',
  'in_progress',
  'blocked',
  'completed',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Terminal statuses have no outgoing transitions. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  'completed',
  'failed',
  'cancelled',
];

/**
 * Statuses that count as "open work" for the one-open-task-per-member rule and
 * for revokeAttempt's revocable domain.
 * v0.6（C2）：blocked 在内——暂停的任务仍占用成员的单开槽位（不可他领：status 非
 * pending，claim 天然拒绝），unblock 复位后不破坏单开不变量；成员 stop / 接管
 * （T1 #5）经 revokeAttempt 把 blocked 任务一并回池。
 */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['claimed', 'in_progress', 'blocked'];

/**
 * v0.6（C2）：僵尸清扫的候选口径——**必须比 OPEN 窄**（DESIGN-V0.6.md §3.2）。
 * blocked 被 staleTasks/graph.staleTasks 过滤式排除：合法暂停的任务不得在
 * XC_STALE_TASK_MINUTES 后被 sweeper 误回收（blocked 有属主、attempt 保留、滞留确定）。
 */
export const SWEEPABLE_TASK_STATUSES: readonly TaskStatus[] = ['claimed', 'in_progress'];

/**
 * v0.6（C2）：任务优先级枚举（排序建议，非抢占——claim 仍是显式 taskId）。
 * absent = normal（旧记录兼容，priorityRank 归一）。
 */
export const TASK_PRIORITIES = ['high', 'normal', 'low'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** priority → 展示/取单序的秩（小者在前；absent 由 priorityRank 归一为 normal）。 */
export const TASK_PRIORITY_RANK: Readonly<Record<TaskPriority, number>> = {
  high: 0,
  normal: 1,
  low: 2,
};

/**
 * The allowed task status transitions, keyed by current status.
 * Port of state.js:115-122, all edges preserved verbatim.
 * v0.6（C2，DESIGN-V0.6.md §3.2 转移表）：
 * - pending **不**列 blocked（L-n3：blocked 唯一入口是认领者 report——需 attempt，
 *   pending 无 attempt 无认领者，该边不可达，删除而非保留死配置）。
 * - claimed/in_progress → blocked：认领者 xc_report(status:"blocked") 显式申报。
 * - blocked → pending 仅作 unblock 兜底的防御边（preBlockedStatus 缺失时回池）；
 *   正常解除回到 preBlockedStatus ∈ {claimed, in_progress}。
 * - blocked → failed 故意无此边：阻塞中放弃先自解（report in_progress）再 failed，
 *   或由 lead/创建者 cancel（blocked → cancelled 合法）。
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['claimed', 'cancelled'],
  claimed: ['in_progress', 'blocked', 'failed', 'cancelled'],
  in_progress: ['completed', 'blocked', 'failed', 'cancelled'],
  blocked: ['pending', 'claimed', 'in_progress', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

/**
 * Validate one task status transition.
 * @returns the transition error message, or `undefined` when allowed.
 * Port of state.js:129-136.
 */
export function transitionError(current: TaskStatus, next: TaskStatus): string | undefined {
  if (current === next) return undefined;
  if (!TASK_TRANSITIONS[current].includes(next)) {
    return `task status cannot move from "${current}" to "${next}"`;
  }
  return undefined;
}

/** Team lifecycle phase. `halted` is reserved for v1.5 (no v1 tool toggles it). */
export const TEAM_PHASES = ['open', 'halted'] as const;
export type TeamPhase = (typeof TEAM_PHASES)[number];

/** Member roles: `peer` (interactive equal session) or `worker` (headless executor). */
export const MEMBER_ROLES = ['peer', 'worker'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/**
 * v0.2 member lifecycle states (DESIGN-V0.2.md §3.3). Optional on the record:
 * a member without `state` is a v0.1.0 legacy peer and reads as `ready`
 * (memberState accessor, DESIGN-V0.2.md §6.5).
 */
export const MEMBER_STATES = ['provisioning', 'ready', 'failed', 'removed'] as const;
export type MemberState = (typeof MEMBER_STATES)[number];

/**
 * v0.2 member identity kinds (DESIGN-V0.2.md §3.1). Optional on the record:
 * absent = v0.1.0 self-registered peer (`self`).
 */
export const MEMBER_IDENTITIES = ['self', 'engine'] as const;
export type MemberIdentity = (typeof MEMBER_IDENTITIES)[number];

/**
 * Reserved member keys (DESIGN-V0.2.md §3.1, CC 保留名纪律等效移植): the lead
 * role name, the default team name, and the peer-axis addressing reserved set
 * (core/peeraddr.ts PEER_RESERVED_NAMES — keep the two lists in sync).
 * xc_member_add / xc_register / peer 注册与改名共用本表拒绝。
 *
 * v0.6.1（红队四番战 安全对-5 修复）：两轴保留名合一——此前队内轴只保留
 * lead/default，system/user/main/team-lead 可注册进队内花名册（peer 轴早已
 * 拒），同一花名两轴策略不一致构成注册旁路（adjudication.md 安全对-5）。
 */
export const RESERVED_MEMBER_KEYS: readonly string[] = [
  'lead',
  'default',
  'main',
  'team-lead',
  'user',
  'system',
];

/** v1 keeps exactly one team (DESIGN.md §2.2); the schema stays multi-team-ready. */
export const DEFAULT_TEAM_ID = 'default';

/** One evidence entry attached to a completion report (DESIGN.md §2.8). */
export interface EvidenceItem {
  /** Evidence file path as supplied by the caller (resolved by the gate). */
  path: string;
  /**
   * sha256 hex digest computed by the tool layer over the file content.
   * v0.7.1（边界-7）：v0.6 的「恒 null」已回退——现算值一律落库，调用方声明的
   * 值与现算值不符时整单拒绝（`evidence_checksum_mismatch`）。
   */
  sha256: string | null;
  /**
   * Human-readable note (optional on input; `""` when omitted).
   * v0.7.1（边界-8）：控制字符入库前已清洗为空格，长度钳制在 500 字符内。
   */
  note: string;
}

/** One history entry appended on every accepted task transition (DESIGN.md §2.6). */
export interface TaskHistoryEntry {
  ts: number;
  event: string;
  by: string;
  attemptId?: string;
}

/** One task record inside team.json (DESIGN.md §2.6 TeamState). */
export interface Task {
  id: string;
  title: string;
  prompt: string;
  acceptance?: string;
  dependsOn: string[];
  status: TaskStatus;
  /** Sanitized member key, or `null` while unassigned. */
  assignee: string | null;
  /** Attempt generation counter; 0 until the first claim. */
  attempt: number;
  /** Capability token of the current attempt, or `null` when none is open. */
  attemptId: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /**
   * v0.7.2（红队五番战 C8-B2 修复）：**落盘**的最后进展时刻（epoch ms）——
   * PROTOCOL §12.1 的 `task.lastProgressTs`。每个进展点（建单/认领/状态转移/
   * blocked/unblock/引擎回池）随 appendTaskHistory 同步刷新，与 history 末条
   * ts 同值（冗余镜像，供观测面直读，不必走 history 回溯）。
   * absent = v0.7.2 之前的存量记录：读取方按 history 末条推导（stall.ts
   * lastProgressTs 的兜底口径），行为不变。
   */
  lastProgressTs?: number;
  /**
   * v0.9.1（V090-05 r2）：上次 C8 离线转交通知的时刻（epoch ms）——**活性豁免**的
   * 任务不被清扫、会跨清扫节拍持续命中 idle-timeout，本字段是 lead 通知的持久闸
   * （阈值窗口内不重复通知）。absent = 从未通知。引擎特有字段，外部写入经
   * plausibleLivenessTs 未来值校验（压制通知的伪造在读盘即失效）。
   */
  offlineNoticeAt?: number;
  result: string | null;
  error: string | null;
  evidence: EvidenceItem[];
  history: TaskHistoryEntry[];
  /**
   * v0.6（C2）：排序建议优先级；absent = normal（旧记录兼容，priorityRank 归一）。
   * 影响展示/取单顺序，不做抢占（DESIGN-V0.6.md §3.2）。
   */
  priority?: TaskPriority;
  /** v0.6（C2）：status=blocked 必有——阻塞原因（report error 原文）。解除后保留作历史痕迹。 */
  blockedReason?: string;
  /** v0.6（C2）：进入 blocked 的时刻（epoch ms）。 */
  blockedAt?: number;
  /** v0.6（C2）：解除目标态（进入 blocked 前的 status）；unblock 校验 ∈ OPEN_TASK_STATUSES。 */
  preBlockedStatus?: TaskStatus;
  /**
   * v0.6.1（红队四番战 安全对-3 修复）：派发时指定的受领成员（sanitized key，
   * = xc_dispatch 的 to）。xc_claim 只允许受领人本人认领（与 xc_report 的
   * not_assignee 硬闸对齐），防他人抢认 fresh pending 任务锁死正主。
   * 引擎特权重置（清扫/停止/接管回池，graph.revokeAttempt）**清除**本字段——
   * 回池即共享待领池（红队旧案「他人领不走」解除不回退；原受领人回来也可 reclaim）。
   * absent = 旧记录（v0.6.1 之前落盘）或已回池任务，无受领人信息，认领面兼容开放。
   */
  to?: string;
}

/**
 * One team member (independent peer session; DESIGN.md §2.6/§3).
 * v0.2 optional fields (DESIGN-V0.2.md §9.1, W2): `state`/`identity`/
 * `provisionedAt`/`stopReason` — all absent on v0.1.0 records, which the
 * accessors below map to the legacy peer semantics (§6.5). `error` carries the
 * last provisioning failure of a `failed` member (§3.3 「错误进记录」/§6.1 step 5).
 */
export interface TeamMember {
  key: string;
  sessionId: string;
  role: MemberRole;
  joinedAt: number;
  lastSeen: number;
  /** Lifecycle state; absent = legacy peer (= ready). */
  state?: MemberState;
  /** Who created this member; absent = self-registered peer. */
  identity?: MemberIdentity;
  /** Provisioning bookkeeping timestamp (start of the current supply / last success). */
  provisionedAt?: number;
  /**
   * v0.7.1（红队四番战 故障注-1 修复）：provisioning 尝试的**落盘 deadline**
   * （epoch ms；= provisionedAt + XC_MEMBER_BOOTSTRAP_TIMEOUT_MS + 宽限）。
   * 缺失 = v0.7.1 之前的存量记录，清扫方按 provisionedAt/joinedAt + 同一口径
   * 现算兜底。超时的 provisioning 记录由后续工具调用/钩子清扫置 failed——
   * 超时不再只存在于 lead MCP server 进程的内存里（server 中途死亡即永久卡死）。
   */
  provisionDeadlineAt?: number;
  /** Reason recorded by xc_member_stop (absent otherwise). */
  stopReason?: string;
  /** Last provisioning failure detail (state=failed only). */
  error?: string;
  /** v0.5（R-18）：声明的上下文字符数（预算刻度；absent = env/200k 缺省）。声明值，非探测值（V-1）。 */
  contextChars?: number;
}

/**
 * The whole team.json record (DESIGN.md §2.6). v0.2 adds the optional
 * `leadKey` (DESIGN-V0.2.md §3.1): the team lead's member key. Absent = no
 * explicit lead yet; the founder reads as lead (`leadKeyOf` in the member
 * tools, DESIGN-V0.2.md §6.1 step 1).
 */
export interface TeamState {
  teamId: string;
  name: string;
  founderKey: string;
  phase: TeamPhase;
  /** Team lead's member key (v0.2, optional). */
  leadKey?: string;
  /** v0.5（R-6）：本次 lead 变更时刻（epoch ms）。观测字段，不入快照。 */
  leadSince?: number;
  /** v0.5（R-6）：lead 变更滚动窗（≤32 条 FIFO；权威审计在 engine.jsonl）。 */
  leadHistory?: LeadHistoryEntry[];
  members: TeamMember[];
  tasks: Task[];
  /**
   * v0.5.1（故障注-5 修复）：团队纪元令牌（建队时生成，8 hex）。
   * 任务 id 由纪元前缀 + seq 组成（`<era>-t1`）。team.json 单文件丢失后重建
   * （静默重置）时新时代拿到新纪元，其任务 id 与残存邮箱里的旧时代信封永不相撞；
   * 旧记录（无 era 字段）宽容读取，任务 id 保持 `t1` 旧形态。
   */
  era?: string;
  /** Monotonic counter used to allocate task ids (`<era>-t1`, `<era>-t2`, ...). */
  seq: number;
  createdAt: number;
}

/** v0.5（R-6）：lead 变更史条目（宽容解析：event 枚举外/ts 非数字整条丢弃）。 */
export interface LeadHistoryEntry {
  event: "set" | "transfer" | "release";
  from: string | null;
  to: string | null;
  ts: number;
  reason?: string;
}
/** leadHistory 上限（对齐 SPEC-V0.3 R-10 formerNames 32 条口径）。 */
export const MAX_LEAD_HISTORY = 32;

/** Lifecycle state of one member with the v0.1.0 compatibility default (§6.5). */
export function memberState(member: TeamMember): MemberState {
  return member.state ?? 'ready';
}

/** Identity of one member with the v0.1.0 compatibility default (§6.5). */
export function memberIdentity(member: TeamMember): MemberIdentity {
  return member.identity ?? 'self';
}

/**
 * v0.9.1（G-10）：消息文件引用（跨会话/队内传图与二进制的合规解法）。
 *
 * 字段形状与 `xc_report` 的 evidence 条目对齐（path+sha256+mime+note）——「传引用
 * 不传内容」是文件真源架构的延伸：消息通道是纯文本 JSON（帧闸 1 MiB + 注入预算
 * 16k 字符），内联 base64 会同时违反「正文即状态」与预算纪律，因此附件一律以
 * 工作区内真实文件的引用形态随消息传递，接收面提示用 Read 打开该路径。
 */
export interface MessageRef {
  /** 工作区内相对或绝对路径（发送侧已过三道硬闸：越界/非文件/缺失拒绝）。 */
  path: string;
  /** 文件 sha256（hex；发送侧缺省现算——接收方可复算核对）。 */
  sha256?: string;
  /** MIME 提示（可选，如 image/png）；仅提示，不参与任何判定。 */
  mime?: string;
  /** 一句话说明（可选；控制字符清洗 + 长度钳制，同 evidence note 口径）。 */
  note?: string;
}

/**
 * One mailbox message (one JSONL line in `inbox/<agentKey>.jsonl`,
 * DESIGN.md §2.4). Fields that dsh leaves absent are absent here too; the
 * read-side validator additionally tolerates `null` (the DESIGN example shows
 * `readAt: null`) and normalizes it to absent.
 */
export interface TeamMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  ts: number;
  /** Recipient's open attempt snapshot taken at delivery time. */
  taskId?: string;
  attemptId?: string;
  /** Sender's provenance (the receipt-back path, DESIGN.md §2.9). */
  sourceTaskId?: string;
  sourceAttemptId?: string;
  sourceTaskStatus?: TaskStatus;
  deliveryClaimedAt?: number;
  deliveredAt?: number;
  /**
   * v0.9.1（G-12v3 机制 B）：**消费确认**回写时刻——与 deliveredAt（投递盖章）分离。
   * 写入点：成员回合实际消费（hook 未读注入 / xc_read inbox / xc_claim 读件）。
   * 用途：deliveredAt 已盖而 consumedAt 久未回写 = limbo（唤醒子进程在消费前死亡），
   * 引擎按 XC_LIMBO_TIMEOUT_MS（默认 10min）降级回 unread 并 urgent 告知 lead。
   */
  consumedAt?: number;
  readAt?: number;
  discardedAt?: number;
  /** v0.5（R-11）：作者身份标记；absent = agent（旧记录缺省）。权威不随消息转移（无 authority 字段）。 */
  origin?: "user" | "agent";
  /** v0.5（R-11）：最初作者会话（origin=user 时为用户输入所在会话）。 */
  originSessionId?: string;
  /** v0.5（R-15-2）：渲染层判定的可疑信封标记（渲染时现算+审计，落盘值仅供参考）。 */
  forged?: boolean;
  /** v0.6（C1）：urgent 消息在一切读取面排最前（urgentFirst 排序键）。absent=false。 */
  urgent?: boolean;
  /** v0.9（G-2）：软中断信封标记——xc_relay interrupt:true 写入，读取面据此渲染
   *  INTERRUPT 横幅（安全点纪律见 crosschat 技能 §6）。absent=false；内容永不授权。 */
  interrupt?: boolean;
  /** v0.9.1（G-10）：随消息传递的文件引用（可选）——只传路径与 sha256，不内联内容；
   *  读取面渲染「用 Read 打开该路径」提示（PROTOCOL §15.1）。absent=无引用。 */
  refs?: MessageRef[];
}

/** One session record in `registry/sessions/<sessionId>.json` (DESIGN.md §2.2). */
export interface SessionRecord {
  sessionId: string;
  cwd: string;
  startedAt: number;
  lastSeen: number;
  /** Set once the session has bound a name via xc_register. */
  boundName?: string;
  /**
   * v0.5.3（安全对-1/a6 修复）：锚定令牌——SessionStart 钩子铸造、仅注入到**本会话**
   * 上下文的随机凭据。(name, sessionId) 对可经 xc_status 公开读到，本身不是凭据；
   * 重绑已绑定 (name, sid) 对时必须出示本令牌，才能把「精确对重放冒充」从
   * 纯 MCP API 层堵死（令牌不出现在任何工具输出/注册表外的公开面上）。
   */
  regToken?: string;
  /**
   * v0.9（G-9）：会话活性落盘两态（PROTOCOL §12.4）——`running`（回合执行中：
   * UserPromptSubmit/SessionStart 起）/ `idle`（Stop 钩子止）；`dead` 是 C8 pid-dead
   * 的派生态，不落盘（core/liveness.ts）。absent = v0.8 存量记录 → 读作 idle
   * （保守：不给清扫豁免）。
   */
  liveness?: 'running' | 'idle';
  /** v0.9（G-9）：进入当前 liveness 态的时刻（epoch ms）；观测面算 stateAgeMin 用。 */
  livenessTs?: number;
  /**
   * v0.9（G-9/G-5）：本会话最近一次引擎事件的时刻（epoch ms）——钩子回合边界
   * （SessionStart/UserPromptSubmit/Stop）与 MCP 工具调用心跳（peer-drain 包装层）
   * 都刷新它。清扫侧作为心跳代理：属主在 stale 窗口内有过引擎事件即豁免（t1 模式），
   * 不再要求手动 xc_report 打卡。
   */
  lastEventTs?: number;
  /**
   * v0.9.2（A3）：本会话最近一次**回合开始**时刻（epoch ms）——全部写入点都是回合
   * 边界（SessionStart / UserPromptSubmit 钩子经 {@link refreshSessionLastSeen}）。
   * 用途单一：UserPromptSubmit 的「回合开始事故摘要」以**上一回合**的 lastTurnTs
   * 为窗口起点（自上次回合至今：成员死亡 / limbo 降级 / 唤醒失败的计数）。
   * absent = 存量记录（升级前锚定）→ 无窗口可言，A3 零注入（不回归）。
   */
  lastTurnTs?: number;
  /**
   * v0.9.4（A1）：本会话**宿主进程**的 pid（SessionStart 钩子写入）——成员 pid 证据。
   *
   * 取值口径（写死）：钩子进程自身是短命的（hooks.json `type:process`，timeoutMs 10s，
   * 写完 additionalContext 即退出），记它自己的 pid 会在秒级变成「进程已亡」把每个活
   * 会话误判成 pid-dead；因此记的是**拉起本钩子的宿主会话进程**（钩子的父进程，
   * `process.ppid`）——桌面会话的宿主进程/无头 --resume 的 CLI 进程，杀它即会话亡。
   * absent = 存量记录 / 供给代写（member-add 的欢迎回合跑在 app-server 里、无钩子）
   * / 锁忙未写成 → 无 pid 证据，memberLiveness 的 pid 判据不参与（不猜）。
   *
   * 消费面：core/offline.ts memberLiveness 的 pid 判据（与 liveness='running' 同时
   * 成立才判 pid-dead——回合间隙零进程是成员的正常形态，Stop 钩子后的 idle 会话
   * 不因旧 pid 已亡被误报）；看门狗（engine/watchdog.ts）据此在无 peer 注册记录的
   * 成员（从未 xc_identify 的引擎成员）上也能检出进程死。
   */
  pid?: number;
}

/**
 * One name binding in `registry/names.json` (DESIGN.md §2.2). v0.2 adds the
 * optional `issuedBy` (DESIGN-V0.2.md §6.1 step 6): `engine` on the engine's
 * pre-binding for provisioned members. Absent = registered by the session
 * itself. Note: a later re-registration (wake path) overwrites the binding and
 * drops this marker — the roster's `identity: "engine"` stays authoritative.
 */
export interface NameBinding {
  sessionId: string;
  role: MemberRole;
  registeredAt: number;
  /** `engine` when pre-bound by the member engine (v0.2, optional). */
  issuedBy?: 'engine' | 'self';
}

/** name -> binding map, the whole content of `registry/names.json`. */
export type NameBindings = Record<string, NameBinding>;

/** One one-shot wake nonce in `registry/wake/<nonce>.json` (DESIGN.md §2.3-4). */
export interface WakeNonce {
  teamId: string;
  agentKey: string;
  /** Target session id. */
  sid: string;
  ts: number;
  used?: boolean;
  /**
   * v0.9.1（G-11）：**用户语音归属**——本次唤醒续跑的原会话（= sid）。
   * 无头 --resume 回合与桌面原会话共享 sid，uservoice 盖章若按「sid 被别的活进程
   * 持有」一票否决，被唤醒回合永远无法转达用户原话（生产 4 次 session-id-held-
   * elsewhere 拒绝）。本字段由 attemptWake 随 nonce 落盘、xc_identify 消费 nonce
   * 时转记到连接身份（mcp/identity.ts BoundIdentity.voiceOwner），盖章面据此承认
   * 「本连接是该 sid 的唤醒续跑」而不再因 elsewhere 持有拒章。**不构成凭据**：
   * nonce 本身是一次性能力令牌（只有唤醒 prompt 的接收方看得到），且放宽仅对
   * voiceOwner === 本 sid 生效，对外部会话的拒绝线不放松。
   */
  voiceOwner?: string;
  /**
   * v0.9.4（A6）：**票据签发目标**（SessionStart 钩子自动绑身份用）——本 nonce 签发给
   * 哪个 sid（= 唤醒 prompt 的接收方会话）。与 {@link WakeNonce.sid}（续跑目标会话）
   * 同值，显式落账让「非目标 sid 拒」成为可判据：钩子只消费 issuedToSid === 本会话
   * sid 的票据，别个 sid 的唤醒票据不被误绑。
   */
  issuedToSid?: string;
  /**
   * v0.9.4（A6）：票据签发的**队内花名**（= agentKey，唤醒 prompt 身份行同名）——
   * 钩子消费票据后据此自动绑定队内轴身份（names.json/roster）与 peer 轴基记录，
   * 不经模型回合（「唤醒一次到位」）。absent = 旧 nonce（v0.9.3 及以前签发）：
   * 钩子按 agentKey 兜底取值，行为兼容。
   */
  name?: string;
}

/**
 * v0.9.1 r3（V090-01）：会话活性**引擎证言**（`registry/witness/<sid>.json`）。
 * 与 {@link SessionRecord} 分路：后者是自述（可被一次本地文件写伪造、仅作展示），
 * 本类型只由引擎进程写（hooks 回合边界 + MCP 工具调用心跳），是清扫豁免的唯一活性
 * 输入（core/liveness.ts sweepOwnerGuard 只吃它）。
 */
export type SessionWitnessKind = 'running' | 'idle' | 'heartbeat';
export interface SessionWitness {
  sessionId: string;
  kind: SessionWitnessKind;
  /** 证言写入时刻（引擎时钟，epoch ms）。 */
  ts: number;
}

// ---------------------------------------------------------------------------
// Primitive validators
// ---------------------------------------------------------------------------

/** Whether a parsed JSON value is a plain record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a value is a finite timestamp/counter number. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Whether a value is a non-blank string. */
export function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Normalize `null` to `undefined` at the durable boundary: the DESIGN message
 * example writes `readAt: null` while our records keep unset fields absent.
 */
function absent(value: unknown): unknown {
  return value === null ? undefined : value;
}

function optionalString(value: unknown): string | undefined {
  const v = absent(value);
  return typeof v === 'string' ? v : undefined;
}

function optionalFinite(value: unknown): number | undefined {
  const v = absent(value);
  return isFiniteNumber(v) ? v : undefined;
}

// ---------------------------------------------------------------------------
// Message validation (JSONL read side, port of state.js:1075-1092 + null tolerance)
// ---------------------------------------------------------------------------

/** Shape-check one parsed mailbox line so rendering cannot crash on `{}`/`null`. */
export function isTeamMessage(value: unknown): value is TeamMessage {
  if (!isRecord(value)) return false;
  const taskStatuses: readonly string[] = TASK_STATUSES;
  const absentOrFinite = (v: unknown): boolean => {
    const a = absent(v);
    return a === undefined || isFiniteNumber(a);
  };
  const absentOrString = (v: unknown): boolean => {
    const a = absent(v);
    return a === undefined || typeof a === 'string';
  };
  const sourceStatus = absent(value['sourceTaskStatus']);
  // v0.5（R-11）：origin 三字段宽容增量——旧记录缺省照读；在场时取值非法整行拒绝
  // （sourceTaskStatus 枚举同款纪律）。
  const origin = absent(value['origin']);
  const forged = absent(value['forged']);
  // v0.6（C1）：urgent 宽容增量——旧记录缺省照读；在场时必须布尔（forged 同款纪律）。
  const urgent = absent(value['urgent']);
  // v0.9（G-2）：interrupt 宽容增量——旧记录缺省照读；在场时必须布尔（urgent 同款纪律）。
  const interrupt = absent(value['interrupt']);
  // v0.9.1（G-10）：refs 宽容增量——旧记录缺省照读；在场时必须是数组且每条含非空
  // path（interrupt 同款纪律：取值非法整行拒绝，不做静默裁剪）。
  const refs = absent(value['refs']);
  return (
    isNonBlankString(value['id'])
    && isNonBlankString(value['from'])
    && isNonBlankString(value['to'])
    && typeof value['content'] === 'string'
    && isFiniteNumber(value['ts'])
    && absentOrFinite(value['deliveryClaimedAt'])
    && absentOrFinite(value['deliveredAt'])
    // v0.9.1（G-12v3 机制 B）：consumedAt 宽容增量——旧记录缺省照读；在场时必须
    // 有限数（deliveredAt/readAt 同款纪律）。
    && absentOrFinite(value['consumedAt'])
    && absentOrFinite(value['readAt'])
    && absentOrFinite(value['discardedAt'])
    && absentOrString(value['taskId'])
    && absentOrString(value['attemptId'])
    && absentOrString(value['sourceTaskId'])
    && absentOrString(value['sourceAttemptId'])
    && (sourceStatus === undefined
      || (typeof sourceStatus === 'string' && taskStatuses.includes(sourceStatus)))
    && (origin === undefined || origin === 'user' || origin === 'agent')
    && absentOrString(value['originSessionId'])
    && (forged === undefined || typeof forged === 'boolean')
    && (urgent === undefined || typeof urgent === 'boolean')
    && (interrupt === undefined || typeof interrupt === 'boolean')
    && (refs === undefined || isMessageRefList(refs))
  );
}

/**
 * v0.9.1（G-10）：refs 形状判定（宽容增量——缺省照读；在场时必须是数组且每条含
 * 非空 `path`，可选 sha256/mime/note 必须为字符串）。写侧面（resolveMessageRefs）
 * 已过三道硬闸，这里只做读取侧的形状卫生：非法 refs 整行拒绝（不进渲染面）。
 */
export function isMessageRefList(value: unknown): value is MessageRef[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (!isRecord(entry)) return false;
    if (!isNonBlankString(entry['path'])) return false;
    for (const key of ['sha256', 'mime', 'note'] as const) {
      const v = entry[key];
      if (v !== undefined && typeof v !== 'string') return false;
    }
    return true;
  });
}

/**
 * Normalize one already-shape-checked message: `null` optional fields become
 * absent so the rest of the code can rely on `undefined` only.
 */
export function normalizeMessage(value: TeamMessage): TeamMessage {
  const out: TeamMessage = {
    id: value.id,
    from: value.from,
    to: value.to,
    content: value.content,
    ts: value.ts,
  };
  const assign = <K extends keyof TeamMessage>(key: K, v: unknown): void => {
    const normalized = typeof v === 'string' || typeof v === 'number' ? v : undefined;
    if (normalized !== undefined) (out as unknown as Record<string, unknown>)[key] = normalized;
  };
  assign('taskId', absent(value.taskId));
  assign('attemptId', absent(value.attemptId));
  assign('sourceTaskId', absent(value.sourceTaskId));
  assign('sourceAttemptId', absent(value.sourceAttemptId));
  assign('sourceTaskStatus', absent(value.sourceTaskStatus));
  assign('deliveryClaimedAt', absent(value.deliveryClaimedAt));
  assign('deliveredAt', absent(value.deliveredAt));
  // v0.9.1（G-12v3 机制 B）：consumedAt 宽容拷贝（deliveredAt 同款纪律）。
  assign('consumedAt', absent(value.consumedAt));
  assign('readAt', absent(value.readAt));
  assign('discardedAt', absent(value.discardedAt));
  // v0.5（R-11）origin 三字段宽容拷贝：非法值归 absent（normalize 后的记录字段
  // 取值可信）；origin 仅 'user'/'agent' 两值，forged 仅布尔。
  if (value.origin === 'user' || value.origin === 'agent') out.origin = value.origin;
  if (typeof value.originSessionId === 'string') out.originSessionId = value.originSessionId;
  if (typeof value.forged === 'boolean') out.forged = value.forged;
  // v0.6（C1）：urgent 宽容拷贝（origin 同款纪律）。
  if (typeof value.urgent === 'boolean') out.urgent = value.urgent;
  // v0.9（G-2）：interrupt 宽容拷贝（urgent 同款纪律）。
  if (typeof value.interrupt === 'boolean') out.interrupt = value.interrupt;
  // v0.9.1（G-10）：refs 宽容拷贝（数组原样保留——形状已由 isTeamMessage 把关；
  // 条目内的可选串缺省归 absent，与 originSessionId 同口径）。
  if (Array.isArray(value.refs)) {
    out.refs = value.refs.map((ref) => ({
      path: ref.path,
      ...(typeof ref.sha256 === 'string' ? { sha256: ref.sha256 } : {}),
      ...(typeof ref.mime === 'string' ? { mime: ref.mime } : {}),
      ...(typeof ref.note === 'string' ? { note: ref.note } : {}),
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evidence validation
// ---------------------------------------------------------------------------

function coerceEvidence(value: unknown): EvidenceItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: EvidenceItem[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || !isNonBlankString(raw['path'])) return undefined;
    const sha = absent(raw['sha256']);
    if (sha !== undefined && sha !== null && typeof sha !== 'string') return undefined;
    const note = absent(raw['note']);
    if (note !== undefined && typeof note !== 'string') return undefined;
    items.push({
      path: raw['path'],
      sha256: typeof sha === 'string' ? sha : null,
      note: typeof note === 'string' ? note : '',
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Task validation (port of state.js:994-1021 isTeamTask, adapted to our schema)
// ---------------------------------------------------------------------------

function coerceDependsOn(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => typeof entry === 'string') ? (value as string[]) : undefined;
}

function coerceTask(value: unknown, now: number = Date.now()): Task | undefined {
  if (!isRecord(value)) return undefined;
  const status = value['status'];
  if (typeof status !== 'string' || !TASK_STATUSES.includes(status as TaskStatus)) return undefined;
  const dependsOn = coerceDependsOn(value['dependsOn']);
  if (dependsOn === undefined) return undefined;
  const evidence = coerceEvidence(value['evidence'] ?? []);
  if (evidence === undefined) return undefined;
  const historyRaw = value['history'] ?? [];
  if (!Array.isArray(historyRaw)) return undefined;
  const history: TaskHistoryEntry[] = [];
  for (const entry of historyRaw) {
    if (!isRecord(entry) || !isFiniteNumber(entry['ts']) || !isNonBlankString(entry['event'])
      || !isNonBlankString(entry['by'])) {
      return undefined;
    }
    const attemptId = optionalString(entry['attemptId']);
    history.push(attemptId === undefined
      ? { ts: entry['ts'], event: entry['event'], by: entry['by'] }
      : { ts: entry['ts'], event: entry['event'], by: entry['by'], attemptId });
  }
  const attempt = value['attempt'] === undefined || value['attempt'] === null
    ? 0
    : value['attempt'];
  if (!isFiniteNumber(attempt) || !Number.isSafeInteger(attempt) || attempt < 0) return undefined;
  const id = optionalString(value['id']);
  const title = value['title'];
  const prompt = value['prompt'];
  const createdBy = optionalString(value['createdBy']);
  const createdAt = optionalFinite(value['createdAt']);
  const updatedAt = optionalFinite(value['updatedAt']);
  if (id === undefined || typeof title !== 'string' || typeof prompt !== 'string'
    || createdBy === undefined || createdAt === undefined || updatedAt === undefined) {
    return undefined;
  }
  const acceptance = optionalString(value['acceptance']);
  const assignee = optionalString(value['assignee']) ?? null;
  const attemptId = optionalString(value['attemptId']) ?? null;
  const result = optionalString(value['result']) ?? null;
  const error = optionalString(value['error']) ?? null;
  // v0.6（C2）宽容增量（§11.1 纪律）：新字段非法值丢弃、绝不整文件拒绝——
  // v0.5.3 六态旧记录缺省照读（DESIGN-V0.6.md §6-4 迁移兼容），新记录读写无损。
  const priorityRaw = optionalString(value['priority']);
  const priority = priorityRaw !== undefined && TASK_PRIORITIES.includes(priorityRaw as TaskPriority)
    ? (priorityRaw as TaskPriority)
    : undefined;
  const blockedReason = optionalString(value['blockedReason']);
  const blockedAt = optionalFinite(value['blockedAt']);
  const preBlockedRaw = optionalString(value['preBlockedStatus']);
  const preBlockedStatus = preBlockedRaw !== undefined && TASK_STATUSES.includes(preBlockedRaw as TaskStatus)
    ? (preBlockedRaw as TaskStatus)
    : undefined;
  // v0.6.1（安全对-3 修复）：受领人字段宽容读取——非法值丢弃（absent=无受领人
  // 信息，认领面兼容开放），绝不整文件拒绝（§11.1 纪律）。
  const to = optionalString(value['to']);
  // v0.7.2（C8-B2 修复）：lastProgressTs 宽容读取——非有限数/非安全整数即丢弃
  // （absent=存量记录，读取方按 history 末条推导兜底），不整文件拒绝。
  const lastProgressTsRaw = value['lastProgressTs'];
  const lastProgressTs = isFiniteNumber(lastProgressTsRaw) && Number.isSafeInteger(lastProgressTsRaw) && lastProgressTsRaw >= 0
    ? lastProgressTsRaw
    : undefined;
  // v0.9.1（V090-05 r2）：C8 离线转交通知的持久闸——活性豁免的任务不被清扫、会跨
  // 清扫节拍持续命中 idle-timeout，本字段记录上次 lead 通知时刻，阈值窗口内不重复
  // （无闸则每 60s 节拍刷一次 lead 邮箱）。未来值同 plausibleLivenessTs 校验（伪造
  // 未来值压制 C8 通知的路径在读盘即失效）。
  const offlineNoticeAt = plausibleLivenessTs(value['offlineNoticeAt'], now) ? value['offlineNoticeAt'] : undefined;
  return {
    id,
    title,
    prompt,
    ...(acceptance === undefined ? {} : { acceptance }),
    dependsOn,
    status: status as TaskStatus,
    assignee,
    attempt,
    attemptId,
    createdBy,
    createdAt,
    updatedAt,
    ...(lastProgressTs === undefined ? {} : { lastProgressTs }),
    result,
    error,
    evidence,
    history,
    ...(priority === undefined ? {} : { priority }),
    ...(blockedReason === undefined ? {} : { blockedReason }),
    ...(blockedAt === undefined ? {} : { blockedAt }),
    ...(preBlockedStatus === undefined ? {} : { preBlockedStatus }),
    ...(to === undefined ? {} : { to }),
    ...(offlineNoticeAt === undefined ? {} : { offlineNoticeAt }),
  };
}

// ---------------------------------------------------------------------------
// Member + whole-team validation (port of state.js:675-700/1023-1073, our schema)
// ---------------------------------------------------------------------------

function coerceMember(value: unknown): TeamMember | undefined {
  if (!isRecord(value)) return undefined;
  const key = optionalString(value['key']);
  const sessionId = optionalString(value['sessionId']);
  const joinedAt = optionalFinite(value['joinedAt']);
  const lastSeen = optionalFinite(value['lastSeen']);
  if (key === undefined || sessionId === undefined || joinedAt === undefined || lastSeen === undefined) {
    return undefined;
  }
  const roleRaw = optionalString(value['role']) ?? 'peer';
  if (!MEMBER_ROLES.includes(roleRaw as MemberRole)) return undefined;
  // v0.2 optional fields (DESIGN-V0.2.md §9.1): unknown/absent values are
  // dropped, never rejected — old records read unchanged (§6.5/§11.1).
  const stateRaw = optionalString(value['state']);
  if (stateRaw !== undefined && !MEMBER_STATES.includes(stateRaw as MemberState)) return undefined;
  const identityRaw = optionalString(value['identity']);
  if (identityRaw !== undefined && !MEMBER_IDENTITIES.includes(identityRaw as MemberIdentity)) {
    return undefined;
  }
  const provisionedAt = optionalFinite(value['provisionedAt']);
  // v0.7.1（故障注-1 修复）：provisioning deadline 宽容读取（旧记录缺字段/
  // 非有限值按 absent，清扫方按 startedAt + 超时口径现算兜底）。
  const provisionDeadlineAt = optionalFinite(value['provisionDeadlineAt']);
  const stopReason = optionalString(value['stopReason']);
  const error = optionalString(value['error']);
  // v0.5（R-18）：contextChars 声明值宽容读取——非正整数视为 absent（按缺省处理）。
  const contextCharsRaw = value['contextChars'];
  const contextChars = typeof contextCharsRaw === 'number'
    && Number.isSafeInteger(contextCharsRaw)
    && contextCharsRaw > 0
    ? contextCharsRaw
    : undefined;
  return {
    key,
    sessionId,
    role: roleRaw as MemberRole,
    joinedAt,
    lastSeen,
    ...(stateRaw === undefined ? {} : { state: stateRaw as MemberState }),
    ...(identityRaw === undefined ? {} : { identity: identityRaw as MemberIdentity }),
    ...(provisionedAt === undefined ? {} : { provisionedAt }),
    ...(provisionDeadlineAt === undefined ? {} : { provisionDeadlineAt }),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(error === undefined ? {} : { error }),
    ...(contextChars === undefined ? {} : { contextChars }),
  };
}

export interface ParsedTeam {
  ok: true;
  state: TeamState;
}
export interface RejectedTeam {
  ok: false;
  /** Human-readable description of the first defect found. */
  defect: string;
}

/**
 * Strictly validate (and normalize) one parsed team.json value.
 * Applied ONLY to whole files (rename-atomic writes guarantee readers see a
 * complete file; DESIGN.md §2.7-5): bad data yields a diagnostic, never a
 * partially-coerced in-memory state.
 */
export function coerceTeamState(value: unknown, expectedTeamId: string, now: number = Date.now()): ParsedTeam | RejectedTeam {
  if (!isRecord(value)) return { ok: false, defect: 'team.json is not a JSON object' };
  const teamId = optionalString(value['teamId']);
  if (teamId === undefined) return { ok: false, defect: 'field "teamId" missing or blank' };
  if (teamId !== expectedTeamId) {
    return { ok: false, defect: `field "teamId" is "${teamId}", expected "${expectedTeamId}"` };
  }
  const name = optionalString(value['name']) ?? teamId;
  const founderKey = optionalString(value['founderKey']);
  if (founderKey === undefined) return { ok: false, defect: 'field "founderKey" missing or blank' };
  const phaseRaw = optionalString(value['phase']) ?? 'open';
  if (!TEAM_PHASES.includes(phaseRaw as TeamPhase)) {
    return { ok: false, defect: `field "phase" is "${phaseRaw}", expected open|halted` };
  }
  const createdAt = optionalFinite(value['createdAt']);
  if (createdAt === undefined) return { ok: false, defect: 'field "createdAt" missing or not a number' };
  // v0.2 optional leadKey (DESIGN-V0.2.md §3.1): absent on legacy teams.
  const leadKey = optionalString(value['leadKey']);
  // v0.5.1（故障注-5 修复）：era 宽容读取——旧记录缺字段照常解析（任务 id 旧形态）。
  const era = optionalString(value['era']);
  // v0.5（R-6）：leadSince/leadHistory 宽容读取——旧记录缺两字段照常解析；坏条目丢弃不拒文件。
  const leadSince = optionalFinite(value['leadSince']);
  const leadHistory = coerceLeadHistory(value['leadHistory']);
  if (!Array.isArray(value['members'])) return { ok: false, defect: 'field "members" is not an array' };
  const members: TeamMember[] = [];
  for (const raw of value['members']) {
    const member = coerceMember(raw);
    if (member === undefined) {
      return { ok: false, defect: `invalid member record: ${JSON.stringify(raw)}` };
    }
    members.push(member);
  }
  const keys = new Set(members.map((m) => m.key));
  if (keys.size !== members.length) return { ok: false, defect: 'duplicate member keys' };
  if (!Array.isArray(value['tasks'])) return { ok: false, defect: 'field "tasks" is not an array' };
  const tasks: Task[] = [];
  const taskIds = new Set<string>();
  for (const raw of value['tasks']) {
    const task = coerceTask(raw, now);
    if (task === undefined) {
      return { ok: false, defect: `invalid task record: ${JSON.stringify(raw)}` };
    }
    if (taskIds.has(task.id)) return { ok: false, defect: `duplicate task id "${task.id}"` };
    taskIds.add(task.id);
    tasks.push(task);
  }
  const seq = value['seq'] === undefined || value['seq'] === null ? tasks.length : value['seq'];
  if (!isFiniteNumber(seq) || !Number.isSafeInteger(seq) || seq < 0) {
    return { ok: false, defect: 'field "seq" is not a safe non-negative integer' };
  }
  return {
    ok: true,
    state: {
      teamId,
      name,
      founderKey,
      phase: phaseRaw as TeamPhase,
      ...(leadKey === undefined ? {} : { leadKey }),
      ...(era === undefined ? {} : { era }),
      ...(leadSince === undefined ? {} : { leadSince }),
      ...(leadHistory === undefined || leadHistory.length === 0 ? {} : { leadHistory }),
      members,
      tasks,
      seq,
      createdAt,
    },
  };
}

/** R-6：宽容解析 leadHistory——条目缺字段/枚举外整条丢弃；超 32 条取尾部。 */
function coerceLeadHistory(value: unknown): LeadHistoryEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const events = new Set(['set', 'transfer', 'release']);
  const out: LeadHistoryEntry[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const event = raw['event'];
    const ts = raw['ts'];
    const from = raw['from'] === null ? null : optionalString(raw['from']) ?? undefined;
    const to = raw['to'] === null ? null : optionalString(raw['to']) ?? undefined;
    if (typeof event !== 'string' || !events.has(event)) continue;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
    if (from === undefined || to === undefined) continue;
    const reason = optionalString(raw['reason']);
    out.push({
      event: event as LeadHistoryEntry['event'],
      from,
      to,
      ts,
      ...(reason === undefined ? {} : { reason }),
    });
  }
  return out.slice(-MAX_LEAD_HISTORY);
}

// ---------------------------------------------------------------------------
// Session / name-binding / wake-nonce validation
// ---------------------------------------------------------------------------

/**
 * v0.9.1（V090-01）：活性时间戳的**未来值容差**（同机时钟漂移上限）。
 * 产品自写的活性时刻恒为写入时的 Date.now()（core/registry.ts 三个写入点），
 * 超出容差的未来值只可能来自外部伪造/损坏——durable boundary 上一律丢弃该字段。
 */
export const LIVENESS_TS_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * v0.9.1（V090-01）：活性时间戳的物理可信校验（纯函数）。
 * 有限正数且不晚于 `now + LIVENESS_TS_FUTURE_SKEW_MS` 才可信；未来值在
 * coerceSessionRecord（durable boundary）与 core/liveness.ts 纯函数（防御纵深，
 * 兜内联构造的记录）两处消费——伪造 `lastEventTs=+1年` 不能再制造
 * `now - last <= thresholdMs` 恒真的永久心跳豁免。
 */
export function plausibleLivenessTs(value: unknown, now: number): value is number {
  return isFiniteNumber(value) && value > 0 && value <= now + LIVENESS_TS_FUTURE_SKEW_MS;
}

export function coerceSessionRecord(value: unknown, expectedSessionId: string, now: number = Date.now()): ParsedSession | RejectedSession {
  if (!isRecord(value)) return { ok: false, defect: 'session record is not a JSON object' };
  const sessionId = optionalString(value['sessionId']);
  if (sessionId === undefined) return { ok: false, defect: 'field "sessionId" missing or blank' };
  if (sessionId !== expectedSessionId) {
    return { ok: false, defect: `field "sessionId" is "${sessionId}", expected "${expectedSessionId}"` };
  }
  const cwd = optionalString(value['cwd']) ?? '';
  const startedAt = optionalFinite(value['startedAt']);
  const lastSeen = optionalFinite(value['lastSeen']);
  if (startedAt === undefined || lastSeen === undefined) {
    return { ok: false, defect: 'fields "startedAt"/"lastSeen" missing or not numbers' };
  }
  const boundName = optionalString(value['boundName']);
  // v0.5.3（a6）：regToken 可选透传——旧格式记录（升级前锚定）缺该字段照常解析。
  const regToken = optionalString(value['regToken']);
  // v0.9（G-9）：活性三字段宽容增量（§11.1 纪律）——旧记录缺省照读；在场时取值
  // 非法（liveness 枚举外 / 时间戳非有限数）整字段丢弃，绝不整文件拒绝。
  // v0.9.1（V090-01）：livenessTs/lastEventTs 加**未来值校验**（plausibleLivenessTs）
  // ——未来时刻在物理上不可能是产品自写的值，durable boundary 直接丢弃（absent =
  // 无心跳/无状态时刻，下游按保守口径处理：running 失去可信时刻 → 不豁免清扫）。
  const livenessRaw = optionalString(value['liveness']);
  const liveness = livenessRaw === 'running' || livenessRaw === 'idle' ? livenessRaw : undefined;
  const livenessTs = plausibleLivenessTs(value['livenessTs'], now) ? value['livenessTs'] : undefined;
  const lastEventTs = plausibleLivenessTs(value['lastEventTs'], now) ? value['lastEventTs'] : undefined;
  // v0.9.2（A3）：回合开始时刻同样走未来值校验——未来时刻在物理上不可能是产品自写的
  // 值（durable boundary 丢弃；A3 无窗口起点即零注入，保守方向）。
  const lastTurnTs = plausibleLivenessTs(value['lastTurnTs'], now) ? value['lastTurnTs'] : undefined;
  // v0.9.4（A1）：pid 宽容增量——正整数才收（非法值整字段丢弃，不拒整条记录；
  // 与 contextChars/regToken 同款宽容语义）。pid 是进程事实声明，不可能是未来值，
  // 无时间校验。
  const pidRaw = value['pid'];
  const pid = typeof pidRaw === 'number' && Number.isSafeInteger(pidRaw) && pidRaw > 0 ? pidRaw : undefined;
  return {
    ok: true,
    record: {
      sessionId,
      cwd,
      startedAt,
      lastSeen,
      ...(boundName === undefined ? {} : { boundName }),
      ...(regToken === undefined ? {} : { regToken }),
      ...(liveness === undefined ? {} : { liveness }),
      ...(livenessTs === undefined ? {} : { livenessTs }),
      ...(lastEventTs === undefined ? {} : { lastEventTs }),
      ...(lastTurnTs === undefined ? {} : { lastTurnTs }),
      ...(pid === undefined ? {} : { pid }),
    },
  };
}
export interface ParsedSession {
  ok: true;
  record: SessionRecord;
}
export interface RejectedSession {
  ok: false;
  defect: string;
}

export function coerceNameBindings(value: unknown): ParsedNames | RejectedNames {
  if (!isRecord(value)) return { ok: false, defect: 'names.json is not a JSON object' };
  const bindings: NameBindings = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!isRecord(raw)) return { ok: false, defect: `binding "${name}" is not a JSON object` };
    const sessionId = optionalString(raw['sessionId']);
    const registeredAt = optionalFinite(raw['registeredAt']);
    if (sessionId === undefined || registeredAt === undefined) {
      return { ok: false, defect: `binding "${name}" misses "sessionId"/"registeredAt"` };
    }
    const roleRaw = optionalString(raw['role']) ?? 'peer';
    if (!MEMBER_ROLES.includes(roleRaw as MemberRole)) {
      return { ok: false, defect: `binding "${name}" has invalid role "${roleRaw}"` };
    }
    // v0.2 optional issuedBy (DESIGN-V0.2.md §6.1 step 6): engine pre-binding.
    const issuedByRaw = optionalString(raw['issuedBy']);
    if (issuedByRaw !== undefined && issuedByRaw !== 'engine' && issuedByRaw !== 'self') {
      return { ok: false, defect: `binding "${name}" has invalid issuedBy "${issuedByRaw}"` };
    }
    bindings[name] = {
      sessionId,
      role: roleRaw as MemberRole,
      registeredAt,
      ...(issuedByRaw === undefined ? {} : { issuedBy: issuedByRaw as 'engine' | 'self' }),
    };
  }
  return { ok: true, bindings };
}
export interface ParsedNames {
  ok: true;
  bindings: NameBindings;
}
export interface RejectedNames {
  ok: false;
  defect: string;
}

export function coerceWakeNonce(value: unknown): ParsedNonce | RejectedNonce {
  if (!isRecord(value)) return { ok: false, defect: 'wake nonce is not a JSON object' };
  const teamId = optionalString(value['teamId']);
  const agentKey = optionalString(value['agentKey']);
  const sid = optionalString(value['sid']);
  const ts = optionalFinite(value['ts']);
  if (teamId === undefined || agentKey === undefined || sid === undefined || ts === undefined) {
    return { ok: false, defect: 'wake nonce misses "teamId"/"agentKey"/"sid"/"ts"' };
  }
  const used = value['used'] === undefined || value['used'] === null
    ? undefined
    : value['used'];
  if (used !== undefined && typeof used !== 'boolean') {
    return { ok: false, defect: 'field "used" is not a boolean' };
  }
  // v0.9.1（G-11）：voiceOwner 宽容增量——旧 nonce 缺省照读；在场时必须非空串。
  const voiceOwnerRaw = absent(value['voiceOwner']);
  if (voiceOwnerRaw !== undefined && (typeof voiceOwnerRaw !== 'string' || voiceOwnerRaw.trim() === '')) {
    return { ok: false, defect: 'field "voiceOwner" is not a non-blank string' };
  }
  // v0.9.4（A6）：issuedToSid/name 宽容增量——旧 nonce 缺省照读；在场时必须非空串
  // （空白串按缺省处理，钩子的「非目标 sid 拒」判据不因坏值放软）。
  const issuedToSidRaw = absent(value['issuedToSid']);
  if (issuedToSidRaw !== undefined && (typeof issuedToSidRaw !== 'string' || issuedToSidRaw.trim() === '')) {
    return { ok: false, defect: 'field "issuedToSid" is not a non-blank string' };
  }
  const nameRaw = absent(value['name']);
  if (nameRaw !== undefined && (typeof nameRaw !== 'string' || nameRaw.trim() === '')) {
    return { ok: false, defect: 'field "name" is not a non-blank string' };
  }
  return {
    ok: true,
    nonce: {
      teamId, agentKey, sid, ts,
      ...(used === undefined ? {} : { used }),
      ...(voiceOwnerRaw === undefined ? {} : { voiceOwner: voiceOwnerRaw }),
      ...(issuedToSidRaw === undefined ? {} : { issuedToSid: issuedToSidRaw }),
      ...(nameRaw === undefined ? {} : { name: nameRaw }),
    },
  };
}

/**
 * v0.9.1 r3（V090-01）：会话活性**引擎证言**的宽容解析（`registry/witness/<sid>.json`，
 * paths.ts witnessFile）。形状：`{sessionId, kind: 'running'|'idle'|'heartbeat', ts}`。
 * 与 coerceSessionRecord 的关键差异：**未来值整条拒绝**（证言时刻是引擎写入时的
 * Date.now()，未来值必为伪造——自述记录的 5min 容差不适用于此：证言没有时钟漂移
 * 场景，钩子与 MCP server 同机同钟）。损坏/缺字段 → 调用方按「无证言」处理
 * （保守：不给豁免）。
 *
 * v0.9.1 r4（V090-02）：容差**归零**——`ts > now` 即拒（r3 实现误继承自述的 5min 容差，
 * 与上方注释自认的「无漂移场景」矛盾：伪造 `ts=now+4min` 使守卫 age 为负、恒满足
 * `age ≤ boundMs`，单次写的豁免窗被放大到 skew+2×阈值，实测 360s vs 过去值 120s）。
 * 未来值一毫秒都不接受：证言与判定同机同钟，无漂移可容。
 */
export function coerceSessionWitness(value: unknown, expectedSessionId: string): ParsedWitness | RejectedWitness {
  if (!isRecord(value)) return { ok: false, defect: 'session witness is not a JSON object' };
  const sessionId = optionalString(value['sessionId']);
  if (sessionId === undefined) return { ok: false, defect: 'field "sessionId" missing or blank' };
  if (sessionId !== expectedSessionId) {
    return { ok: false, defect: `field "sessionId" is "${sessionId}", expected "${expectedSessionId}"` };
  }
  const kind = optionalString(value['kind']);
  if (kind !== 'running' && kind !== 'idle' && kind !== 'heartbeat') {
    return { ok: false, defect: 'field "kind" must be running|idle|heartbeat' };
  }
  const ts = optionalFinite(value['ts']);
  if (ts === undefined) return { ok: false, defect: 'field "ts" missing or not a number' };
  if (ts > Date.now()) {
    return { ok: false, defect: 'field "ts" is in the future (witness is engine-written on the same machine; zero skew tolerance)' };
  }
  return { ok: true, witness: { sessionId, kind, ts } };
}
export interface ParsedWitness {
  ok: true;
  witness: SessionWitness;
}
export interface RejectedWitness {
  ok: false;
  defect: string;
}
export interface ParsedNonce {
  ok: true;
  nonce: WakeNonce;
}
export interface RejectedNonce {
  ok: false;
  defect: string;
}

// ---------------------------------------------------------------------------
// Aliases used by the module-3 tool face (same types, other call names)
// ---------------------------------------------------------------------------

/** Alias of TeamMessage (module-3 call name, dsh parity). */
export type Message = TeamMessage;
