/**
 * W2 单测：跨会话 wire 帧白名单（DESIGN-V0.3.md §4.2 / §4.3；SPEC R-13 / R-14 / R-30）。
 *
 * 覆盖：
 * - 四帧编解码 round-trip（auth / msg / control / status）；
 * - 白名单纪律：非白名单 type、**封闭字段集**外的键（含权限类字段）一律拒收；
 * - 字段级校验：token 32 hex、text 非空、msgId/from 非空、control 仅 rename、
 *   senderMode ∈ {bypass,prompting}、status state ∈ 六态；
 * - 限额：单行 1 MiB（含 `\n`）、msg 帧预算（+ auth 行开销）。
 */
import { describe, expect, it } from "vitest";
import {
  checkMsgBudget,
  decodeFrame,
  encodeFrame,
  frameTypeOf,
  msgBudgetBytes,
  PEER_FRAME_TYPES,
  PEER_MAX_LINE_BYTES,
  PEER_RECEIPT_STATES,
  peerAuthLine,
  peerAuthLineBytes,
  PEER_TOKEN_RE,
  validateFrame,
  type MsgFrame,
} from "./frames.js";

const TOKEN = "a".repeat(32);
const OTHER_TOKEN = "0123456789abcdef0123456789abcdef";

function msgFrame(overrides: Partial<MsgFrame> = {}): MsgFrame {
  return {
    type: "msg",
    msgId: "m-1",
    from: "alice",
    text: "hello peer",
    ...overrides,
  };
}

describe("帧白名单（R-13）", () => {
  it("白名单恰好四帧", () => {
    expect([...PEER_FRAME_TYPES]).toEqual(["auth", "msg", "control", "status"]);
  });

  it("auth / msg / control / status 四帧 round-trip", () => {
    const cases = [
      { type: "auth", token: TOKEN },
      msgFrame(),
      { type: "control", action: "rename", name: "bob" },
      { type: "status", msgId: "m-1", state: "delivered" },
    ] as const;
    for (const frame of cases) {
      const line = encodeFrame(frame);
      expect(line.endsWith("\n")).toBe(true);
      expect(line.slice(0, -1)).not.toContain("\n"); // 单行
      const decoded = decodeFrame(line);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) expect(decoded.frame).toEqual(frame);
    }
  });

  it("可选字段（fromSessionId / summary / senderMode / sessionId / detail）保留", () => {
    const msg = msgFrame({ fromSessionId: "sess-a", summary: "s", senderMode: "bypass" });
    const decoded = decodeFrame(encodeFrame(msg));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.frame).toEqual(msg);

    const control = decodeFrame(encodeFrame({ type: "control", action: "rename", name: "bob", sessionId: "sess-a" }));
    expect(control.ok).toBe(true);
    if (control.ok) expect(control.frame).toEqual({ type: "control", action: "rename", name: "bob", sessionId: "sess-a" });

    const status = decodeFrame(encodeFrame({ type: "status", msgId: "m-1", state: "held", detail: "awaiting approval" }));
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.frame).toEqual({ type: "status", msgId: "m-1", state: "held", detail: "awaiting approval" });
  });

  it("非白名单 type → 拒收（CC「Ignoring message without valid type field」）", () => {
    const decoded = decodeFrame(JSON.stringify({ type: "user", content: "hi" }));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toContain("unknown frame type");
  });

  it("队内域帧型不进跨会话白名单（域间互斥）", () => {
    for (const type of ["task_assignment", "shutdown_request", "delivery-refused", "mode_set_request"]) {
      expect(decodeFrame(JSON.stringify({ type })).ok).toBe(false);
    }
  });

  it("缺 type / 非对象 / 空行 → 拒收", () => {
    expect(decodeFrame("{}").ok).toBe(false);
    expect(decodeFrame("[1,2]").ok).toBe(false);
    expect(decodeFrame("   ").ok).toBe(false);
    expect(decodeFrame("not json").ok).toBe(false);
  });
});

describe("封闭字段集与安全规则（R-14）", () => {
  it("msg 帧出现未知字段 → 拒收", () => {
    const decoded = decodeFrame(JSON.stringify({ ...msgFrame(), priority: "high" }));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toContain("unknown field");
  });

  it("权限类字段一律拒收（安全规则①：权限规则永不入帧）", () => {
    for (const field of ["permission", "permissions", "permissionMode", "mode", "team_permission_update"]) {
      const decoded = decodeFrame(JSON.stringify({ ...msgFrame(), [field]: "anything" }));
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) expect(decoded.reason).toMatch(/forbidden field|unknown field/);
    }
  });

  it("control 帧只接受 rename（R-14 裁剪）", () => {
    const decoded = decodeFrame(JSON.stringify({ type: "control", action: "shutdown", name: "bob" }));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toContain("control action is not allowed");
  });

  it("status 帧 state ∈ 六态", () => {
    for (const state of PEER_RECEIPT_STATES) {
      expect(decodeFrame(JSON.stringify({ type: "status", msgId: "m", state })).ok).toBe(true);
    }
    expect(decodeFrame(JSON.stringify({ type: "status", msgId: "m", state: "queued" })).ok).toBe(false);
  });
});

describe("字段级校验", () => {
  it("auth token 必须是 32 位小写 hex", () => {
    expect(PEER_TOKEN_RE.test(TOKEN)).toBe(true);
    expect(PEER_TOKEN_RE.test(OTHER_TOKEN)).toBe(true);
    expect(decodeFrame(JSON.stringify({ type: "auth", token: "short" })).ok).toBe(false);
    expect(decodeFrame(JSON.stringify({ type: "auth", token: TOKEN.toUpperCase() })).ok).toBe(false);
    expect(decodeFrame(JSON.stringify({ type: "auth" })).ok).toBe(false);
  });

  it("msg 帧的 msgId / from / text 必须非空", () => {
    expect(decodeFrame(JSON.stringify({ ...msgFrame(), msgId: "" })).ok).toBe(false);
    expect(decodeFrame(JSON.stringify({ ...msgFrame(), from: "  " })).ok).toBe(false);
    expect(decodeFrame(JSON.stringify({ ...msgFrame(), text: "" })).ok).toBe(false);
    expect(decodeFrame(JSON.stringify({ ...msgFrame(), text: 42 })).ok).toBe(false);
  });

  it("msg 帧 senderMode ∈ {bypass, prompting}", () => {
    expect(decodeFrame(JSON.stringify({ ...msgFrame(), senderMode: "bypass" })).ok).toBe(true);
    expect(decodeFrame(JSON.stringify({ ...msgFrame(), senderMode: "prompting" })).ok).toBe(true);
    expect(decodeFrame(JSON.stringify({ ...msgFrame(), senderMode: "yolo" })).ok).toBe(false);
  });

  it("validateFrame 与 decodeFrame 同口径", () => {
    const validation = validateFrame({ ...msgFrame(), senderMode: "nope" });
    expect(validation.ok).toBe(false);
  });
});

describe("限额（R-30 / CC h0n @9591760）", () => {
  it("单行上限 1 MiB（含换行）", () => {
    expect(PEER_MAX_LINE_BYTES).toBe(1_048_576);
  });

  it("超长行解码失败", () => {
    const huge = "x".repeat(PEER_MAX_LINE_BYTES + 10);
    const decoded = decodeFrame(huge);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toContain("exceeds");
  });

  it("encodeFrame 对超限帧抛错（发送侧据此报 too_large）", () => {
    const huge = msgFrame({ text: "x".repeat(PEER_MAX_LINE_BYTES + 10) });
    expect(() => encodeFrame(huge)).toThrow(/too large/);
  });

  it("msg 帧预算 = len(JSON(msg)) + len(authLine) + 1 ≤ 1 MiB", () => {
    const msg = msgFrame();
    const expected =
      Buffer.byteLength(JSON.stringify(msg), "utf8") + peerAuthLineBytes(TOKEN) + 1;
    expect(msgBudgetBytes(msg, TOKEN)).toBe(expected);
    expect(checkMsgBudget(msg, TOKEN).ok).toBe(true);
  });

  it("预算超限 → too_large 判定", () => {
    const msg = msgFrame({ text: "x".repeat(PEER_MAX_LINE_BYTES) });
    const check = checkMsgBudget(msg, TOKEN);
    expect(check.ok).toBe(false);
    expect(check.limit).toBe(PEER_MAX_LINE_BYTES);
  });

  it("auth 行形态与长度", () => {
    expect(peerAuthLine(TOKEN)).toBe(`${JSON.stringify({ type: "auth", token: TOKEN })}\n`);
    expect(peerAuthLineBytes(TOKEN)).toBe(peerAuthLine(TOKEN).length);
    expect(() => peerAuthLine("nope")).toThrow(/32 hex/);
  });
});

describe("辅助函数", () => {
  it("frameTypeOf 只做快速判定", () => {
    expect(frameTypeOf({ type: "msg" })).toBe("msg");
    expect(frameTypeOf({})).toBeUndefined();
    expect(frameTypeOf(null)).toBeUndefined();
  });
});

describe("v0.5 origin 帧四件套（R-11；DESIGN-V0.5 §6.3-6）", () => {
  it("① FRAME_FIELDS 封闭集已含 origin/originSessionId（白名单外键拒收的反证前提）", () => {
    // 未知键仍拒收；origin/originSessionId 键不再被拒。
    expect(validateFrame({ ...msgFrame(), bogus: 1 }).ok).toBe(false);
    expect(validateFrame({ ...msgFrame(), origin: "user" }).ok).toBe(true);
    expect(validateFrame({ ...msgFrame(), originSessionId: "sess_x" }).ok).toBe(true);
  });

  it("② validateFrame 拒非法 origin 值", () => {
    for (const bad of ["USER", "self", 1, true, null]) {
      const verdict = validateFrame({ ...msgFrame(), origin: bad });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain('origin must be "user" or "agent"');
    }
  });

  it("② originSessionId 非字符串/空串拒帧", () => {
    for (const bad of [123, "", "   "]) {
      const verdict = validateFrame({ ...msgFrame(), originSessionId: bad });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain("originSessionId");
    }
  });

  it("③ origin=user 帧构造：origin+originSessionId 落帧；originSessionId 缺省则不带", () => {
    const withSession = validateFrame({ ...msgFrame(), origin: "user", originSessionId: "sess_abc" });
    expect(withSession.ok).toBe(true);
    if (withSession.ok && withSession.frame.type === "msg") {
      expect(withSession.frame.origin).toBe("user");
      expect(withSession.frame.originSessionId).toBe("sess_abc");
    }
    const noSession = validateFrame({ ...msgFrame(), origin: "user" });
    if (noSession.ok && noSession.frame.type === "msg") {
      expect(noSession.frame.origin).toBe("user");
      expect(noSession.frame.originSessionId).toBeUndefined();
    }
  });

  it("③ origin=agent 或缺失 → 两键不落帧（agent 缺省语义；originSessionId 随之丢弃）", () => {
    const agent = validateFrame({ ...msgFrame(), origin: "agent", originSessionId: "sess_zzz" });
    if (agent.ok && agent.frame.type === "msg") {
      expect(agent.frame.origin).toBeUndefined();
      expect(agent.frame.originSessionId).toBeUndefined();
    }
    const absent = validateFrame(msgFrame());
    if (absent.ok && absent.frame.type === "msg") {
      expect(absent.frame.origin).toBeUndefined();
      expect(absent.frame.originSessionId).toBeUndefined();
    }
  });

  it("④ encodeFrame 上线成功（P1 回归）：origin 帧可编码且 decode 保留 user 两键", () => {
    const frame = msgFrame({ origin: "user", originSessionId: "sess_q1" });
    const line = encodeFrame(frame);
    const decoded = decodeFrame(line);
    expect(decoded.ok).toBe(true);
    if (decoded.ok && decoded.frame.type === "msg") {
      expect(decoded.frame.origin).toBe("user");
      expect(decoded.frame.originSessionId).toBe("sess_q1");
    }
  });

  it("旧端点帧（无 origin 两键）照常解析为 agent 缺省（R-11 兼容）", () => {
    const decoded = decodeFrame(encodeFrame(msgFrame()));
    expect(decoded.ok).toBe(true);
    if (decoded.ok && decoded.frame.type === "msg") {
      expect(decoded.frame.origin).toBeUndefined();
    }
  });
});
