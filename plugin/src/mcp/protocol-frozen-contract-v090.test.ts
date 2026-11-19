/**
 * v0.9.0 组 C 文档即测试契约：docs/PROTOCOL.md 冻结示例 → 形状漂移当场红。
 *
 * 口径（31-v090 方案 §一 G-3/G-2 + README/PROTOCOL 独占域）：冻结示例写在 PROTOCOL
 * §3/§7/§7.1，本文件把它们当机器可校验契约——键集按 `Object.keys` 对拍（块内值为
 * 占位），横幅逐字节对拍；漂移（改文档不改码 / 改码不改文档）任一侧先红。
 *
 * 覆盖面：
 * - tools/list 仍恰 10（xc_relay 只是参数扩展，不增面；黑盒精确集合，同 legacy-removal 口径）；
 * - PROTOCOL §7.1 撤回四冻结块 ↔ RelayShape / 实跑成功 payload / 拒绝 payload /
 *   withdrawal-notice 帧 / engine 事件（行级 ts 除外）；
 * - PROTOCOL §7 interrupt payload 冻结键集 ↔ delivered 路径实跑块（result 词冻结）；
 * - PROTOCOL §3 INTERRUPT 信封冻结形态 ↔ TEAM_INTERRUPT_BANNER 逐字节 + interrupt="true"；
 * - README（G-1 已知限制条目 + 唤醒分层口径 + xc_relay 参数行）/ SKILL.md（安全点纪律 +
 *   withdrawal-notice 白名单）三面文档一致性。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { composeCore, resolveDeps, type PrimaryRegistry } from './core.js';
import { registerIdentifyTools } from './tools-identify.js';
import { registerTaskTools } from './tools-tasks.js';
import { registerReadTools } from './tools-read.js';
import { registerRelay } from './tools-relay.js';
import { registerOverviewTools } from './tools-overview.js';
import { registerTeamTools } from './tools-team.js';
import { registerReviewTools } from './tools-review.js';
import { registerDoctorTool } from './doctor-tool.js';
import { RelayShape, buildWithdrawalNoticeFrame, INTERRUPT_DEFERRED_REASON } from './tools-relay.js';
import { identityStore } from './identity.js';
import { createTeamRelayCore } from './tools-relay.js';
import { payloadOf } from './protocol.js';
import { newTeamState, writeTeam } from '../core/teamstate.js';
import { acknowledgeMailbox, readMailbox } from '../core/mailbox.js';
import { TEAM_INTERRUPT_BANNER } from '../core/peerenvelope.js';
import type { ToolResult } from './protocol.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ROOT = join(SRC, '..');
const REPO_ROOT = join(PLUGIN_ROOT, '..');

const PROTOCOL = readFileSync(join(REPO_ROOT, 'docs', 'PROTOCOL.md'), 'utf8');
const README = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
const SKILL = readFileSync(join(PLUGIN_ROOT, 'skills', 'crosschat', 'SKILL.md'), 'utf8');

/** v0.7 工具面（恰 10；黑盒核数用精确集合——参数扩展不得增面）。 */
const EXPECTED_TOOLS = [
  'xc_identify', 'xc_dispatch', 'xc_claim', 'xc_report', 'xc_read',
  'xc_relay', 'xc_overview', 'xc_team', 'xc_review', 'xc_doctor',
] as const;

/** 取 marker 之后的前 count 个 ```json 冻结块（PROTOCOL §7.1 四连块的提取器）。 */
function frozenJsonBlocksAfter(doc: string, marker: string, count: number): Record<string, unknown>[] {
  const at = doc.indexOf(marker);
  if (at < 0) throw new Error(`PROTOCOL 冻结标记缺失：${marker}`);
  const rest = doc.slice(at);
  const blocks: Record<string, unknown>[] = [];
  const re = /```json\r?\n([\s\S]*?)```/g; // CRLF 宽容（工作区文件可能是 \r\n）
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null && blocks.length < count) {
    blocks.push(JSON.parse(m[1]!) as Record<string, unknown>);
  }
  if (blocks.length < count) throw new Error(`PROTOCOL 冻结块不足：${marker}（需 ${count}，得 ${blocks.length}）`);
  return blocks;
}

const sortedKeys = (value: Record<string, unknown>): string[] => Object.keys(value).sort();

// ---------------------------------------------------------------------------
// 黑盒工具面：恰 10
// ---------------------------------------------------------------------------

describe('v0.9 契约：tools/list 仍恰 10（参数扩展不增面）', () => {
  let workDir = '';
  let client: Client | undefined;
  let server: McpServer | undefined;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'xc-contract-toolface-'));
    const deps = resolveDeps(workDir, { XC_MESSAGING_DIR: join(workDir, 'peers-root'), XC_WAKE_ENABLED: 'false' });
    const core = composeCore(deps);
    const registry: PrimaryRegistry = new Map();
    server = new McpServer({ name: 'zcode-crosschat', version: '0.9.0' });
    registerIdentifyTools(server, deps, core, registry);
    registerTaskTools(server, deps, core, registry);
    registerReadTools(server, deps, core, registry);
    registerRelay(server, deps, core, registry);
    registerOverviewTools(server, deps, core, registry);
    registerTeamTools(server, deps, core, registry);
    registerReviewTools(server, deps, core, registry);
    registerDoctorTool(server, { version: '0.9.0', env: deps.env, cwd: workDir });
    registry.set('xc_doctor', {
      description: 'Read-only self check (test stub).',
      shape: {},
      handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'frozen-contract-test', version: '0.9.0' });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    if (workDir !== '') rmSync(workDir, { recursive: true, force: true });
  });

  it('tools/list 精确集合 = 恰 10 个新名', async () => {
    const listed = await client!.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('xc_relay 工具 schema 带 withdrawMessageIds（参数扩展；msg 可选由运行时校验兜底）', async () => {
    const listed = await client!.listTools();
    const relay = listed.tools.find((t) => t.name === 'xc_relay');
    expect(relay).toBeDefined();
    expect(Object.keys(relay!.inputSchema.properties ?? {})).toContain('withdrawMessageIds');
    expect(relay!.description).toContain('withdraw');
    expect(relay!.description).toContain('soft-interrupt');
  });
});

// ---------------------------------------------------------------------------
// PROTOCOL §7.1 撤回冻结块 ↔ 代码形状
// ---------------------------------------------------------------------------

describe('v0.9 契约：PROTOCOL §7.1 撤回冻结键集 ↔ 代码', () => {
  /** §7.1 四连块：withdrawal-notice 帧 / 成功 payload / 拒绝 payload / engine 事件。 */
  const [frozenNotice, frozenSuccess, frozenReject, frozenEvent] = frozenJsonBlocksAfter(
    PROTOCOL,
    '通知帧、响应与审计的键集冻结',
    4,
  );

  /** 一条最小实跑链（seed → 发 2 件 → 撤回 1 件），供各冻结块对拍。 */
  async function runWithdrawFlow(): Promise<{
    successPayload: Record<string, unknown>;
    noticeFrame: Record<string, unknown>;
    eventFields: Record<string, unknown>;
    stateRoot: string;
  }> {
    const workDir = mkdtempSync(join(tmpdir(), 'xc-contract-withdraw-'));
    const stateRoot = join(workDir, '.crosschat');
    const now = Date.now();
    const team = newTeamState({ teamId: 'default', founderKey: 'a', now });
    team.members.push(
      { key: 'a', sessionId: 'sess_a', role: 'peer', joinedAt: now, lastSeen: now },
      { key: 'b', sessionId: 'sess_b', role: 'worker', joinedAt: now, lastSeen: now },
    );
    await writeTeam(stateRoot, team);
    identityStore.bind('conn-a', {
      sessionKey: 'xc:default:a',
      teamId: 'default',
      name: 'a',
      agentKey: 'a',
      sessionId: 'sess_a',
      role: 'peer',
      boundAt: now,
    });
    const deps = { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: join(workDir, 'peers') } };
    const relay = createTeamRelayCore(deps);
    const send = (await relay.xc_message({ to: 'b', msg: '要撤回的件' }, 'conn-a')) as ToolResult;
    const messageId = (payloadOf(send) as Record<string, unknown>)['messageId'] as string;
    const result = await relay.xc_message({ to: 'b', withdrawMessageIds: [messageId] }, 'conn-a');
    const successPayload = payloadOf(result) as Record<string, unknown>;
    const box = await readMailbox(stateRoot, 'default', 'b');
    const noticeFrame = JSON.parse(box[0]!.content) as Record<string, unknown>;
    const { existsSync } = await import('node:fs');
    const engineFile = join(stateRoot, 'logs', 'engine.jsonl');
    const eventFields = existsSync(engineFile)
      ? (JSON.parse(
          readFileSync(engineFile, 'utf8')
            .split('\n')
            .filter((l) => l.includes('"message-withdrawn"'))
            .at(-1)!,
        ) as Record<string, unknown>)
      : {};
    rmSync(workDir, { recursive: true, force: true });
    return { successPayload, noticeFrame, eventFields, stateRoot };
  }

  it('通知帧冻结键集 === buildWithdrawalNoticeFrame 键集；type 值冻结', async () => {
    const { noticeFrame } = await runWithdrawFlow();
    expect(sortedKeys(frozenNotice)).toEqual(sortedKeys(noticeFrame));
    expect(sortedKeys(frozenNotice)).toEqual(sortedKeys(JSON.parse(buildWithdrawalNoticeFrame(['x'], 0)) as Record<string, unknown>));
    expect(frozenNotice['type']).toBe('withdrawal-notice');
    expect(noticeFrame['type']).toBe('withdrawal-notice');
  });

  it('成功响应冻结键集 === 实跑撤回 payload 键集', async () => {
    const { successPayload } = await runWithdrawFlow();
    expect(sortedKeys(frozenSuccess)).toEqual(sortedKeys(successPayload));
  });

  it('engine 事件冻结键集 === 实跑 message-withdrawn 行键集（行级 ts 除外）', async () => {
    const { eventFields } = await runWithdrawFlow();
    const { ts: _ts, ...fields } = eventFields;
    expect(sortedKeys(frozenEvent)).toEqual(sortedKeys(fields));
    expect(fields['event']).toBe('message-withdrawn');
    expect(frozenEvent['event']).toBe('message-withdrawn');
  });

  it('拒绝响应冻结键集 === withdraw_rejected payload 键集（items 逐条键 + 状态取值域冻结）', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'xc-contract-reject-'));
    try {
      const stateRoot = join(workDir, '.crosschat');
      const now = Date.now();
      const team = newTeamState({ teamId: 'default', founderKey: 'a', now });
      team.members.push(
        { key: 'a', sessionId: 'sess_a', role: 'peer', joinedAt: now, lastSeen: now },
        { key: 'b', sessionId: 'sess_b', role: 'worker', joinedAt: now, lastSeen: now },
      );
      await writeTeam(stateRoot, team);
      identityStore.bind('conn-a', {
        sessionKey: 'xc:default:a',
        teamId: 'default',
        name: 'a',
        agentKey: 'a',
        sessionId: 'sess_a',
        role: 'peer',
        boundAt: now,
      });
      const deps = { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: join(workDir, 'peers') } };
      const relay = createTeamRelayCore(deps);
      const unreadId = (payloadOf(await relay.xc_message({ to: 'b', msg: '未读' }, 'conn-a')) as Record<string, unknown>)['messageId'] as string;
      const readId = (payloadOf(await relay.xc_message({ to: 'b', msg: '已读' }, 'conn-a')) as Record<string, unknown>)['messageId'] as string;
      await acknowledgeMailbox(stateRoot, 'default', 'b', [readId]);
      const result = await relay.xc_message({ to: 'b', withdrawMessageIds: [unreadId, readId, 'no-such-id'] }, 'conn-a');
      expect(result.isError).toBe(true);
      const payload = payloadOf(result) as Record<string, unknown>;
      expect(sortedKeys(frozenReject)).toEqual(sortedKeys(payload));
      const frozenItem = (frozenReject['items'] as Array<Record<string, unknown>>)[0]!;
      for (const item of payload['items'] as Array<Record<string, unknown>>) {
        expect(sortedKeys(item)).toEqual(sortedKeys(frozenItem));
        expect(['unread', 'read', 'not_found', 'foreign', 'discarded', 'notice']).toContain(item['status']);
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// PROTOCOL §7 interrupt payload + §3 信封 + RelayShape
// ---------------------------------------------------------------------------

describe('v0.9 契约：PROTOCOL §7/§3 软中断冻结 ↔ 代码', () => {
  const frozenInterrupt = frozenJsonBlocksAfter(PROTOCOL, 'payload interrupt 块键集冻结', 1)[0]!;

  it('interrupt payload 冻结键集 === delivered 路径实跑块键集；result 词冻结 "deferred-next-turn"', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'xc-contract-interrupt-'));
    try {
      const stateRoot = join(workDir, '.crosschat');
      const now = Date.now();
      const team = newTeamState({ teamId: 'default', founderKey: 'a', now });
      team.members.push(
        { key: 'a', sessionId: 'sess_a', role: 'peer', joinedAt: now, lastSeen: now },
        { key: 'b', sessionId: 'sess_b', role: 'worker', joinedAt: now, lastSeen: now },
      );
      await writeTeam(stateRoot, team);
      identityStore.bind('conn-a', {
        sessionKey: 'xc:default:a',
        teamId: 'default',
        name: 'a',
        agentKey: 'a',
        sessionId: 'sess_a',
        role: 'peer',
        boundAt: now,
      });
      const deps = { stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: join(workDir, 'peers') } };
      const relay = createTeamRelayCore(deps);
      const payload = payloadOf(await relay.xc_message({ to: 'b', msg: '打断', interrupt: true }, 'conn-a')) as Record<string, unknown>;
      const block = payload['interrupt'] as Record<string, unknown>;
      expect(sortedKeys(frozenInterrupt)).toEqual(sortedKeys(block));
      expect(frozenInterrupt['result']).toBe('deferred-next-turn');
      expect(block['result']).toBe('deferred-next-turn');
      expect(block['reason']).toBe(INTERRUPT_DEFERRED_REASON);
      expect(frozenInterrupt['envelope']).toBe('team-inbox');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('PROTOCOL §3 信封冻结形态：interrupt="true" 属性 + TEAM_INTERRUPT_BANNER 逐字节在场', () => {
    expect(PROTOCOL).toContain('interrupt="true"');
    expect(PROTOCOL).toContain(TEAM_INTERRUPT_BANNER);
    // 信封示例块里横幅紧跟开标签（渲染顺序冻结）。
    const at = PROTOCOL.indexOf(TEAM_INTERRUPT_BANNER);
    const openTag = PROTOCOL.lastIndexOf('<crosschat-team-message', at);
    expect(PROTOCOL.slice(openTag, at)).toContain('interrupt="true"');
  });

  it('RelayShape：冻结撤回请求 {to, withdrawMessageIds} 通过 zod（msg 撤回模式可省略）；msg 必填由运行时闸兜底', async () => {
    const schema = z.object(RelayShape);
    expect(schema.safeParse({ to: 'b', withdrawMessageIds: ['<messageId>'] }).success).toBe(true);
    expect(schema.safeParse({ to: 'b', withdrawMessageIds: [] }).success).toBe(false); // min(1)
    expect(schema.safeParse({ to: 'b', msg: '正文' }).success).toBe(true);
    // zod 层 msg 可选（撤回模式省略合法）；「无 withdraw 时 msg 必填」由 xc_message 运行时闸兜底。
    const workDir = mkdtempSync(join(tmpdir(), 'xc-contract-msgreq-'));
    try {
      const stateRoot = join(workDir, '.crosschat');
      const now = Date.now();
      const team = newTeamState({ teamId: 'default', founderKey: 'a', now });
      team.members.push(
        { key: 'a', sessionId: 'sess_a', role: 'peer', joinedAt: now, lastSeen: now },
        { key: 'b', sessionId: 'sess_b', role: 'worker', joinedAt: now, lastSeen: now },
      );
      await writeTeam(stateRoot, team);
      identityStore.bind('conn-a', {
        sessionKey: 'xc:default:a',
        teamId: 'default',
        name: 'a',
        agentKey: 'a',
        sessionId: 'sess_a',
        role: 'peer',
        boundAt: now,
      });
      const relay = createTeamRelayCore({ stateRoot, workspace: workDir, env: { XC_MESSAGING_DIR: join(workDir, 'peers') } });
      const bare = await relay.xc_message({ to: 'b' } as never, 'conn-a');
      expect(bare.isError).toBe(true);
      expect((payloadOf(bare) as Record<string, unknown>)['error']).toBe('invalid_params');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
    // 冻结请求键 ⊆ RelayShape（文档新增参数必须先落到工具面）。
    const frozenRequest = { to: '<成员名>', withdrawMessageIds: ['<messageId>'] };
    for (const key of Object.keys(frozenRequest)) {
      expect(Object.keys(RelayShape)).toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// 三面文档口径一致性（README / PROTOCOL / SKILL.md）
// ---------------------------------------------------------------------------

describe('v0.9 契约：README / PROTOCOL / SKILL.md 口径一致', () => {
  it('README 已知限制含 G-1 条目原句；xc_relay 参数行含 withdrawMessageIds', () => {
    expect(README).toContain('回合中注入为宿主层能力，插件侧上界=软中断');
    expect(README).toContain('withdrawMessageIds');
    expect(README).toContain('结构化 INTERRUPT 信封');
  });

  it('README 唤醒分层口径变更：引擎成员免开关，交互会话可选开启（旧口径已废止单声明）', () => {
    expect(README).toContain('引擎成员免开关，交互会话可选开启');
    expect(README).toContain('旧口径「团队自动开工必须开 wake_enabled」自 v0.9 废止');
  });

  it('v0.9.2 契约：README 已知限制 17/18/19 三条如实声明（V090-04/13/14）在场', () => {
    expect(README).toContain('engine.jsonl 审计可整体伪造（V090-04，不修行为）');
    expect(README).toContain('协议帧正文可伪装（V090-13，不修行为）');
    expect(README).toContain('撤回通知无频控（V090-14，不修行为）');
  });

  it('SKILL.md 安全点纪律 + withdrawal-notice 白名单（十二类）在场', () => {
    expect(SKILL).toContain('安全点纪律');
    expect(SKILL).toContain('withdrawal-notice');
    expect(SKILL).toContain('十二类协议帧');
    expect(SKILL).toContain('完成当前原子操作、不开新步骤');
  });

  it('PROTOCOL §2 白名单表含 withdrawal-notice 行；G-1 平台缺口声明在场', () => {
    expect(PROTOCOL).toContain('| `withdrawal-notice` |');
    expect(PROTOCOL).toContain('回合中注入');
    expect(PROTOCOL).toContain('插件侧可达上界');
  });

  it('v0.9.2 契约：撤回六值域（+notice）+ 通知无频控声明 + 帧白名单边界声明在场', () => {
    // §7.1 六值域（notice = 通知帧结构性不可撤，V090-10）。
    expect(PROTOCOL).toContain('`notice`（withdrawal-notice 帧，');
    expect(PROTOCOL).toContain('v0.9.2 起结构性不可撤');
    expect(PROTOCOL).toContain('通知无频控（v0.9.2 V090-14 如实声明，不修行为）');
    // §2 白名单边界（V090-04/V090-13 不修行为、如实声明）。
    expect(PROTOCOL).toContain('白名单的边界（v0.9.2 V090-04/V090-13 如实声明，不修行为）');
    // §10 审计非可信凭据（V090-04）。
    expect(PROTOCOL).toContain('审计与日志不是可信凭据（v0.9.2 V090-04 如实声明）');
    // §7 peer interrupt 冻结块 + dedup 优先级（V090-12）。
    expect(PROTOCOL).toContain('"envelope":"none"');
    expect(PROTOCOL).toContain('去重键纳入优先级差异（v0.9.2 V090-12 C 域）');
  });

  it('PROTOCOL §3 信封信任根口径（V090-13）：恒由消息元数据重建、透传守卫废除在场', () => {
    expect(PROTOCOL).toContain('恒由消息元数据重建');
    expect(PROTOCOL).toContain('stripForgedTeamEnvelopeMarkup');
    expect(PROTOCOL).toContain('原样透传');
  });
});
