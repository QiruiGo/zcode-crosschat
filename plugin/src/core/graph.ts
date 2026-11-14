/**
 * W3 task-flow —— 任务图纯函数库（DESIGN-V0.2.md §5.1 E-b 边沿 / §5.4 清扫 / §12-O11 的
 * 引擎侧计算件；文件所有权表 §9.1 归 W3）。
 *
 * 全部为**纯函数**：输入 Task/TeamMessage 快照，输出计算结果或就地变更传入的 Task
 * （调用方持团队锁后经 teamstate.writeTeam 持久化）。本模块不碰磁盘、不 import
 * engine/mcp，只依赖 M1（core/types.ts + core/teamstate.ts 的纯助手）——被
 * W2（member-tools 的开放任务收回）、W4（xc_cancel 复用 revokeAttempt 的重置语义）
 * 与本模块 task-edges.ts 共同消费（依赖方向 W1 ← W3 ← {W2, W4}，§9.1）。
 *
 * 对齐参考（dsh-agent-teams-0.1.29）：
 * - scheduler.js:30-62  collectCompletedDependencyOutputs（拓扑序收集已完成祖先，环断支）
 * - scheduler.js:20-23  DEPENDENCY_OUTPUT_MAX_CHARS=2000 / TOTAL=12000（§12-O11 预算）
 * - scheduler.js:64-93  formatDependencyOutputs（单项/总额截断，超总预算丢最上游）
 * - scheduler.js:380-381  派发失败回滚 `task.status = 'pending'` 的引擎特权重置对应物
 * - state.js 清扫语义 = v0.1.0 已移植的 clearAttemptResult（重试必须重新产出证据）
 *
 * @module core/graph
 */
import {
  OPEN_TASK_STATUSES,
  type Task,
  type TeamMessage,
} from "./types.js";
import { appendTaskHistory, clearAttemptResult, unsatisfiedDependencies } from "./teamstate.js";

// ---------------------------------------------------------------------------
// 依赖图：下游就绪判定（E-b ②「依赖解除」的核心谓词）
// ---------------------------------------------------------------------------

/**
 * 「依赖解除」：completedTaskId 刚进入 completed 后，**恰好因此变为可领**的下游任务。
 *
 * 判定 = status === "pending" ∧ dependsOn 传递闭包含 completedTaskId ∧
 * unsatisfiedDependencies 为空（全部依赖已 completed）。三者合取恰好等价于
 * 「本条完成消息之前它还被阻塞、现在解除」——闭包路径上的 completedTaskId 此前
 * 必然未完成，而其余依赖现已全部完成。
 *
 * 环安全：反向遍历（completedTaskId → 直接依赖者 → …）带 visited 集合，环只断该支
 * （scheduler.js:38-41 同款纪律）。返回按「离 completedTaskId 近者在前」的 BFS 序
 * ——就绪子集内所有依赖均已满足，该序即一个合法拓扑序。
 */
export function downstreamReady(tasks: readonly Task[], completedTaskId: string): Task[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  // 反向边：taskId → 依赖它的任务 id 列表。
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      const list = dependents.get(dep);
      if (list === undefined) dependents.set(dep, [task.id]);
      else list.push(task.id);
    }
  }
  const visited = new Set<string>();
  const queue: string[] = [completedTaskId];
  const ready: Task[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue; // 环/重入：只断该支
    visited.add(current);
    for (const dependentId of dependents.get(current) ?? []) {
      if (visited.has(dependentId)) continue;
      const dependent = byId.get(dependentId);
      if (dependent === undefined) continue; // 依赖引用了不存在的任务：不可达，跳过
      queue.push(dependentId);
      if (
        dependent.status === "pending"
        && dependent.dependsOn.includes(completedTaskId)
        && unsatisfiedDependencies(tasks, dependent.dependsOn).length === 0
      ) {
        ready.push(dependent);
      }
    }
  }
  return ready;
}

/**
 * v0.5.3（A3 修复）：依赖死锁下游（failed/cancelled 上游专属）。
 *
 * deadTaskId 进入 failed/cancelled 后，其传递闭包内的 pending 下游永远无法满足
 * 依赖——依赖解除（E-b ②）只认 completed，而终态任务无出边，任何重试都造不出
 * 「同一条任务完成」的事实（重试 = 新任务）。不主动解除 = 下游 pending 死锁
 * （adj052 A3：无解除、无通知，唯一出路是创建者手工 xc_cancel）。
 *
 * 本函数沿反向边 BFS（downstreamReady 同款环安全纪律）收集「可达 ∧
 * status === "pending"」的任务。claimed/in_progress 不可能出现在 failed 任务的
 * 依赖闭包里（认领要求全部依赖 completed）；已 cancelled 的下游是上次解除的
 * 遗迹，天然被状态过滤跳过（幂等）。
 *
 * @returns 依赖已死锁的 pending 任务（BFS 序：离 deadTaskId 近者在前）。
 */
export function deadlockedDependents(tasks: readonly Task[], deadTaskId: string): Task[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  // 反向边：taskId → 依赖它的任务 id 列表（downstreamReady 同构）。
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      const list = dependents.get(dep);
      if (list === undefined) dependents.set(dep, [task.id]);
      else list.push(task.id);
    }
  }
  const visited = new Set<string>([deadTaskId]);
  const queue: string[] = [deadTaskId];
  const deadlocked: Task[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dependentId of dependents.get(current) ?? []) {
      if (visited.has(dependentId)) continue;
      // 入队即标记：diamond（t2→t4 且 t3→t4）会在 t4 出队前沿两条边各探到一次，
      // 只在出队时标记会双重收集（downstreamReady 无此问题——它的收集条件含
      // dependsOn.includes(completedTaskId)，非直接依赖的下游不满足）。
      visited.add(dependentId);
      const dependent = byId.get(dependentId);
      if (dependent === undefined) continue; // 依赖引用了不存在的任务：不可达，跳过
      queue.push(dependentId); // 闭包继续下探（深度 ≥2 的下游同样死锁）
      if (dependent.status === "pending") deadlocked.push(dependent);
    }
  }
  return deadlocked;
}

// ---------------------------------------------------------------------------
// 依赖输出注入（§12-O11 的 v0.2 半边：2000/12000 截断预算）
// ---------------------------------------------------------------------------

/** 单项输出截断预算（dsh scheduler.js:21 DEPENDENCY_OUTPUT_MAX_CHARS）。 */
export const DEPENDENCY_OUTPUT_MAX_CHARS = 2_000;
/** 全部输出的总截断预算（dsh scheduler.js:23 DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS）。 */
export const DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS = 12_000;

const NO_OUTPUT_TEXT = "(no output recorded)";
const TRUNCATED_MARKER = " [truncated]";

/**
 * 收集 taskId 的**已完成**祖先（沿 dependsOn 传递闭包），拓扑序（依赖在前），
 * 环断支（scheduler.js:30-62 1:1 语义）。输出带结果摘要的条目列表。
 */
export function completedDependencyOutputs(
  tasks: readonly Task[],
  taskId: string,
): Array<{ id: string; title: string; result: string }> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: Array<{ id: string; title: string; result: string }> = [];
  const walk = (id: string): void => {
    if (visiting.has(id)) return; // 环：断该支
    if (visited.has(id)) return;
    visiting.add(id);
    const task = byId.get(id);
    if (task !== undefined) {
      for (const dep of task.dependsOn) walk(dep);
      if (id !== taskId && task.status === "completed") {
        ordered.push({ id: task.id, title: task.title, result: task.result ?? "" });
      }
    }
    visiting.delete(id);
    visited.add(id);
  };
  walk(taskId);
  return ordered;
}

function truncateItem(body: string): string {
  if (body.length <= DEPENDENCY_OUTPUT_MAX_CHARS) return body;
  return body.slice(0, DEPENDENCY_OUTPUT_MAX_CHARS) + TRUNCATED_MARKER;
}

/**
 * 把已完成依赖的输出摘要格式化为注入文本（unblock-notice 的 dependencyOutputs 载荷）。
 * 预算纪律（scheduler.js:64-93 同款）：
 * 1. 单项先截到 DEPENDENCY_OUTPUT_MAX_CHARS（2000，加 ` [truncated]`）；
 * 2. 拼接超 DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS（12000）→ **从最上游开始丢弃**
 *    （拓扑序靠前者先丢——离本任务最近的依赖最重要），保底留一项；
 * 3. 保底单项仍超总预算 → 硬切到总预算。
 * 无已完成依赖 → "(none)"。
 */
export function collectDependencyOutputs(tasks: readonly Task[], taskId: string): string {
  const items = completedDependencyOutputs(tasks, taskId);
  if (items.length === 0) return "(none)";
  const formatted = items.map((item) => {
    const body = item.result.trim() === "" ? NO_OUTPUT_TEXT : truncateItem(item.result);
    return `- ${item.id} ${item.title}:\n  ${body}`;
  });
  let selected = formatted;
  while (selected.length > 1 && selected.join("\n").length > DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS) {
    selected = selected.slice(1); // 丢最上游
  }
  const last = selected[0];
  if (selected.length === 1 && last !== undefined && last.length > DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS) {
    selected = [last.slice(0, DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS) + TRUNCATED_MARKER];
  }
  return selected.join("\n");
}

// ---------------------------------------------------------------------------
// 引擎特权重置（§5.4 清扫 / §7.3.3 成员停止的开放任务收回）
// ---------------------------------------------------------------------------

/**
 * 引擎特权重置一个**开放**（claimed/in_progress）任务回 pending（§5.4）：
 * status→pending、assignee→null、attemptId→null、attempt 代数 +1、结果/证据清空
 * （clearAttemptResult：重试必须重新产出证据）、history 记 `revoked-stale`（或指定事件名）。
 *
 * 状态机豁免声明（§5.4）：`claimed|in_progress → pending` 不是 xc_report 可走的转移
 * （TASK_TRANSITIONS 无此边）——这是**引擎特权重置**，对齐 dsh 派发失败回滚
 * （scheduler.js:381）与成员停止的任务收回（dsh tools.js:1268 "return all unfinished
 * owned tasks to the shared pending pool"）；xc_report 的校验路径一字不改。
 *
 * attempt 代数 +1 的依据：§5.4 明文「attempt 代数 +1」——被清扫前的 attemptId 即使
 * 被并发者持有，其产物也随代数失配而失效（isCurrentMail 的 attempt 裁决）。
 *
 * @returns 是否发生了重置；terminal/pending 任务为 no-op（幂等安全），返回 false。
 */
export function revokeAttempt(
  task: Task,
  options: { by?: string; now?: number; event?: string } = {},
): boolean {
  if (!OPEN_TASK_STATUSES.includes(task.status)) return false;
  const now = options.now ?? Date.now();
  task.status = "pending";
  task.assignee = null;
  task.attemptId = null;
  task.attempt = (task.attempt ?? 0) + 1;
  clearAttemptResult(task);
  appendTaskHistory(task, options.event ?? "revoked-stale", options.by ?? "engine", undefined, now);
  return true;
}

/**
 * 僵尸任务候选（§5.4 清扫规则的第一步，纯判定）：
 * status ∈ {claimed, in_progress} ∧ now - updatedAt > thresholdMs。
 * 「该成员无在途 wake nonce」的豁免条件涉及 registry 扫描（IO），由调用方
 * （task-edges 的 E-b 边沿）在锁内补查后再 revokeAttempt。
 */
export function staleTasks(tasks: readonly Task[], now: number, thresholdMs: number): Task[] {
  return tasks.filter(
    (task) => OPEN_TASK_STATUSES.includes(task.status) && now - task.updatedAt > thresholdMs,
  );
}

// ---------------------------------------------------------------------------
// 收件人扫描辅助（unblock-notice 投递目标）
// ---------------------------------------------------------------------------

/** 解析一帧消息的 JSON content；非对象/不可解析 → undefined。 */
function parseFrame(content: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 在一组邮箱消息里找出携带 taskId 派单帧（task-assignment）的收件人
 * （§9.1「findTaskRecipient 扫描辅助」）：task-assignment 消息由 xc_dispatch 写入
 * 目标成员邮箱（tools.ts ticketText 的载荷），消息.to 即该任务的派发对象。
 * 任务未被派发（本地 pending、无邮箱帧）→ undefined，调用方跳过投递。
 * 扫描顺序 = 调用方给定的消息序（邮箱为 append-only JSONL，天然旧→新），命中即返回。
 */
export function findTaskRecipient(messages: readonly TeamMessage[], taskId: string): string | undefined {
  for (const message of messages) {
    if (message.taskId !== taskId) continue;
    const frame = parseFrame(message.content);
    if (frame?.["type"] === "task-assignment") return message.to;
  }
  return undefined;
}
