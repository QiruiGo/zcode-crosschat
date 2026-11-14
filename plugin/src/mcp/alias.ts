/**
 * v0.6 工具面收敛：旧名→新名弃用覆盖层（DESIGN-V0.6.md §1.3）。
 * 机制依据（本会话实测 SDK 1.32.2）：Protocol.setRequestHandler 以 method 字面量
 * Map.set 整体替换（dist/esm/shared/protocol.js）；McpServer 在构造期装好的
 * CallTool 处理器（dist/esm/server/mcp.js:150）被本覆盖层替换后，tools/list 仍由
 * McpServer 自家的 ListTools 处理器应答（:117）——它只读 server.tool() 注册的 10 个
 * 新名。旧名不注册、仅可在调用侧触达。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

export interface AliasEntry {
  /** 新工具名。 */
  target: string;
  /** 旧参 → 新参；返回 [shape, ignoredKeys]。 */
  mapArgs: (old: Record<string, unknown>) => { args: Record<string, unknown>; ignored: string[] };
  /** 额外固定字段（如 scope/view/action/axis）。 */
  fixed?: Record<string, unknown>;
}

const id = (k: string) => (o: Record<string, unknown>) => ({ args: { [k]: o[k] }, ignored: rest(o, [k]) });

// 仅收录「更名」的 22 个旧名；xc_dispatch/xc_claim/xc_report/xc_doctor 四个同名工具
// 不进本表（dispatcher 按 PRIMARY 正常分发）。
// 纪律（M1 修复）：每条目的 ignored 必须 = rest(o, 全部已消费键含被改名键)——
// 任何未被映射的旧参数一律显式披露，禁止静默丢弃（复核 M1：xc_message 的
// forwardOf 曾被静默丢参——v0.6 起由 relay 轴守卫显式报 forwardOf_removed）。
export const ALIASES: Record<string, AliasEntry> = {
  xc_register:        { target: "xc_identify", mapArgs: (o) => ({ args: pick(o, ["name", "sessionId", "role", "wakeToken"]), ignored: rest(o, ["name", "sessionId", "role", "wakeToken"]) }) },
  xc_peer_register:   { target: "xc_identify", mapArgs: (o) => ({ args: pick(o, ["name", "sessionId", "displayName", "kind", "modeClass", "contextChars"]), ignored: rest(o, ["name", "sessionId", "displayName", "kind", "modeClass", "contextChars"]) }) },
  // 改名：DESIGN 表只映射 name；superset——调用方带了 sessionId 一并透传（xc_identify 的
  // sessionId 必填；纯旧参（只有 name）的 rename 调用会得 invalid_params，MIGRATION 注明
  // 「rename 旧调用需补 sessionId」）。
  xc_peer_rename:     { target: "xc_identify", mapArgs: (o) => ({ args: pick(o, ["name", "sessionId"]), ignored: rest(o, ["name", "sessionId"]) }) },
  xc_check_inbox:     { target: "xc_read",     mapArgs: (o) => ({ args: {}, ignored: rest(o, []) }), fixed: { scope: "inbox" } },
  xc_mail_read:       { target: "xc_read",     mapArgs: (o) => ({ args: pick(o, ["offset", "limit"], { id: o.messageId }), ignored: rest(o, ["messageId", "offset", "limit"]) }), fixed: { scope: "mail" } },
  xc_task_read:       { target: "xc_read",     mapArgs: (o) => ({ args: pick(o, ["field", "offset", "limit"], { id: o.taskId }), ignored: rest(o, ["taskId", "field", "offset", "limit"]) }), fixed: { scope: "task" } },
  xc_peer_inbox:      { target: "xc_read",     mapArgs: (o) => ({ args: pick(o, ["limit"]), ignored: rest(o, ["limit"]) }), fixed: { scope: "peer" } },
  xc_peer_read:       { target: "xc_read",     mapArgs: (o) => ({ args: pick(o, ["offset", "limit"], { id: o.msgId }), ignored: rest(o, ["msgId", "offset", "limit"]) }), fixed: { scope: "peer-msg" } },
  xc_message:         { target: "xc_relay",    mapArgs: (o) => ({ args: pick(o, ["to", "summary", "sourceTaskId", "sourceAttemptId"], { msg: o.content }), ignored: rest(o, ["content", "to", "summary", "sourceTaskId", "sourceAttemptId"]) }) },
  // message→msg 改名（DESIGN §1.3 表该行的参数映射；§4.2-M1 注记①的五处改名纪律）。
  xc_peer_send:       { target: "xc_relay",    mapArgs: (o) => ({ args: pick(o, ["to", "summary"], { msg: o.message }), ignored: rest(o, ["to", "summary", "message"]) }) },
  xc_status:          { target: "xc_overview", mapArgs: (o) => ({ args: pick(o, ["history", "offset"]), ignored: rest(o, ["history", "offset"]) }), fixed: { view: "team" } },
  xc_peers:           { target: "xc_overview", mapArgs: (o) => ({ args: {}, ignored: rest(o, []) }), fixed: { view: "peers" } },
  xc_agents:          { target: "xc_overview", mapArgs: (o) => ({ args: {}, ignored: rest(o, []) }), fixed: { view: "panel" } },
  xc_team_init:       { target: "xc_team",     mapArgs: (o) => ({ args: pick(o, ["takeover"]), ignored: rest(o, ["takeover"]) }), fixed: { action: "init" } },
  xc_lead_transfer:   { target: "xc_team",     mapArgs: (o) => ({ args: pick(o, ["to", "reason"]), ignored: rest(o, ["to", "reason"]) }), fixed: { action: "transfer" } },
  xc_lead_release:    { target: "xc_team",     mapArgs: (o) => ({ args: {}, ignored: rest(o, []) }), fixed: { action: "release" } },
  xc_member_add:      { target: "xc_team",     mapArgs: (o) => ({ args: pick(o, ["name", "model", "reasoningLevel", "note"], { contextChars: o.context }), ignored: rest(o, ["name", "model", "reasoningLevel", "note", "context"]) }), fixed: { action: "member-add" } },
  xc_member_stop:     { target: "xc_team",     mapArgs: (o) => ({ args: pick(o, ["name", "reason", "archive"]), ignored: rest(o, ["name", "reason", "archive"]) }), fixed: { action: "member-stop" } },
  xc_idle:            { target: "xc_team",     mapArgs: (o) => ({ args: pick(o, ["summary", "idleReason", "completedTaskId", "completedStatus", "failureReason", "result"]), ignored: rest(o, ["summary", "idleReason", "completedTaskId", "completedStatus", "failureReason", "result"]) }), fixed: { action: "idle" } },
  xc_cancel:          { target: "xc_team",     mapArgs: id("taskId"), fixed: { action: "cancel" } },
  xc_inbound_review:  { target: "xc_review",   mapArgs: (o) => ({ args: pick(o, ["action", "ids"]), ignored: rest(o, ["action", "ids"]) }), fixed: { axis: "team" } },
  xc_peer_review:     { target: "xc_review",   mapArgs: (o) => ({ args: pick(o, ["action", "ids"]), ignored: rest(o, ["action", "ids"]) }), fixed: { axis: "peer" } },
};

export const DEPRECATION_NOTE = (oldName: string, t: AliasEntry) =>
  `[DEPRECATED] ${oldName} 已更名为 ${t.target}（v0.7.0 移除）。本次调用已正常执行。迁移表见 docs/MIGRATION.md。`;

/** 安装覆盖层：必须在全部 server.tool() 注册之后、connect 之前调用。
 *  L1 纪律：extra 必须原样透传给 dispatcher——connectionKeyOf(extra)（identity.ts:106-108）
 *  是身份绑定的锚，丢掉 extra = 别名路径全部 notRegistered。 */
export function installAliasLayer(
  server: McpServer,
  dispatch: (name: string, args: Record<string, unknown>, extra: unknown) => Promise<unknown>,
): void {
  const underlying = (server as unknown as { server: { setRequestHandler: (s: unknown, h: unknown) => void } }).server;
  underlying.setRequestHandler(CallToolRequestSchema, async (request: {
    params: { name: string; arguments?: Record<string, unknown> };
  }, extra: unknown) => {
    const name = request.params.name;
    const rawArgs = request.params.arguments ?? {};
    if (ALIASES[name] === undefined) {
      // 新名与未知名都交回统一 dispatcher（新名正常执行；未知名抛标准错误）。
      return await dispatch(name, rawArgs, extra);
    }
    const alias = ALIASES[name];
    // M1 纪律：forwardOf 在两个 relay 别名（xc_message/xc_peer_send）上都显式报错，
    // 不许静默丢参——旧 MessageShape（tools.ts:153-159）与 PeerSendShape 都有 forwardOf。
    if (alias.target === "xc_relay" && rawArgs.forwardOf !== undefined) {
      throw new McpError(ErrorCode.InvalidParams,
        "forwardOf_removed: 转发机制已在 v0.6 移除——请直接 xc_relay 撰写正文（批注另发一条）。见 docs/MIGRATION.md。");
    }
    const { args, ignored } = alias.mapArgs(rawArgs);
    const merged = { ...args, ...(alias.fixed ?? {}) };
    const result = (await dispatch(alias.target, merged, extra)) as {
      content?: Array<{ type: string; text?: string }>;
      [k: string]: unknown;
    };
    const note = { type: "text" as const, text: DEPRECATION_NOTE(name, alias) };
    const deprecated = { tool: name, replacement: alias.target, ...(ignored.length > 0 ? { ignored } : {}) };
    // content[0] = 警告块；原首块顺延。结构化 payload（content[1] 的 JSON 文本块）
    // 注入 deprecated——payloadOf() 与模型侧的结构化消费方都能看到（DESIGN §1.3
    // 验收口径）；原 payload 的既有键不变（纯增量）。
    const original = result.content ?? [];
    // 找机器 JSON 负载块（原 content[1]；无则不注入——deprecated 仍以顶层字段披露）。
    const payloadIdx = original.findIndex(
      (block) => block.type === "text" && typeof block.text === "string" && isJsonObject(block.text),
    );
    const content = [note, ...original];
    if (payloadIdx >= 0) {
      const parsed = JSON.parse((original[payloadIdx] as { text: string }).text) as Record<string, unknown>;
      content[payloadIdx + 1] = { type: "text", text: JSON.stringify({ ...parsed, deprecated }, null, 2) };
    }
    return { ...result, content, deprecated };
  });
}

function isJsonObject(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function pick(
  o: Record<string, unknown>,
  keys: string[],
  renames: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  for (const [k, v] of Object.entries(renames)) if (v !== undefined) out[k] = v;
  return out;
}
function rest(o: Record<string, unknown>, keys: string[]): string[] {
  return Object.keys(o).filter((k) => o[k] !== undefined && !keys.includes(k));
}
