/**
 * v0.7 C6（M1）单测：core/toolrelay.ts —— C6 帧编解码与发送侧校验纯函数。
 *
 * 覆盖面（DESIGN-V0.7 §2.2/§2.4 + E4 §5 字段草案）：
 * - parseToolFrameType：4 帧型识别、kind 键（E4 权宜）/chat/非对象 JSON 不识别；
 * - checkToolRequestFrame：形状全矩阵（requestId 路径安全/from=发送者/args≤64K/
 *   reason 必填/approval.required/ttl 硬顶/maxResultChars 顶）；
 * - checkToolResultFrame：requestId/from=执行方/tool 逐字节/状态机前置（未放行拒）/
 *   结果 ≤ maxResultChars/status-载荷配对；
 * - 插件侧帧构造（门拒回投/审批通知与回执）；
 * - toolRequestTtlMsFromEnv：缺省/非法/超硬顶钳制。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_RESULT_CHARS,
  DEFAULT_TOOL_REQUEST_TTL_MS,
  MAX_TOOL_REQUEST_TTL_MS,
  TOOL_REQUEST_MAX_ARGS_CHARS,
  TOOL_REQUEST_WAKE_SUPPRESSION_NOTE,
  buildApprovalRequest,
  buildApprovalResult,
  buildRefusedToolResult,
  checkToolRequestFrame,
  checkToolResultFrame,
  isToolFrameType,
  parseToolFrameType,
  toolResultPayloadChars,
  toolRequestTtlMsFromEnv,
  type ToolRequestFrame,
  type ToolResultLedgerView,
} from './toolrelay.js';

function requestFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'tool_request',
    requestId: '11111111-2222-4333-8444-555555555555',
    from: 'bee',
    tool: 'mcp__plugin_zcx-probe_zcxprobe__probe_ping',
    args: { echo: 'hi' },
    reason: 'B 缺该 MCP（宿主注入类），请 A 代执行',
    approval: { required: true },
    ...overrides,
  });
}

describe('toolrelay v0.7: 帧型识别', () => {
  it('4 个 C6/C7 帧型按 type 键识别', () => {
    expect(parseToolFrameType(JSON.stringify({ type: 'tool_request' }))).toBe('tool_request');
    expect(parseToolFrameType(JSON.stringify({ type: 'tool_result' }))).toBe('tool_result');
    expect(parseToolFrameType(JSON.stringify({ type: 'approval_request' }))).toBe('approval_request');
    expect(parseToolFrameType(JSON.stringify({ type: 'approval_result' }))).toBe('approval_result');
    expect(isToolFrameType('tool_request')).toBe(true);
    expect(isToolFrameType('task-receipt')).toBe(false);
  });

  it('E4 原型的 kind 键不识别（落地必须 type 键——白名单才生效）', () => {
    expect(parseToolFrameType(JSON.stringify({ kind: 'tool_request' }))).toBeUndefined();
  });

  it('chat / 非对象 JSON / 坏 JSON → undefined', () => {
    expect(parseToolFrameType('普通文本')).toBeUndefined();
    expect(parseToolFrameType('[1,2,3]')).toBeUndefined();
    expect(parseToolFrameType('{oops')).toBeUndefined();
    expect(parseToolFrameType(JSON.stringify({ type: 42 }))).toBeUndefined();
  });
});

describe('toolrelay v0.7: tool_request 发送侧校验', () => {
  it('合法帧通过并带出生效 ttl/maxResultChars', () => {
    const check = checkToolRequestFrame(requestFrame(), 'bee', DEFAULT_TOOL_REQUEST_TTL_MS);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.frame.ttlMs).toBe(DEFAULT_TOOL_REQUEST_TTL_MS);
    expect(check.frame.maxResultChars).toBe(DEFAULT_MAX_RESULT_CHARS);
    expect(check.frame.frame.approval).toEqual({ required: true });
    expect(check.frame.approvalFile).toBeUndefined();
  });

  it('帧值 ttl/maxResultChars/approval.file 透传', () => {
    const check = checkToolRequestFrame(
      requestFrame({ approval: { required: true, file: 'C:/ws/.crosschat/approvals/x.json', ttlMs: 60_000 }, maxResultChars: 1000 }),
      'bee',
      DEFAULT_TOOL_REQUEST_TTL_MS,
    );
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.frame.ttlMs).toBe(60_000);
    expect(check.frame.maxResultChars).toBe(1000);
    expect(check.frame.approvalFile).toBe('C:/ws/.crosschat/approvals/x.json');
  });

  it('requestId 路径穿越/非法形态拒（台账与审批文件名安全）', () => {
    for (const bad of ['../../evil', 'a/b', 'a\\b', '.hidden', '', 'x'.repeat(129), 'has space']) {
      const check = checkToolRequestFrame(requestFrame({ requestId: bad }), 'bee', DEFAULT_TOOL_REQUEST_TTL_MS);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.error).toBe('invalid_request_id');
    }
  });

  it('from 必须 === 发送者身份（防冒充请求方）', () => {
    const check = checkToolRequestFrame(requestFrame({ from: 'aye' }), 'bee', DEFAULT_TOOL_REQUEST_TTL_MS);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toBe('tool_request_from_mismatch');
  });

  it('args 序列化 > 64KB → args_too_large（E4 §6.1 无闸缺口的闭合）', () => {
    const big = { blob: 'x'.repeat(TOOL_REQUEST_MAX_ARGS_CHARS) };
    const check = checkToolRequestFrame(requestFrame({ args: big }), 'bee', DEFAULT_TOOL_REQUEST_TTL_MS);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toBe('args_too_large');
    const exact = { blob: 'x'.repeat(TOOL_REQUEST_MAX_ARGS_CHARS - '{"blob":""}'.length) };
    expect(checkToolRequestFrame(requestFrame({ args: exact }), 'bee', DEFAULT_TOOL_REQUEST_TTL_MS).ok).toBe(true);
  });

  it('args 非对象 / reason 缺失 / approval.required≠true / ttl 超硬顶 / maxResultChars 超顶', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ args: 'not-an-object' }, 'invalid_frame'],
      [{ args: [1, 2] }, 'invalid_frame'],
      [{ reason: '  ' }, 'invalid_frame'],
      [{ approval: { required: false } }, 'invalid_frame'],
      [{ approval: undefined }, 'invalid_frame'],
      [{ approval: { required: true, ttlMs: MAX_TOOL_REQUEST_TTL_MS + 1 } }, 'ttl_exceeds_cap'],
      [{ approval: { required: true, ttlMs: -5 } }, 'invalid_frame'],
      [{ maxResultChars: DEFAULT_MAX_RESULT_CHARS + 1 }, 'result_cap_exceeded'],
      [{ maxResultChars: 0 }, 'invalid_frame'],
      [{ tool: '' }, 'invalid_frame'],
      [{ approval: { required: true, file: 42 } }, 'invalid_frame'],
    ];
    for (const [overrides, error] of cases) {
      const check = checkToolRequestFrame(requestFrame(overrides), 'bee', DEFAULT_TOOL_REQUEST_TTL_MS);
      expect(check.ok, JSON.stringify(overrides)).toBe(false);
      if (!check.ok) expect(check.error, JSON.stringify(overrides)).toBe(error);
    }
  });

  it('非 JSON / 非 tool_request type → invalid_frame', () => {
    expect(checkToolRequestFrame('{oops', 'bee', DEFAULT_TOOL_REQUEST_TTL_MS).ok).toBe(false);
    const wrongType = checkToolRequestFrame(JSON.stringify({ type: 'tool_result', requestId: 'x' }), 'bee', DEFAULT_TOOL_REQUEST_TTL_MS);
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) expect(wrongType.error).toBe('invalid_frame');
  });
});

describe('toolrelay v0.7: tool_result 发送侧校验', () => {
  const ledger: ToolResultLedgerView = {
    requestId: '11111111-2222-4333-8444-555555555555',
    from: 'bee',
    to: 'aye',
    tool: 'mcp__plugin_zcx-probe_zcxprobe__probe_ping',
    state: 'approved',
    maxResultChars: 64_000,
  };

  function resultFrame(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      type: 'tool_result',
      requestId: ledger.requestId,
      from: 'aye',
      status: 'ok',
      tool: ledger.tool,
      result: { pid: 27168, ppid: 40988 },
      ts: 1794681345958,
      ...overrides,
    });
  }

  it('合法回投通过', () => {
    const check = checkToolResultFrame(resultFrame(), 'aye', ledger);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.frame.result).toEqual({ pid: 27168, ppid: 40988 });
  });

  it('伪造回投：from ≠ 台账.to → tool_result_from_mismatch（不落箱不终填）', () => {
    const check = checkToolResultFrame(resultFrame({ from: 'bee' }), 'bee', ledger);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toBe('tool_result_from_mismatch');
  });

  it('requestId 不匹配 / tool 不匹配 / 状态枚举外 / 载荷键缺失', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ requestId: 'other' }, 'requestId_mismatch'],
      [{ tool: 'mcp__other__tool' }, 'tool_mismatch'],
      [{ status: 'done' }, 'invalid_frame'],
      [{ status: 'ok' }, 'invalid_frame'], // 去掉 result 键后
      [{ status: 'error', result: undefined }, 'invalid_frame'],
      [{ status: 'refused', reason: undefined }, 'invalid_frame'],
    ];
    for (const [overrides, error] of cases) {
      const frame = overrides['status'] === 'ok' && overrides['result'] === undefined
        ? JSON.stringify({ type: 'tool_result', requestId: ledger.requestId, from: 'aye', status: 'ok', tool: ledger.tool, ts: 1 })
        : resultFrame(overrides);
      const check = checkToolResultFrame(frame, 'aye', ledger);
      expect(check.ok, JSON.stringify(overrides)).toBe(false);
      if (!check.ok) expect(check.error, JSON.stringify(overrides)).toBe(error);
    }
  });

  it('台账未放行（pending/denied/refused/expired）→ request_not_approved', () => {
    for (const state of ['pending', 'denied', 'refused', 'expired'] as const) {
      const check = checkToolResultFrame(resultFrame(), 'aye', { ...ledger, state });
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.error).toBe('request_not_approved');
    }
  });

  it('台账已终态（executed/error）→ request_already_finalized（一请求一结果）', () => {
    for (const state of ['executed', 'error'] as const) {
      const check = checkToolResultFrame(resultFrame(), 'aye', { ...ledger, state });
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.error).toBe('request_already_finalized');
    }
  });

  it('result 序列化 > maxResultChars → result_too_large', () => {
    const check = checkToolResultFrame(resultFrame({ result: { blob: 'x'.repeat(70_000) } }), 'aye', ledger);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toBe('result_too_large');
  });

  it('refused/error 回投也要求状态已放行且载荷键正确', () => {
    expect(checkToolResultFrame(resultFrame({ status: 'refused', result: undefined, reason: 'approval missing' }), 'aye', ledger).ok).toBe(true);
    expect(checkToolResultFrame(resultFrame({ status: 'error', result: undefined, error: 'No such tool available: x' }), 'aye', ledger).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// v0.7.2 复验（P3 修复）：B-03 result 限额按有效载荷口径（不再把 JSON 引号计入）
// ---------------------------------------------------------------------------

describe('toolrelay v0.7.2 (B-03): result 限额按有效载荷计', () => {
  const cappedLedger: ToolResultLedgerView = {
    requestId: '11111111-2222-4333-8444-555555555555',
    from: 'bee',
    to: 'aye',
    tool: 'mcp__plugin_zcx-probe_zcxprobe__probe_ping',
    state: 'approved',
    maxResultChars: 64_000,
  };

  function frame(result: unknown, maxResultChars = 64_000): string {
    return JSON.stringify({
      type: 'tool_result',
      requestId: cappedLedger.requestId,
      from: 'aye',
      status: 'ok',
      tool: cappedLedger.tool,
      result,
      ts: 1794681345958,
    });
  }

  const capped = (maxResultChars: number): ToolResultLedgerView => ({ ...cappedLedger, maxResultChars });

  it('toolResultPayloadChars：字符串取自身长度；对象/数组/数字取序列化长度', () => {
    expect(toolResultPayloadChars('x'.repeat(1000))).toBe(1000);
    expect(toolResultPayloadChars('')).toBe(0);
    expect(toolResultPayloadChars({ pid: 1 })).toBe(JSON.stringify({ pid: 1 }).length);
    expect(toolResultPayloadChars([1, 2])).toBe(5);
    expect(toolResultPayloadChars(null)).toBe(4);
    expect(toolResultPayloadChars(42)).toBe(2);
    // 循环引用 → Infinity（调用方按超限处理，不抛）。
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(toolResultPayloadChars(cyclic)).toBe(Number.POSITIVE_INFINITY);
  });

  it('字符串结果恰好等于限值 → 放行（旧实现按序列化长度 = 限值+2 拒）', () => {
    // 红队裁决 b03.jsonl：1000 字符 result vs 限 1000 → result_too_large
    // 「serializes to 1002 chars (limit 1000)」。
    const limit = capped(1000);
    const check = checkToolResultFrame(frame('x'.repeat(1000)), 'aye', limit);
    expect(check.ok).toBe(true);
    const over = checkToolResultFrame(frame('x'.repeat(1001)), 'aye', limit);
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.error).toBe('result_too_large');
      expect(over.message).toContain('payload is 1001 chars (limit 1000)');
    }
  });

  it('非字符串结果仍按序列化长度计（语义不变）', () => {
    const limit = capped(100);
    const ok = checkToolResultFrame(frame({ blob: 'z'.repeat(89) }), 'aye', limit);
    expect(ok.ok).toBe(true); // {"blob":"z"×89} = 100 字符（9 + 89 + 2）
    const over = checkToolResultFrame(frame({ blob: 'z'.repeat(90) }), 'aye', limit);
    expect(over.ok).toBe(false); // 101 字符
    expect(over.ok).toBe(false);
  });

  it('缺省上限 64000：64000 字符字符串结果恰好等于限值 → 放行', () => {
    const check = checkToolResultFrame(frame('y'.repeat(64_000)), 'aye', cappedLedger);
    expect(check.ok).toBe(true);
  });
});

describe('toolrelay v0.7: 插件侧帧构造与 env 阈值', () => {
  it('buildRefusedToolResult / buildApprovalRequest / buildApprovalResult', () => {
    expect(buildRefusedToolResult('r1', 't', 'aye', 'approval missing', 123)).toEqual({
      type: 'tool_result', requestId: 'r1', from: 'aye', status: 'refused', tool: 't', reason: 'approval missing', ts: 123,
    });
    const req = buildApprovalRequest('r1', 'bee', 't', 'why', 999, 'how');
    expect(req).toMatchObject({ type: 'approval_request', requestId: 'r1', from: 'bee', expiresAt: 999, approveHow: 'how' });
    expect(buildApprovalResult('r1', 'approved', 'lead', 5, 500)).toEqual({
      type: 'approval_result', requestId: 'r1', decision: 'approved', decidedBy: 'lead', decidedAt: 5, expiresAt: 500,
    });
    expect(buildApprovalResult('r1', 'expired', 'engine', 5)).not.toHaveProperty('expiresAt');
  });

  it('toolRequestTtlMsFromEnv：缺省 1h；非法回落；超硬顶钳制（env 只能改缺省）', () => {
    expect(toolRequestTtlMsFromEnv({})).toBe(DEFAULT_TOOL_REQUEST_TTL_MS);
    expect(toolRequestTtlMsFromEnv({ XC_TOOL_REQUEST_TTL_MS: '120000' })).toBe(120_000);
    expect(toolRequestTtlMsFromEnv({ XC_TOOL_REQUEST_TTL_MS: 'abc' })).toBe(DEFAULT_TOOL_REQUEST_TTL_MS);
    expect(toolRequestTtlMsFromEnv({ XC_TOOL_REQUEST_TTL_MS: '-1' })).toBe(DEFAULT_TOOL_REQUEST_TTL_MS);
    expect(toolRequestTtlMsFromEnv({ XC_TOOL_REQUEST_TTL_MS: '999999999' })).toBe(MAX_TOOL_REQUEST_TTL_MS);
  });

  it('wake 禁令标注常量（§2.2 payload 文案）', () => {
    expect(TOOL_REQUEST_WAKE_SUPPRESSION_NOTE).toBe('suppressed (approval-gate bypass guard)');
  });

  it('ToolRequestFrame 形状自洽（类型层面编译期保证，运行时抽查）', () => {
    const check = checkToolRequestFrame(requestFrame(), 'bee', DEFAULT_TOOL_REQUEST_TTL_MS);
    if (!check.ok) throw new Error('expected ok');
    const frame: ToolRequestFrame = check.frame.frame;
    expect(frame.type).toBe('tool_request');
    expect(frame.from).toBe('bee');
  });
});
