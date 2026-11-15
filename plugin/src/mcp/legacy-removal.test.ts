/**
 * v0.7.0 M6 旧名移除回归（DESIGN-V0.7.md §7.2/§7.3/AC10）：
 *
 * - 22 个更名旧名（MIGRATION §1 表）逐个 tools/call → 标准错误
 *   `Tool <old> not found`（InvalidParams，server.ts dispatchPrimary 既有路径，
 *   不新码——v0.6 的 alias 弃用覆盖层已整文件删除）；
 * - `/xc-agents`、`/xc-member` 命令存根文件不存在（MIGRATION §3 承诺执行）；
 * - `xc_relay({forwardOf})` → `forwardOf_removed`（主路径守卫；alias 垫片删除后
 *   由 assertNoForwardOf 承担，防 zod object 默认 strip 静默丢参）；
 * - tools/list 仍恰 10 个（黑盒：内存 MCP server 全量注册后精确集合比较，
 *   口径同 v0.6.1 验收的 stdio tools/list——22-v061验收.md §六）；
 * - guards.ts 的 registerSecurityTools 死代码已删（模块无该导出；xc_inbound_review
 *   不进任何注册路径——由「恰 10」与旧名循环双重覆盖）；
 * - **模型可见面无旧名**（§7.2.1 全量 23 来源）：对 20 个 TS 来源跑字符串+注释
 *   扫描器（代码标识符如 core 层内部方法名 xc_message/xc_status 不在移除范围——
 *   DESIGN §7.3 明文排除；正则字面量与 TS 索引访问字符串 ToolCore["x"] 视为代码），
 *   对 2 个 skill 文件做全文扫描；另对导出的 prompt/渲染函数做值断言（双保险）；
 * - 扫描器自检：故意植入的旧名在字符串/注释里必须被抓到、在代码标识符/正则里必须放过。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { composeCore, resolveDeps, type PrimaryRegistry } from './core.js';
import { dispatchPrimary } from './server.js';
import { registerIdentifyTools } from './tools-identify.js';
import { registerTaskTools } from './tools-tasks.js';
import { registerReadTools } from './tools-read.js';
import { registerRelay } from './tools-relay.js';
import { registerOverviewTools } from './tools-overview.js';
import { registerTeamTools } from './tools-team.js';
import { registerReviewTools } from './tools-review.js';
import { registerDoctorTool } from './doctor-tool.js';
import * as guardsModule from './guards.js';
import { assertNoForwardOf } from './tools-relay.js';
import { MEMBER_RULES_V2, buildWakePrompt } from '../engine/wake.js';
import { buildWelcomePrompt } from '../engine/provision.js';
import { truncateNote } from '../core/budget.js';
import { renderPeerReplyInstruction, renderTeamEnvelope } from '../core/peerenvelope.js';
import { renderBoardTruncationNote } from './render.js';
import { notRegisteredError } from './protocol.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ROOT = join(SRC, '..');
const REPO_ROOT = join(PLUGIN_ROOT, '..');

/** MIGRATION §1 表逐行：22 个更名旧名（4 个同名保留工具不进本表）。 */
const OLD_NAMES = [
  'xc_register', 'xc_peer_register', 'xc_peer_rename', 'xc_check_inbox', 'xc_mail_read',
  'xc_task_read', 'xc_peer_inbox', 'xc_peer_read', 'xc_message', 'xc_peer_send',
  'xc_status', 'xc_peers', 'xc_agents', 'xc_team_init', 'xc_lead_transfer', 'xc_lead_release',
  'xc_member_add', 'xc_member_stop', 'xc_idle', 'xc_cancel', 'xc_inbound_review', 'xc_peer_review',
] as const;

/** v0.7 工具面（恰 10；黑盒核数用精确集合）。 */
const EXPECTED_TOOLS = [
  'xc_identify', 'xc_dispatch', 'xc_claim', 'xc_report', 'xc_read',
  'xc_relay', 'xc_overview', 'xc_team', 'xc_review', 'xc_doctor',
] as const;

/**
 * §7.2.1 的模型可见面来源：20 个 TS（A 类 16 可行动 + B 类 6 描述中的 5 个
 * 工具描述文件——xc_relay 的描述同文件）+ skills/crosschat/SKILL.md；
 * 另加 core/offline.ts（v0.7 新增 C8 模块，设计定稿时未列——其转交建议文案
 * 同样进 sweeper 通知与 overview 行，属模型可见面，一并纳入防回归）。
 * 纯文档 skill 走全文扫描；TS 走字符串+注释扫描器（见 scanModelVisible）。
 */
const TS_SOURCES = [
  'engine/wake.ts', 'engine/provision.ts',
  'hooks/session-start.ts', 'hooks/prompt-submit.ts',
  'core/peerenvelope.ts', 'core/budget.ts', 'core/teamstate.ts', 'core/offline.ts',
  'mcp/protocol.ts', 'mcp/tools-tasks.ts', 'mcp/render.ts', 'mcp/tools-relay.ts',
  'mcp/guards.ts', 'mcp/identity.ts', 'mcp/peer-services.ts',
  'mcp/tools-identify.ts', 'mcp/tools-team.ts', 'mcp/tools-review.ts',
  'mcp/tools-read.ts', 'mcp/tools-overview.ts',
] as const;
const SKILL_SOURCES = ['skills/crosschat/SKILL.md', 'skills/longtask/SKILL.md'] as const;

// ---------------------------------------------------------------------------
// 模型可见面扫描器：TS 源文本 → 字符串字面量 + 注释内容（会进模型上下文的文本面）
// ---------------------------------------------------------------------------

interface VisibleHit { name: string; line: number; kind: 'string' | 'comment' }

/**
 * 单趟状态机：code / line-comment / block-comment / string(" ' `) / regex-literal。
 * 排除三类代码位（设计明文不在移除范围或非文本面）：
 * 1. 代码标识符（core 层内部方法名 xc_message/xc_status/…——DESIGN §7.3）；
 * 2. 正则字面量（如 /[&<>"]/g——其中的引号不是字符串定界符）；
 * 3. TS 索引访问字符串（ToolCore["xc_message"] 的类型键，非运行时文本）。
 * 模板字面量的 ${…} 插值按代码处理（其中的标识符不收集）。
 */
function scanModelVisible(source: string, names: readonly string[]): VisibleHit[] {
  const hits: VisibleHit[] = [];
  const brackets: Array<{ indexed: boolean }> = [];
  const tplStack: number[] = []; // 模板 ${} 嵌套大括号深度
  type Frame = { k: 'code' } | { k: 'line' } | { k: 'block' } | { k: 'string'; q: string };
  const stack: Frame[] = [{ k: 'code' }];
  let lastSig = ''; // 最后一个有意义的代码字符（正则起点/索引访问判定用）
  let line = 1;
  const collect = (ch: string): void => {
    for (const name of names) {
      if (ch === name[0] && source.startsWith(name, i)) {
        hits.push({ name, line, kind: stack[stack.length - 1]!.k === 'string' ? 'string' : 'comment' });
      }
    }
  };
  let i = 0;
  const isRegexStart = (sig: string): boolean =>
    sig === '' || '=(,:;[!&|?{'.includes(sig) || sig === 'return' || sig === 'typeof';
  for (; i < source.length; i++) {
    const c = source[i]!;
    if (c === '\n') line++;
    const top = stack[stack.length - 1]!;
    if (top.k === 'line') {
      if (c === '\n') stack.pop();
      else collect(c);
      continue;
    }
    if (top.k === 'block') {
      if (c === '*' && source[i + 1] === '/') {
        collect('*'); collect('/'); i++; stack.pop();
      } else collect(c);
      continue;
    }
    if (top.k === 'string') {
      if (c === '\\') { collect(c); collect(source[i + 1] ?? ''); i++; continue; }
      if (top.q === '`' && c === '$' && source[i + 1] === '{') {
        tplStack.push(0); stack.push({ k: 'code' }); lastSig = '{'; i++; continue;
      }
      if (c === top.q) { stack.pop(); continue; }
      collect(c);
      continue;
    }
    // code 状态
    if (c === '/' && source[i + 1] === '/') { stack.push({ k: 'line' }); i++; continue; }
    if (c === '/' && source[i + 1] === '*') { stack.push({ k: 'block' }); i++; continue; }
    if (c === '/' && isRegexStart(lastSig)) {
      // 正则字面量：扫到未被转义的 `/`（字符类 [/] 内的斜杠不算结束）；内容按代码不收集。
      i++;
      let inClass = false;
      for (; i < source.length; i++) {
        const rc = source[i]!;
        if (rc === '\\') { i++; continue; }
        if (rc === '\n') break;
        if (rc === '[') inClass = true;
        else if (rc === ']') inClass = false;
        else if (rc === '/' && !inClass) break;
      }
      lastSig = '/';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const indexed = c === '"' && brackets.length > 0 && brackets[brackets.length - 1]!.indexed;
      if (indexed) {
        // 索引访问字符串（TS 类型键）：扫到闭合引号，内容不收集。
        for (i++; i < source.length; i++) {
          if (source[i] === '\\') { i++; continue; }
          if (source[i] === c) break;
        }
        lastSig = '"';
        continue;
      }
      stack.push({ k: 'string', q: c });
      continue;
    }
    if (c === '[') { brackets.push({ indexed: /[A-Za-z0-9_$\]\)]$/.test(lastSig) }); lastSig = '['; continue; }
    if (c === ']') { brackets.pop(); lastSig = ']'; continue; }
    if (c === '{') { if (tplStack.length > 0) tplStack[tplStack.length - 1]!++; lastSig = '{'; continue; }
    if (c === '}') {
      if (tplStack.length > 0) {
        const depth = tplStack[tplStack.length - 1]!;
        if (depth === 0) { tplStack.pop(); stack.pop(); lastSig = '}'; continue; }
        tplStack[tplStack.length - 1] = depth - 1;
        lastSig = '}';
        continue;
      }
      lastSig = '}';
      continue;
    }
    if (!/\s/.test(c)) lastSig = c;
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 测试体
// ---------------------------------------------------------------------------

describe('M6 旧名移除：未知名标准错误（22 个）', () => {
  it('22 个旧名逐个 → InvalidParams `Tool <old> not found`（dispatcher 既有路径）', async () => {
    const registry: PrimaryRegistry = new Map();
    for (const old of OLD_NAMES) {
      await expect(
        dispatchPrimary(registry, old, {}, undefined),
      ).rejects.toThrow(`Tool ${old} not found`);
    }
  });

  it('4 个同名保留工具不受影响（dispatch/claim/report/doctor 可注册可查）', async () => {
    const registry: PrimaryRegistry = new Map();
    for (const name of ['xc_dispatch', 'xc_claim', 'xc_report', 'xc_doctor']) {
      registry.set(name, { description: 'stub', shape: {}, handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }) });
      await expect(dispatchPrimary(registry, name, {}, undefined)).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });
    }
  });
});

describe('M6 旧名移除：命令存根与死代码', () => {
  it('/xc-agents、/xc-member 命令文件不存在（MIGRATION §3 承诺执行）', () => {
    expect(existsSync(join(PLUGIN_ROOT, 'commands', 'xc-agents.md'))).toBe(false);
    expect(existsSync(join(PLUGIN_ROOT, 'commands', 'xc-member.md'))).toBe(false);
    // 保留的 6 个命令仍在（不误删新名路径）。
    for (const cmd of ['xc-work', 'xc-dispatch', 'xc-inbox', 'xc-status', 'xc-team', 'xc-say']) {
      expect(existsSync(join(PLUGIN_ROOT, 'commands', `${cmd}.md`))).toBe(true);
    }
  });

  // v0.8.0（AC6「命令 8 个」）：把「命令面恰 8」从文档走查变成硬断言——
  // v0.7 的 6 个 + v0.8 新增的 /xc-checkpoint、/xc-handoff；多一个存根/少一个都红。
  it('命令面恰 8 个 .md（v0.8.0 起 6 → 8；不含已删存根）', () => {
    const files = readdirSync(join(PLUGIN_ROOT, 'commands')).filter((f) => f.endsWith('.md')).sort();
    expect(files).toEqual([
      'xc-checkpoint.md', 'xc-dispatch.md', 'xc-handoff.md', 'xc-inbox.md',
      'xc-say.md', 'xc-status.md', 'xc-team.md', 'xc-work.md',
    ]);
  });

  it('guards.ts 死代码已删：模块无 registerSecurityTools / InboundReviewShape 导出', () => {
    const keys = Object.keys(guardsModule);
    expect(keys).not.toContain('registerSecurityTools');
    expect(keys).not.toContain('InboundReviewShape');
    // withGuards 主契约仍在（合法流程保护：removed 硬拒 + 入站策略）。
    expect(keys).toContain('withGuards');
  });
});

describe('M6 旧名移除：xc_relay forwardOf 主路径守卫', () => {
  it('assertNoForwardOf：带 forwardOf 显式抛 forwardOf_removed（不静默丢参）', () => {
    expect(() => assertNoForwardOf({ forwardOf: 'm1' })).toThrow(/forwardOf_removed/);
    expect(() => assertNoForwardOf({ to: 'b', msg: 'x' })).not.toThrow();
  });

  it('xc_relay handler 主路径：forwardOf 先于 zod strip 被拒', async () => {
    let captured: ((args: Record<string, unknown>, extra: unknown) => Promise<unknown>) | undefined;
    const fakeServer = {
      tool: (_n: string, _d: string, _s: unknown, handler: (a: Record<string, unknown>, e: unknown) => Promise<unknown>) => {
        captured = handler;
      },
    } as unknown as McpServer;
    const workDir = mkdtempSync(join(tmpdir(), 'xc-legacy-relay-'));
    try {
      const deps = resolveDeps(workDir, { XC_MESSAGING_DIR: join(workDir, 'peers'), XC_WAKE_ENABLED: 'false' } as NodeJS.ProcessEnv);
      registerRelay(fakeServer, deps);
      expect(captured).toBeDefined();
      await expect(captured!({ to: 'b', msg: '正文', forwardOf: 'm1' }, {})).rejects.toThrow(/forwardOf_removed/);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe('M6 旧名移除：工具面恰 10 + 描述无旧名（黑盒 tools/list）', () => {
  let workDir = '';
  let client: Client | undefined;
  let server: McpServer | undefined;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'xc-legacy-toolface-'));
    const deps = resolveDeps(workDir, {
      XC_MESSAGING_DIR: join(workDir, 'peers-root'),
      XC_WAKE_ENABLED: 'false',
    } as NodeJS.ProcessEnv);
    const core = composeCore(deps);
    const registry: PrimaryRegistry = new Map();
    server = new McpServer({ name: 'zcode-crosschat', version: '0.7.0' });
    registerIdentifyTools(server, deps, core, registry);
    registerTaskTools(server, deps, core, registry);
    registerReadTools(server, deps, core, registry);
    registerRelay(server, deps, core, registry);
    registerOverviewTools(server, deps, core, registry);
    registerTeamTools(server, deps, core, registry);
    registerReviewTools(server, deps, core, registry);
    registerDoctorTool(server, { version: '0.7.0', env: deps.env, cwd: workDir });
    registry.set('xc_doctor', {
      description: 'Read-only self check (test stub).',
      shape: {},
      handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'legacy-removal-test', version: '0.7.0' });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    if (workDir !== '') rmSync(workDir, { recursive: true, force: true });
  });

  it('tools/list 精确集合 = 恰 10 个新名（顺序不敏感；无别名泄漏）', async () => {
    const listed = await client!.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
    // 22 个旧名与 xc_inbound_review 都不在 tools/list（黑盒）。
    for (const old of OLD_NAMES) expect(names).not.toContain(old);
  });

  // v0.7 集成复核（MIGRATION §5-3/§6 的「运行时信封」如实口径）：alias 覆盖层删除后，
  // 未知名不再经 dispatchPrimary 中转，而由 MCP SDK 自带的未注册工具分支处理——
  // 抛 McpError(InvalidParams, "Tool <name> not found")，McpServer 再包成标准工具错误结果
  // （result.isError=true，正文 "MCP error -32602: Tool <name> not found"）。错误码与消息
  // 文本与 v0.6.1 的 JSON-RPC error 信封一致，只是信封形态不同（两者都是 MCP 规范内的
  // 标准未知错误）。此处按**真实运行时信封**逐名断言，补 dispatcher 直驱单测覆盖不到的面。
  it('22 个旧名逐个 tools/call → 运行时标准未知错误（isError + -32602 + 同名消息）', async () => {
    for (const old of OLD_NAMES) {
      const res = (await client!.callTool({ name: old, arguments: {} })) as unknown as {
        isError?: boolean;
        content?: Array<{ type: string; text?: string }>;
      };
      expect(res.isError, `${old} 应得 isError 信封`).toBe(true);
      const text = (res.content ?? []).map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n');
      expect(text, `${old} 的错误正文`).toBe(`MCP error -32602: Tool ${old} not found`);
    }
  });

  it('10 个工具描述不含 22 个旧名（B 类 replaces 文案已清）', async () => {
    const listed = await client!.listTools();
    for (const tool of listed.tools) {
      const description = tool.description ?? '';
      for (const old of OLD_NAMES) {
        expect(description).not.toContain(old);
      }
      expect(description.length).toBeGreaterThan(0);
    }
  });
});

describe('M6 旧名移除：模型可见面无旧名（§7.2.1 全量 23 来源）', () => {
  it('21 个 TS 来源的字符串+注释无 22 旧名（扫描器；代码标识符/正则/索引访问除外）', () => {
    for (const rel of TS_SOURCES) {
      const source = readFileSync(join(SRC, rel), 'utf8');
      const hits = scanModelVisible(source, OLD_NAMES);
      expect(hits, `${rel} 仍含旧名：${hits.map((h) => `${h.name}@${h.line}(${h.kind})`).join(', ')}`).toEqual([]);
    }
  });

  it('2 个 skill 文件全文无 22 旧名（模型会加载的内容）', () => {
    for (const rel of SKILL_SOURCES) {
      const text = readFileSync(join(PLUGIN_ROOT, rel), 'utf8');
      for (const old of OLD_NAMES) {
        expect(text, `${rel} 仍含旧名 ${old}`).not.toContain(old);
      }
    }
  });

  it('导出的 prompt/渲染函数值断言（双保险：运行时文本面无旧名）', () => {
    const surfaces: Array<[string, string]> = [
      ['MEMBER_RULES_V2', MEMBER_RULES_V2],
      ['buildWelcomePrompt', buildWelcomePrompt({ teamId: 'default', key: 'a', sessionId: 's1', wakeToken: 'tok' })],
      ['buildWakePrompt', buildWakePrompt({
        teamId: 'default', recipientKey: 'b', recipientSessionId: 's2', wakeToken: 'tok',
        receiptIds: ['m1'], bodyText: '正文', includeMemberRules: true,
      })],
      ['truncateNote(peer)', truncateNote('peer', 'm1', 1, 9)],
      ['truncateNote(mail)', truncateNote('mail', 'm1', 1, 9)],
      ['renderPeerReplyInstruction', renderPeerReplyInstruction('alice')],
      ['renderTeamEnvelope', renderTeamEnvelope({ frameType: 'chat', from: 'alice', content: 'hi' })],
      ['renderBoardTruncationNote', renderBoardTruncationNote(3, 40, 2500)],
      ['notRegisteredError', notRegisteredError().message],
    ];
    for (const [label, text] of surfaces) {
      for (const old of OLD_NAMES) {
        expect(text, `${label} 仍含旧名 ${old}`).not.toContain(old);
      }
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it('扫描器自检：字符串/注释里的旧名必须抓到，代码标识符/正则/索引访问必须放过', () => {
    const fixture = [
      'const a = "xc_status lives in a string";',
      "const b = 'xc_idle in single quotes';",
      'const c = `xc_peers in template`;',
      '// xc_agents in a line comment',
      '/* xc_team_init in a block comment */',
      'const d: ToolCore["xc_message"] = core.xc_check_inbox as never;', // 索引访问 + 代码标识符
      'const e = /[&<>"]/g;',                                          // 正则字面量（含引号）
      'const f = "plain text";',
    ].join('\n');
    const found = new Set(scanModelVisible(fixture, OLD_NAMES).map((h) => h.name));
    expect(found).toEqual(new Set(['xc_status', 'xc_idle', 'xc_peers', 'xc_agents', 'xc_team_init']));
    expect(found.has('xc_message')).toBe(false);
    expect(found.has('xc_check_inbox')).toBe(false);
  });
});

describe('M6 旧名移除：MIGRATION/README 同步（无「待移除」残留）', () => {
  it('MIGRATION.md 标注 v0.7.0 已移除 + 未知名标准错误口径', () => {
    const text = readFileSync(join(REPO_ROOT, 'docs', 'MIGRATION.md'), 'utf8');
    expect(text).toContain('v0.7.0 已移除');
    expect(text).toContain('Tool <name> not found');
  });

  it('README.md 版本记录含 v0.7.0 条目', () => {
    const text = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    expect(text).toContain('v0.7.0');
  });
});
