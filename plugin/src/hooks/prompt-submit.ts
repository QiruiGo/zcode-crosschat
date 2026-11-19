/**
 * M4 hooks-and-face: UserPromptSubmit hook — lastSeen refresh + inbox pull.
 *
 * v0.2 behavior（DESIGN.md §2.3-1、§7 M4）：刷新 registry/sessions/<sid>.json 的
 * lastSeen；有未读队内邮件时用 additionalContext 提示「有 N 条未读，先 xc_read({scope:"inbox"})」。
 *
 * v0.3 增量（DESIGN-V0.3.md §7.1 面 A、§6.2 档类新鲜度）：
 * - 跨会话 peer 消息的信封注入：排空机器全局 peers/queue/<sid>.jsonl，把每条渲染成
 *   <crosschat-peer-message> 信封块（含标签外的归因尾注）。
 * - 顺带刷新 peers/base/<sid>.json 的 permissionMode（载荷现成）。
 * - **一次调用一次输出**：队内提示与 peer 信封块合并成一段文本后 emit 一次。
 *
 * v0.8.0 增量（A1，DESIGN-V0.8.md §3.5）：检查点提醒——平台无 PreCompact 钩子，
 * 压缩防护是「一键 /xc-checkpoint + 本钩子轻量提醒」两级降级。判据（有活跃任务 ∧
 * 距上次检查点 >30min ∧ 30min 内没提醒过 ∧ 未设 XC_CHECKPOINT_NUDGE=0）在
 * core/checkpoint.ts 的纯函数里，钩子只取数/判据/拼一行；读路径无锁、失败只审计。
 *
 * v0.9.1 增量（G-14，方案 §二 组B）：队内未读提示升级为**回合开始强提醒**——
 * 未读>0 或任务板有 completed 未接力项时，注入置顶的阻塞式提醒块（未读条数、
 * xc_read 指令、「本回合已开始」的事实、平台只能注入不能否决工具调用的边界声明）。
 * 判据全从落盘真源现算，消费后自然消失（= 重复注入直到消费）；详见
 * {@link renderTurnStartReminder} 的三条硬口径。
 *
 * Build entry: dist/hooks/prompt-submit.mjs (scripts/build.mjs).
 */
import {
  auditHookFailure,
  boundNamesForSession,
  emitAdditionalContext,
  logHookEvent,
  markInjectedConsumed,
  peerRootFromEnv,
  readHookPermissionMode,
  readStdinPayload,
  refreshPeerBaseRecord,
  refreshSessionRegistration,
  resolveHookContext,
  sweepStaleProvisioning,
  unreadSummary,
} from './shared.js';
import { drainPeerQueue } from '../core/peermsg.js';
// 信封渲染的属主是 core/peerenvelope.ts（DESIGN-V0.3 §10.2）；W5 的 peermsg.ts
// 目前只转出了 renderPeerReceipt，故这里直接向属主模块取 renderPeerEnvelope。
// v0.5（§6.3-10）：队列项→InjectBlock 的装配属信封渲染域，面 A 与面 B/C 共用一份。
import { queueItemToInjectBlock, renderPeerEnvelope } from '../core/peerenvelope.js';
// v0.5（R-12）：盖章链第一步——钩子记录用户原始提示（属主 core/uservoice.ts，M4）。
import { uservoiceWrite } from '../core/uservoice.js';
// v0.5（R-23 面 A）：接收方注入预算与排布（属主 core/budget.ts，M1）。
import { contextCharsFromEnv, layoutInjectBlocks, receiverInjectBudget } from '../core/budget.js';
// v0.9.1（G-14）：回合开始强提醒的「已完成未接力」判据（纯函数属主 core/teamstate.ts，M1）
// 与任务板读取——M4 → M1 纪律不变（不碰 engine/MCP）。
import { DEFAULT_TEAM_ID } from '../core/types.js';
import { readTeam, unrelayedCompletedTasks } from '../core/teamstate.js';
// v0.8.0（A1，DESIGN-V0.8.md §3.5）：检查点提醒（判据/取数/文案属主 core/checkpoint.ts）。
import {
  checkpointNudgeDecision,
  checkpointNudgeState,
  renderCheckpointNudgeLine,
  writeNudgeMarker,
} from '../core/checkpoint.js';

/**
 * v0.9.1（G-14）：回合开始强提醒块（软约束硬化的注入面上界）。
 *
 * 背景（GAP-V0.9 G-14，方案 §二 组B）：高压期「inbox 4 条关键回报躺着没人消费」——
 * prompt/memory 规则不在决策强制位。修法 = UserPromptSubmit 时若未读>0 或任务板有
 * completed 未接力项，注入**置顶**的阻塞式提醒。
 *
 * 三条硬口径（写死，验收常量）：
 * 1. **置顶**：调用方 unshift 进 blocks（先于 peer 信封与检查点提醒）；
 * 2. **阻塞式措辞**：明写「本回合已经开始」的事实 + 「先 xc_read 再继续其他工作」
 *    的执行序，并给出未读条数/urgent 数/发送方与未接力任务 id；
 * 3. **平台边界如实声明**：宿主只允许注入、不允许插件否决工具调用（边界清单第一条）
 *    ——文案明说「不能否决或拦截任何工具调用」，**不声称**能拦下本回合首条工具调用。
 *
 * 「重复注入直到消费」不需要节流状态：判据全部从落盘真源现算（未读邮件 + 回执），
 * 消费（xc_read 落下 readAt / 回执被读）后本块自然消失——数据即收口条件。
 */
function renderTurnStartReminder(input: {
  agentKey: string;
  unreadCount: number;
  urgentCount: number;
  senders: readonly string[];
  unrelayed: ReadonlyArray<{ id: string; title: string }>;
}): string {
  const urgent = input.urgentCount > 0 ? `（含 ${input.urgentCount} 条 urgent）` : '';
  const senders = input.senders.length > 0 ? `，来自 ${input.senders.join('、')}` : '';
  const unrelayed =
    input.unrelayed.length > 0
      ? `另有 ${input.unrelayed.length} 个已完成任务尚未被你接力（${input.unrelayed
          .map((task) => `${task.id}「${task.title}」`)
          .join('、')}）：读回执后按需派下一步，或用 xc_overview 看板决定。`
      : '';
  return (
    `[zcode-crosschat] ⚠ 回合开始前置检查未通过：你（${input.agentKey}）有 ${input.unreadCount} 条未读协作消息${urgent}${senders}。`
    + '本回合已经开始（UserPromptSubmit 钩子已注入本块），上述事项不会因为暂不处理而消失。'
    + '请把 xc_read({scope:"inbox"}) 作为本回合第一个动作执行完，再继续其他工作；任务回执先核对证据再向用户汇报。'
    + unrelayed
    + '平台边界（如实声明）：本提醒只能注入上下文，不能否决或拦截任何工具调用——是否先消费取决于你本人；未消费前每个回合开始都会重复注入本块。'
  );
}

async function main(): Promise<void> {
  const stdin = readStdinPayload();
  const ctx = resolveHookContext('UserPromptSubmit', stdin);

  if (ctx.sessionId !== undefined) {
    try {
      await refreshSessionRegistration(ctx.stateRoot, ctx.sessionId, ctx.workspace);
    } catch (error) {
      await auditHookFailure(ctx.stateRoot, 'prompt-submit-refresh', error);
    }
  }

  if (ctx.sessionId === undefined) return;

  // --- v0.7.1（红队四番战 故障注-1）：provisioning 超时清扫（钩子面）---
  // lead 的 MCP server 中途死亡时，建员欢迎回合的超时只存在于那个进程的内存里
  // （红队 fi1：成员永久卡 provisioning、无回执、无审计、还占名额）。v0.7.1 起
  // deadline 随 provisioning 记录落盘，任一存活会话的回合（本钩子）都能把过期
  // 记录清扫成 failed + 审计。best-effort：锁忙（2s 预算）跳过，下回合再扫；
  // 任何失败只审计不阻断（钩子永不失败会话）。
  try {
    await sweepStaleProvisioning(ctx.stateRoot);
  } catch (error) {
    await auditHookFailure(ctx.stateRoot, 'prompt-submit-provision-sweep', error);
  }

  const blocks: string[] = [];

  // --- v0.3：跨会话 peer 信封注入（面 A：保证路径）---
  try {
    const root = peerRootFromEnv(process.env);
    // 档类刷新：会话中途改权限模式时，自动档判定不吃陈旧快照。
    const mode = readHookPermissionMode(stdin);
    if (mode !== undefined) {
      await refreshPeerBaseRecord(root, ctx.sessionId, { permissionMode: mode, lastSeen: Date.now() });
    }
    // v0.5（R-12）：记录本轮用户原始提示（盖章链第一步；失败只审计不阻断）。
    // V-4 未确认项：载荷中用户提示文本的键名现有代码未读取过——首项实验落键名审计，取不到不写记录。
    try {
      const promptText = stdin?.str('prompt', 'prompt') ?? stdin?.str('user_prompt', 'userPrompt');
      if (promptText !== undefined) {
        await uservoiceWrite(root, ctx.sessionId, promptText, Date.now());
      } else {
        await logHookEvent(ctx.stateRoot, {
          event: 'hook-uservoice-no-prompt',
          sessionId: ctx.sessionId,
          keys: Object.keys(stdin?.raw ?? {}).sort(),
        });
      }
    } catch (error) {
      await auditHookFailure(ctx.stateRoot, 'uservoice-write', error);
    }
    const items = await drainPeerQueue(root, ctx.sessionId, 20);
    if (items.length > 0) {
      // v0.5（R-23 面 A）：渲染 → 预算排布（花费新→旧、输出保到达序）。
      // store 已在接收入队时落盘（F-3，DESIGN-V0.5 §5.1），面内不落——注入面只渲染+排布。
      const budget = receiverInjectBudget(contextCharsFromEnv(process.env), process.env);
      const injectBlocks = items.map((item) => queueItemToInjectBlock(item, renderPeerEnvelope(item)));
      const layout = layoutInjectBlocks(injectBlocks, budget, 'peer');
      if (layout.blocks.length > 0) {
        blocks.push(layout.blocks.join('\n\n'));    // ★推入外层 string[]——emitAdditionalContext 的唯一出口
        await logHookEvent(ctx.stateRoot, {
          event: 'inject-budget',
          face: 'A',
          budget: budget.total,
          truncatedCount: layout.truncatedCount,
          totalChars: layout.totalChars,
        });
      }
      // 原 hook-peer-inbound 审计行保持（items/from 字段不变）。
      await logHookEvent(ctx.stateRoot, {
        event: 'hook-peer-inbound',
        sessionId: ctx.sessionId,
        count: items.length,
        from: items.map((i) => i.from),
      });
    }
  } catch (error) {
    await auditHookFailure(ctx.stateRoot, 'prompt-submit-peer-inbound', error);
  }

  // --- v0.2：队内未读提示｜v0.9.1（G-14）：升级为回合开始**强提醒**（置顶+阻塞式）---
  // 判据（任务书原文）：inbox 未读>0 **或**任务板有 completed 未接力项 → 注入置顶
  // 阻塞式提醒块。取数面与 v0.2 完全相同（unreadSummary：纯读、不判新鲜度、不丢弃），
  // 升级的只有措辞与位置——软提示（「先 xc_read 再继续」）变硬提醒（「本回合已经开始
  // ＋先消费再干活＋未消费前每回合重复」），并明写平台边界（只能注入、不能否决工具
  // 调用，不声称能拦截本回合首条工具调用）。
  // 第二个判据「completed 未接力」= 派发方邮箱里未读的 completed 回执 ∧ 任务板上
  // 该任务仍 completed（纯函数 core/teamstate.ts unrelayedCompletedTasks）；team.json
  // 读失败/损坏 → 只报未读数（观测面不为难），不阻断注入。
  // 任何异常只审计不阻断（钩子永不失败会话）。
  let names: string[] = [];
  try {
    names = await boundNamesForSession(ctx.stateRoot, ctx.sessionId);
  } catch (error) {
    await auditHookFailure(ctx.stateRoot, 'prompt-submit-names', error);
    names = [];
  }
  if (names.length > 0) {
    try {
      const summary = await unreadSummary(ctx.stateRoot, names[0]!);
      const agentKey = names[0]!;
      let unrelayed: Array<{ id: string; title: string }> = [];
      try {
        const team = await readTeam(ctx.stateRoot, DEFAULT_TEAM_ID);
        if (team !== undefined) unrelayed = unrelayedCompletedTasks(team, summary.messages);
      } catch (error) {
        await auditHookFailure(ctx.stateRoot, 'prompt-submit-turn-start-handoff', error);
      }
      if (summary.count > 0 || unrelayed.length > 0) {
        // v0.9.1（G-12v3 机制 B）：注入即消费确认回写——本会话实际开跑并被知会
        // （consumedAt），唤醒盖章后的 limbo 降级以此放行（引擎侧 10min 超时判据）。
        // best-effort（团队锁 2s 预算）：锁忙跳过，下回合再写；无未读则零写盘。
        try {
          await markInjectedConsumed(ctx.stateRoot, agentKey);
        } catch (error) {
          await auditHookFailure(ctx.stateRoot, 'prompt-submit-consumed-writeback', error);
        }
        // 置顶：先于 peer 信封块与检查点提醒（blocks 此时只可能有 peer 块）。
        blocks.unshift(
          renderTurnStartReminder({
            agentKey,
            unreadCount: summary.count,
            urgentCount: summary.urgentCount,
            senders: summary.senders,
            unrelayed,
          }),
        );
        await logHookEvent(ctx.stateRoot, {
          event: 'hook-prompt-submit-unread',
          sessionId: ctx.sessionId,
          name: agentKey,
          unread: summary.count,
          senders: summary.senders,
          // v0.9.1（G-14）：强提醒的第二个判据——已完成未接力任务 id（空数组 = 只踩了
          // 未读判据）。审计面据此区分「有人没读消息」与「有人没接已完成活」。
          unrelayedCompleted: unrelayed.map((task) => task.id),
        });
      }
    } catch (error) {
      await auditHookFailure(ctx.stateRoot, 'prompt-submit-inbox', error);
    }
  }

  // --- v0.8.0（A1，DESIGN-V0.8.md §3.5）：检查点提醒（无 PreCompact 的降级替代）---
  // 判据（core/checkpoint.ts 纯函数，负例在 core/checkpoint.test.ts 逐条覆盖）：
  // XC_CHECKPOINT_NUDGE=0 关；无活跃任务不提醒；距上次检查点 ≤30min 不提醒；
  // 距上次提醒 ≤30min 不提醒（每 agent 30min 最多一次）；其余才注入。
  // 读路径无锁（与 unreadSummary 同纪律：纯读、不判定新鲜度、不丢弃）；
  // agentKey 沿用未读提醒的现成机制（boundNamesForSession 取 names[0]）——取不到
  // （未注册会话）就没有「我的任务/我的检查点目录」可言，不提醒。
  // 任何异常只审计不阻断（钩子永不失败会话）。
  if (names.length > 0) {
    const agentKey = names[0]!;
    try {
      const now = Date.now();
      const decision = checkpointNudgeDecision({
        env: process.env,
        ...(await checkpointNudgeState(ctx.stateRoot, agentKey, process.env, now)),
        now,
      });
      if (decision.nudge) {
        // 先把本回合记进节流标记（best-effort）再注入：标记写失败仍注入（提醒比记账重要）。
        try {
          await writeNudgeMarker(ctx.stateRoot, agentKey, now);
        } catch (error) {
          await auditHookFailure(ctx.stateRoot, 'checkpoint-nudge-marker-failed', error);
        }
        blocks.push(renderCheckpointNudgeLine(decision.ageMin));
        await logHookEvent(ctx.stateRoot, {
          event: 'hook-checkpoint-nudge',
          sessionId: ctx.sessionId,
          agentKey,
          reason: decision.reason,
          ...(decision.ageMin !== undefined ? { ageMin: decision.ageMin } : {}),
        });
      }
    } catch (error) {
      await auditHookFailure(ctx.stateRoot, 'prompt-submit-checkpoint-nudge', error);
    }
  }

  // 一次 emit、一次输出（stdout 严格单键单行，hooks/shared.ts 契约）。
  // v0.8.1（29 红队 C1-B03 修复）：零注入块时也输出一行 JSON（additionalContext=""）
  // ——§14.2/§11.3 的 stdout 契约是「恰一行 JSON、恰一个 additionalContext 键」，
  // 旧实现零块时 stdout 为空串（连 JSON.parse 都失败），形状随内容有无而变；
  // 空串 additionalContext 对宿主是无注入语义（strict schema 认可该键的字符串值），
  // 形状却恒定可解析。stop 钩子「零 stdout」是另一事件的既有契约，不随本改动。
  emitAdditionalContext(blocks.join("\n\n"));
}

main().catch(async (error: unknown) => {
  // Final guard: a hook must never exit non-zero (would mark the run failed).
  const stdin = readStdinPayload();
  const ctx = resolveHookContext('UserPromptSubmit', stdin);
  await auditHookFailure(ctx.stateRoot, 'prompt-submit', error);
});
