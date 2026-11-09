/**
 * W2 transport：跨会话消息端点（命名管道 server/client + 文件收件箱退化）。
 *
 * 依据：DESIGN-V0.3.md §4.1 / §4.3 / §4.4 / §4.5 / §4.6；SPEC-V0.3.md
 * R-26 ~ R-33；平台事实 FEASIBILITY-V0.3.md §1（T1 命名管道实测）、§4（T4 文件
 * 收件箱退化实测）；CC 机制标尺 reports/11-cc逆向.md §3.b-2。
 *
 * 实测事实（FEASIBILITY-V0.3 §1.2，本机 Windows 11 + node）：
 * - 绑定 `\\.\pipe\LOCAL\<name>` 成功；客户端连接 ~3 ms；100 次往返 avgMs=0.1；
 *   重复绑定 → EADDRINUSE；连接不存在的管道 → ENOENT（与 TCP 的 ECONNREFUSED 不同，
 *   两者都可判别，映射表分别写）。
 * - 服务端 → 客户端的主动推送可达（管道是双向流）。
 * - 与 stdio 协议流共存成立（本文件不写 stdout，不破坏 MCP stdio 通道）。
 *
 * 端点生命周期（DESIGN §11.1 的 EOF 纪律依赖本文件）：
 * `stopPeerEndpoint()` 关闭监听并清掉所有连接；server.ts 在 stdin EOF/close 时
 * 调用它（FEASIBILITY §3.3：MCP SDK 的 stdio transport **不**监听 stdin EOF，
 * 一旦进程内持有 net server，stdin EOF 时事件循环被撑着、进程永不退出 → 僵尸端点）。
 *
 * 错误分类（R-32，CC `Pe()` @34233402 七类）：
 * `stale_socket`（管道不存在/被拒/对端已走）｜`socket_busy`（端点不可服务：连接被
 * 端点以 busy 拒掉）｜`too_large`（超 R-30 预算）｜`sender_paced`（命中发方限速）
 * ｜`invalid_target`（端点不可信：令牌不匹配、连接被对端掐断、路径不可用）
 * ｜`timeout`（连接/应答超时）｜`other`（其余）。
 *
 * 退化路径（§4.5）：管道连不上（ENOENT/ECONNREFUSED）→ 往接收方的
 * `inbox/<sessionId>.jsonl` 追加**一行传输级 msg 帧 JSON**（未过三态闸；接收方
 * 排空时自己过闸）。退化投递同样算「已入接收方队列」（CC 语义 delivered）。
 *
 * @module transport/pipe
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { appendJsonl } from '../core/jsonl.js';
import { peerAuditLogFile as buildPeerAuditLogFile } from '../core/peerdir.js';
import { readPeerRecord, removePeerRecord, touchPeerRecord } from '../core/peerregistry.js';
import {
  decodeFrame,
  encodeFrame,
  peerAuthLine,
  PEER_AUTH_DEADLINE_MS,
  PEER_MAX_LINE_BYTES,
  PEER_SEND_TIMEOUT_MS,
  PEER_TOKEN_RE,
  type ControlFrame,
  type MsgFrame,
  type PeerFrame,
  type StatusFrame,
} from './frames.js';

// 帧类型从 frames.ts 转出（调用方只 import transport/pipe.js 即可拿到全套类型）。
export type {
  AuthFrame,
  ControlFrame,
  MsgFrame,
  PeerFrame,
  PeerReceiptState,
  StatusFrame,
} from './frames.js';

/** 发送错误七类（R-32 / CC `Pe()` @34233402）。 */
export type PeerErrorClass =
  | 'stale_socket'
  | 'socket_busy'
  | 'too_large'
  | 'sender_paced'
  | 'invalid_target'
  | 'timeout'
  | 'other';

/** 端点身份（结构兼容 W1 的 PeerRecord：本模块只读这几个字段，其余字段透传）。 */
export interface PeerEndpointIdentity {
  /** MCP server 进程 pid（注册记录的文件名即 pid）。 */
  pid: number;
  /** 本会话 id。 */
  sessionId: string;
  /** 命名管道路径（若注册记录里已有）。 */
  messagingSocketPath?: string;
  /** 可寻址名。 */
  name?: string;
  /** 会话类别。 */
  kind?: 'interactive' | 'bg';
  /** 展示名（可选）。 */
  displayName?: string;
  /** 机器域标识（可选）。 */
  pidDomain?: string;
}

/** 端点收到的帧的上下文。 */
export interface PeerFrameContext {
  /** 命中 peerToken → 'peer'；命中 childToken → 'child'（R-29）。 */
  identity: 'peer' | 'child';
  /** 连接的远端地址（命名管道下是本地路径）。 */
  remote?: string;
}

/**
 * 端点回调。
 *
 * `onMessage` 的**契约**：必须返回一帧 status（投递回执）。
 * 返回 undefined 时端点按 `{state:'delivered', detail:'accepted-no-status'}` 应答
 * ——语义是「接收方已受理这帧」（CC 的 delivered = 已入接收方队列）；三态闸与
 * 入队闸的判定都在接收侧（W4/W5），命中暂存/拒收/丢弃时必须由 handler 显式返回
 * `held` / `refused` / `dropped`。
 */
export interface PeerEndpointHandlers {
  onMessage?: (
    frame: MsgFrame,
    ctx: PeerFrameContext,
  ) => Promise<StatusFrame | undefined> | StatusFrame | undefined;
  onControl?: (frame: ControlFrame, ctx: PeerFrameContext) => Promise<void> | void;
  /** 未鉴权/鉴权失败的连接（单次播报模式，R-24）。 */
  onUnauthenticated?: (info: { remote?: string; reason: string }) => void;
  /** 审计事件出口（默认写 `<root>/logs/peer.jsonl`）。 */
  onAudit?: (event: string, fields: Record<string, unknown>) => void;
}

export interface PeerEndpointOptions {
  /** peer 根目录（机器全局 peers 根，W1 的 peerdir 解析）。 */
  root: string;
  /** 本端点身份。 */
  record: PeerEndpointIdentity;
  /** 本端点的 peerToken（32 hex）。 */
  token: string;
  /** 显式端点路径（覆盖 record.messagingSocketPath 与默认值）。 */
  socketPath?: string;
  handlers?: PeerEndpointHandlers;
  /** 首帧期限（默认 30 s；测试可缩短）。 */
  authTimeoutMs?: number;
  /** 单行上限（默认 1 MiB；测试可缩小）。 */
  maxLineBytes?: number;
  /** 并发连接上限（超过即回 busy 并断开）。 */
  maxConnections?: number;
  /**
   * 注册表心跳间隔（毫秒）。默认 {@link PEER_HEARTBEAT_INTERVAL_MS}；
   * 测试可缩短。**心跳是注册记录存活的前提**（DESIGN-V0.3 §2.2「MCP server
   * 每 15 s 原子更新 lastSeen」）：没有心跳，`lastSeen` 永远停在注册时刻，
   * 超过 `PEER_STALE_MS`（60 s）后 `peerIsAlive()` 判死、记录被惰性清扫，
   * 别的会话再也发现不到这个 peer（`peer_not_found`）。
   */
  heartbeatIntervalMs?: number;
}

/** 注册表心跳间隔（DESIGN-V0.3 §2.2：15 s；`PEER_STALE_MS`=60 s ⇒ 4 倍余量）。 */
export const PEER_HEARTBEAT_INTERVAL_MS = 15_000;

export interface PeerEndpointInfo {
  socketPath: string;
  pid: number;
  sessionId: string;
  /** 本端点铸出的令牌（childToken 由端点自持，不外发）。 */
  peerToken: string;
}

/**
 * 跨会话域审计日志文件（机器全局，DESIGN §3.1）。
 *
 * 路径由 W1 的 `core/peerdir.ts` 统一构造（`logs/peer.jsonl`）——本模块只
 * 转出，不另造一套（W1 → W2 的依赖方向，DESIGN §10.3）。
 */
export const peerAuditLogFile = buildPeerAuditLogFile;

/** 端点路径的规范化摘要（key 文件名用：`<pid>.<sha256(sock)>.key`）。 */
export function peerSocketDigest(socketPath: string): string {
  return createHash('sha256').update(normalizeSocketPath(socketPath), 'utf8').digest('hex');
}

/**
 * 规范化端点路径（摘要口径与 W1 的 `canonicalSocketDigest` 一致：
 * Windows 下管道名大小写不敏感 → 反斜杠转正斜杠并转小写；其他平台原样）。
 *
 * W1 的 `canonicalSocketDigest` 是 key 文件名的权威实现；本函数与它同算法，
 * 保证 transport 侧算出的摘要与注册表侧一致。
 */
export function normalizeSocketPath(socketPath: string): string {
  if (process.platform === 'win32') return socketPath.replaceAll('\\', '/').toLowerCase();
  return socketPath;
}

/**
 * 铸令牌：peerToken + childToken 各 32 hex（16 随机字节，CC `hXi()` @3373352）。
 */
export function mintPeerTokens(): { peerToken: string; childToken: string } {
  return {
    peerToken: randomBytes(16).toString('hex'),
    childToken: randomBytes(16).toString('hex'),
  };
}

/**
 * 默认端点路径（R-26）：
 * - Windows：`\\.\pipe\LOCAL\xcc-msg-<32hex>`（16 随机字节；`LOCAL` 命名空间 +
 *   `xcc-msg-` 自有前缀，避开与同机 CC 的 `cc-msg-` 端点冲突）；
 * - 其他平台：`/tmp/xcc-socks-<uid>-<pid>.sock`（CC `Jsa()` @36108779 同构）。
 */
export function defaultPeerSocketPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\LOCAL\\xcc-msg-${randomBytes(16).toString('hex')}`;
  }
  return `/tmp/xcc-socks-${process.getuid?.() ?? 0}-${process.pid}.sock`;
}

/**
 * 显式端点路径校验（R-27，平移 CC 校验链 @36110647 / @36115464）：
 * - 空值 / 相对路径 → 拒；
 * - Windows 必须 `\\.\pipe\<单段名>`（允许可选 `LOCAL\` 前缀段）；
 * - UNC / 远端 / 尾点 / 尾空格 → 拒（「not a usable local socket address」语义）；
 * - 非 Windows：绝对路径、无 `..` 段。
 */
export function validatePeerSocketPath(raw: string | undefined): {
  ok: boolean;
  path?: string;
  reason?: string;
} {
  const value = raw ?? '';
  if (value === '') return { ok: false, reason: 'socket path is empty' };
  // 尾空格/尾点必须拒（R-27：CC 校验链 @36110647）——先于任何 trim 判定，
  // 否则 trim 会把违规尾巴吃掉。
  if (value !== value.trim()) return { ok: false, reason: 'socket path has surrounding whitespace' };
  if (value.endsWith('.')) return { ok: false, reason: 'socket path has a trailing dot' };

  if (process.platform === 'win32') {
    if (!value.startsWith('\\\\.\\pipe\\')) {
      return { ok: false, reason: 'not a usable local socket address: expected \\\\?\\pipe\\<name>' };
    }
    const rest = value.slice('\\\\.\\pipe\\'.length);
    if (rest === '') return { ok: false, reason: 'socket path has no pipe name' };
    const segments = rest.split('\\');
    if (segments.length > 2) {
      return { ok: false, reason: 'not a usable local socket address: multi-segment pipe name' };
    }
    if (segments.length === 2 && segments[0]!.toLowerCase() !== 'local') {
      return { ok: false, reason: 'not a usable local socket address: unknown pipe namespace' };
    }
    const name = segments[segments.length - 1]!;
    if (name === '' || name.endsWith(' ') || name.endsWith('.')) {
      return { ok: false, reason: 'not a usable local socket address: bad pipe name' };
    }
    if (/[<>:"|?*\u0000-\u001f]/.test(name)) {
      return { ok: false, reason: 'not a usable local socket address: bad characters in pipe name' };
    }
    return { ok: true, path: value };
  }

  if (!value.startsWith('/')) {
    return { ok: false, reason: 'not a usable local socket address: path must be absolute' };
  }
  if (value.split('/').includes('..')) {
    return { ok: false, reason: 'not a usable local socket address: path must not contain ".."' };
  }
  return { ok: true, path: value };
}

// ---------------------------------------------------------------------------
// 近期令牌摘要表（R-29：HMAC-SHA256 截 24 hex，至多 32 项，用于令牌轮换宽限）
// ---------------------------------------------------------------------------

/**
 * 近期令牌摘要表。摘要 = HMAC-SHA256(进程内随机盐, token) 截 24 hex；
 * 比较用 timingSafeEqual。容量 32，超出按 FIFO 丢弃最旧项（CC `Mjn=32` @2355944）。
 */
export class RecentTokenTable {
  private readonly salt = randomBytes(32);
  private readonly digests: string[] = [];

  constructor(private readonly capacity: number = 32) {}

  digest(token: string): string {
    return createHmac('sha256', this.salt).update(token, 'utf8').digest('hex').slice(0, 24);
  }

  remember(token: string): void {
    const digest = this.digest(token);
    const existing = this.digests.indexOf(digest);
    if (existing >= 0) this.digests.splice(existing, 1);
    this.digests.push(digest);
    while (this.digests.length > this.capacity) this.digests.shift();
  }

  has(token: string): boolean {
    const digest = this.digest(token);
    return this.digests.some((candidate) => {
      const a = Buffer.from(candidate, 'hex');
      const b = Buffer.from(digest, 'hex');
      return a.length === b.length && timingSafeEqual(a, b);
    });
  }

  get size(): number {
    return this.digests.length;
  }
}

// ---------------------------------------------------------------------------
// 服务端
// ---------------------------------------------------------------------------

interface ConnectionState {
  socket: Socket;
  buffer: string;
  authenticated: boolean;
  identity: 'peer' | 'child';
  authTimer?: NodeJS.Timeout;
}

interface EndpointRuntime {
  server: Server;
  socketPath: string;
  root: string;
  peerToken: string;
  childToken: string;
  recent: RecentTokenTable;
  options: PeerEndpointOptions;
  connections: Set<Socket>;
  warnedUnauthenticated: boolean;
  /** 注册表心跳定时器（`stopPeerEndpoint` 时清掉）。 */
  heartbeat?: NodeJS.Timeout;
}

let runtime: EndpointRuntime | undefined;

function classifySocketError(error: unknown): PeerErrorClass {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENOENT':
    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'EPIPE':
      return 'stale_socket';
    case 'EACCES':
    case 'EPERM':
    case 'EADDRNOTAVAIL':
      return 'invalid_target';
    case 'ETIMEDOUT':
      return 'timeout';
    default:
      return 'other';
  }
}

/** 审计一条跨会话域事件（默认写 `<root>/logs/peer.jsonl`，失败不抛）。 */
async function audit(
  rt: EndpointRuntime | undefined,
  event: string,
  fields: Record<string, unknown>,
): Promise<void> {
  if (rt === undefined) return;
  try {
    rt.options.handlers?.onAudit?.(event, fields);
  } catch {
    /* 审计回调不得影响传输 */
  }
  try {
    await appendJsonl(peerAuditLogFile(rt.root), [JSON.stringify({ ts: Date.now(), event, ...fields })]);
  } catch {
    /* 审计写失败不抛（与 core/log.ts 同款纪律） */
  }
}

/**
 * 启动本会话的跨会话消息端点（命名管道 server）。
 *
 * 幂等性：同一进程内只允许一个端点（v0.3 一个 MCP server = 一个会话 = 一个端点）。
 * 重复调用会先停掉旧端点。
 */
export async function startPeerEndpoint(options: PeerEndpointOptions): Promise<PeerEndpointInfo> {
  if (!PEER_TOKEN_RE.test(options.token)) {
    throw new Error('peer endpoint token must be 32 hex chars');
  }
  await stopPeerEndpoint();

  const socketPath =
    options.socketPath ?? options.record.messagingSocketPath ?? defaultPeerSocketPath();
  const validated = validatePeerSocketPath(socketPath);
  if (!validated.ok || validated.path === undefined) {
    throw new Error(`refusing socket path — ${validated.reason ?? 'unknown reason'}`);
  }

  const childToken = randomBytes(16).toString('hex');
  const recent = new RecentTokenTable(32);
  recent.remember(options.token);
  recent.remember(childToken);

  const rt: EndpointRuntime = {
    server: createServer(),
    socketPath: validated.path,
    root: options.root,
    peerToken: options.token,
    childToken,
    recent,
    options,
    connections: new Set<Socket>(),
    warnedUnauthenticated: false,
  };

  const maxLineBytes = options.maxLineBytes ?? PEER_MAX_LINE_BYTES;
  const authTimeoutMs = options.authTimeoutMs ?? PEER_AUTH_DEADLINE_MS;
  const maxConnections = options.maxConnections ?? 32;

  rt.server.on('connection', (socket: Socket) => {
    if (rt.connections.size >= maxConnections) {
      // 端点忙：回一帧 busy 的 status 再断开（客户端据此归类 socket_busy）。
      // 用 end() 而不是 destroy()——确保这行字节先被刷出去，客户端才读得到。
      rt.connections.add(socket);
      socket.on('close', () => rt.connections.delete(socket));
      try {
        socket.end(encodeFrame({ type: 'status', msgId: '-', state: 'dropped', detail: 'endpoint-busy' }));
      } catch {
        /* 对端可能已走 */
      }
      void audit(rt, 'peer-endpoint-busy', { connections: rt.connections.size });
      return;
    }

    rt.connections.add(socket);
    const state: ConnectionState = {
      socket,
      buffer: '',
      authenticated: false,
      identity: 'peer',
    };

    state.authTimer = setTimeout(() => {
      if (state.authenticated) return;
      void audit(rt, 'peer-auth-timeout', { remote: socket.remoteAddress ?? undefined });
      socket.destroy();
    }, authTimeoutMs);
    state.authTimer.unref?.();

    const finish = (): void => {
      if (state.authTimer !== undefined) clearTimeout(state.authTimer);
      rt.connections.delete(socket);
    };
    socket.on('close', finish);
    socket.on('error', () => socket.destroy());

    socket.on('data', (chunk: Buffer) => {
      state.buffer += chunk.toString('utf8');
      if (Buffer.byteLength(state.buffer, 'utf8') > maxLineBytes) {
        void audit(rt, 'peer-frame-oversize', { bytes: Buffer.byteLength(state.buffer, 'utf8') });
        socket.destroy();
        return;
      }
      let index = state.buffer.indexOf('\n');
      while (index >= 0) {
        const line = state.buffer.slice(0, index);
        state.buffer = state.buffer.slice(index + 1);
        void handleLine(rt, state, line, maxLineBytes);
        index = state.buffer.indexOf('\n');
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: unknown): void => {
      rt.server.removeListener('listening', onListening);
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      reject(
        new Error(
          code === 'EADDRINUSE'
            ? `another process owns this pipe name; choose a different pipe name (${rt.socketPath})`
            : `failed to listen on ${rt.socketPath}: ${String(error)}`,
        ),
      );
    };
    const onListening = (): void => {
      rt.server.removeListener('error', onError);
      resolve();
    };
    rt.server.once('error', onError);
    rt.server.once('listening', onListening);
    rt.server.listen(rt.socketPath);
  });

  runtime = rt;
  // 注册表心跳（DESIGN-V0.3 §2.2）：周期刷新本记录的 lastSeen，
  // 否则记录在 PEER_STALE_MS（60 s）后被判 stale 并被惰性清扫，
  // 本会话就从本机的可寻址集合里消失（实测症状：bob 回信时
  // `peer_not_found: 未找到名为「alice」的可寻址会话`）。
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? PEER_HEARTBEAT_INTERVAL_MS;
  if (heartbeatIntervalMs > 0) {
    rt.heartbeat = setInterval(() => {
      void (async () => {
        // 记录已被删除（改名/退出清扫）时**不重建**——touchPeerRecord 会
        // 在记录缺失时按 patch 造一条残缺记录，这里先读后写。
        const existing = await readPeerRecord(rt.root, options.record.pid);
        if (existing === undefined) return;
        await touchPeerRecord(rt.root, options.record.pid, { lastSeen: Date.now() });
      })();
    }, heartbeatIntervalMs);
    // 心跳不得成为进程不退出的理由（退出纪律由 stdin EOF 驱动）。
    rt.heartbeat.unref?.();
  }
  await audit(rt, 'peer-endpoint-started', { socketPath: rt.socketPath, pid: options.record.pid });
  return {
    socketPath: rt.socketPath,
    pid: options.record.pid,
    sessionId: options.record.sessionId,
    peerToken: options.token,
  };
}

/** 关闭端点（server.ts 的 EOF 纪律调用）。 */
export async function stopPeerEndpoint(): Promise<void> {
  const rt = runtime;
  runtime = undefined;
  if (rt === undefined) return;
  if (rt.heartbeat !== undefined) {
    clearInterval(rt.heartbeat);
    rt.heartbeat = undefined;
  }
  for (const socket of rt.connections) socket.destroy();
  rt.connections.clear();
  // 退出清理（DESIGN-V0.3 §2.2「优雅退出 → 删 <pid>.json + 关管道 + exit(0)」）：
  // 摘掉本进程在 peer 注册表里的记录，免得留下一个死 pid 记录占位。
  try {
    await removePeerRecord(rt.root, rt.options.record.pid);
  } catch {
    /* 清理失败不阻塞退出（退出纪律优先于清理结果） */
  }
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    // 兜底：close() 的回调要等所有连接归零；连接迟迟不断时不许把关闭流程卡死
    //（MCP server 的 EOF 纪律要求进程一定退出）。
    const timer = setTimeout(finish, 2_000);
    timer.unref?.();
    rt.server.close(() => {
      clearTimeout(timer);
      finish();
    });
  });
  await audit(rt, 'peer-endpoint-stopped', { socketPath: rt.socketPath });
}

/** 当前端点状态（观测用）。 */
export function peerEndpointState(): { running: boolean; socketPath?: string; pid?: number; sessionId?: string } {
  if (runtime === undefined) return { running: false };
  return {
    running: true,
    socketPath: runtime.socketPath,
    pid: runtime.options.record.pid,
    sessionId: runtime.options.record.sessionId,
  };
}

/** 处理一行（已去掉行界）。 */
async function handleLine(
  rt: EndpointRuntime,
  state: ConnectionState,
  line: string,
  maxLineBytes: number,
): Promise<void> {
  if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
    void audit(rt, 'peer-frame-oversize', { bytes: Buffer.byteLength(line, 'utf8') });
    state.socket.destroy();
    return;
  }
  const decoded = decodeFrame(line);
  if (!decoded.ok) {
    void audit(rt, 'peer-frame-rejected', { reason: decoded.reason, authenticated: state.authenticated });
    return;
  }
  const frame = decoded.frame;

  if (!state.authenticated) {
    // 首帧必须 auth（CC @36107247）。
    if (frame.type !== 'auth') {
      void audit(rt, 'peer-auth-missing', { remote: state.socket.remoteAddress ?? undefined });
      if (!rt.warnedUnauthenticated) {
        rt.warnedUnauthenticated = true;
        try {
          rt.options.handlers?.onUnauthenticated?.({
            remote: state.socket.remoteAddress ?? undefined,
            reason: 'first frame was not auth',
          });
        } catch {
          /* 播报失败不抛 */
        }
      }
      state.socket.destroy();
      return;
    }
    const identity = tokenIdentity(rt, frame.token);
    if (identity === undefined) {
      void audit(rt, 'peer-auth-rejected', { remote: state.socket.remoteAddress ?? undefined });
      if (!rt.warnedUnauthenticated) {
        rt.warnedUnauthenticated = true;
        try {
          rt.options.handlers?.onUnauthenticated?.({
            remote: state.socket.remoteAddress ?? undefined,
            reason: 'bad token',
          });
        } catch {
          /* 播报失败不抛 */
        }
      }
      state.socket.destroy();
      return;
    }
    state.authenticated = true;
    state.identity = identity;
    if (state.authTimer !== undefined) clearTimeout(state.authTimer);
    void audit(rt, 'peer-auth-ok', { identity });
    return;
  }

  const ctx: PeerFrameContext = { identity: state.identity, remote: state.socket.remoteAddress ?? undefined };
  if (frame.type === 'msg') {
    let reply: StatusFrame | undefined;
    try {
      reply = await rt.options.handlers?.onMessage?.(frame, ctx);
    } catch (error) {
      void audit(rt, 'peer-handler-error', { message: error instanceof Error ? error.message : String(error) });
      reply = { type: 'status', msgId: frame.msgId, state: 'dropped', detail: 'handler-error' };
    }
    const status: StatusFrame = reply ?? {
      type: 'status',
      msgId: frame.msgId,
      state: 'delivered',
      detail: 'accepted-no-status',
    };
    try {
      state.socket.write(encodeFrame(status));
    } catch {
      /* 对端可能已走 */
    }
    return;
  }
  if (frame.type === 'control') {
    try {
      await rt.options.handlers?.onControl?.(frame, ctx);
    } catch (error) {
      void audit(rt, 'peer-handler-error', { message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  // status 帧是收→发的方向；收到即视为异常用法，丢弃 + 审计。
  void audit(rt, 'peer-frame-rejected', { reason: 'status frame is receiver-to-sender only' });
}

function tokenIdentity(rt: EndpointRuntime, token: string): 'peer' | 'child' | undefined {
  if (safeEqual(token, rt.peerToken)) return 'peer';
  if (safeEqual(token, rt.childToken)) return 'child';
  if (rt.recent.has(token)) return 'peer';
  return undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export interface SendPeerFrameOptions {
  /** 目标端点路径。 */
  socketPath: string;
  /** 目标端点的 peerToken。 */
  token: string;
  /** 要发的帧。 */
  frame: PeerFrame;
  /** 超时（默认 10 s，R-32）。 */
  timeoutMs?: number;
  /**
   * 退化路径（§4.5）：管道不可达时把 `line` 追加到 `file` 并按「已投递」回执。
   *
   * 传输层**不决定**这一行的形状——行内容由调用方给（W6 按 W5 的 PeerQueueItem
   * 形状构造，接收方排空时才认）。传输层只负责「原样追加一行」。
   */
  fallback?: { file: string; line: string };
}

export type SendPeerFrameResult =
  | { ok: true; reply?: PeerFrame; via: 'pipe' | 'file'; bytes: number }
  | { ok: false; errorClass: PeerErrorClass; message: string };

/**
 * 发一帧到目标端点。
 *
 * 顺序（§4.6）：连接 → auth → 发帧 → 等 status（收→发方向的回执）。
 * 管道不可达且给了 `fallback` 时退化为文件投递（返回 via:'file'，追加的是
 * 调用方给的那一行）。
 */
export async function sendPeerFrame(options: SendPeerFrameOptions): Promise<SendPeerFrameResult> {
  if (!PEER_TOKEN_RE.test(options.token)) {
    return { ok: false, errorClass: 'invalid_target', message: 'peer token must be 32 hex chars' };
  }
  let encoded: string;
  try {
    encoded = encodeFrame(options.frame);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('too large')) {
      return { ok: false, errorClass: 'too_large', message };
    }
    return { ok: false, errorClass: 'other', message };
  }
  if (options.frame.type === 'msg') {
    const budget = Buffer.byteLength(encoded, 'utf8') + Buffer.byteLength(peerAuthLine(options.token), 'utf8') + 1;
    if (budget > PEER_MAX_LINE_BYTES) {
      return {
        ok: false,
        errorClass: 'too_large',
        message: `msg budget ${budget} bytes exceeds ${PEER_MAX_LINE_BYTES}`,
      };
    }
  }

  const timeoutMs = options.timeoutMs ?? PEER_SEND_TIMEOUT_MS;
  const outcome = await sendOverPipe(options, encoded, timeoutMs);
  if (outcome.ok) return outcome;
  if (
    outcome.errorClass === 'stale_socket' &&
    options.fallback !== undefined &&
    options.frame.type === 'msg'
  ) {
    try {
      await appendJsonl(options.fallback.file, [options.fallback.line]);
      return { ok: true, via: 'file', bytes: Buffer.byteLength(encoded, 'utf8') };
    } catch (error) {
      return {
        ok: false,
        errorClass: 'other',
        message: `file fallback failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return outcome;
}

function sendOverPipe(
  options: SendPeerFrameOptions,
  encoded: string,
  timeoutMs: number,
): Promise<SendPeerFrameResult> {
  return new Promise<SendPeerFrameResult>((resolve) => {
    let settled = false;
    let buffer = '';
    let wrote = false;

    const socket = connect(options.socketPath);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok: false, errorClass: 'timeout', message: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();

    const finish = (result: SendPeerFrameResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    socket.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (!wrote && (code === 'ENOENT' || code === 'ECONNREFUSED')) {
        finish({
          ok: false,
          errorClass: 'stale_socket',
          message: `peer endpoint is gone (${code ?? 'unknown'})`,
        });
        return;
      }
      finish({
        ok: false,
        errorClass: classifySocketError(error),
        message: error instanceof Error ? error.message : String(error),
      });
    });

    socket.on('close', () => {
      if (settled) return;
      if (!wrote) {
        finish({ ok: false, errorClass: 'stale_socket', message: 'peer endpoint closed the connection' });
        return;
      }
      finish({
        ok: false,
        errorClass: 'invalid_target',
        message: 'peer closed the connection without a status frame (authentication rejected or endpoint unavailable)',
      });
    });

    socket.on('connect', () => {
      try {
        socket.write(peerAuthLine(options.token));
        socket.write(encoded);
        wrote = true;
      } catch (error) {
        finish({
          ok: false,
          errorClass: 'other',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const decoded = decodeFrame(line);
        // 先把游标推到下一行，再决定这一行怎么处理。
        // 顺序反了（先 `continue` 后推进）会在对端发来**任何**一行不合法帧时
        // 死循环：同一行被反复切片，而这是同步代码，超时定时器永远跑不到
        // ⇒ 发送方事件循环被永久占满（对端一行垃圾即可让本会话卡死）。
        // 实测证据：evidence/12-v030/acceptance/phaseC/transport-invalid-line-hang/。
        index = buffer.indexOf('\n');
        if (!decoded.ok) continue;
        const frame = decoded.frame;
        if (frame.type === 'status') {
          if (frame.state === 'dropped' && (frame.detail ?? '').includes('busy')) {
            finish({ ok: false, errorClass: 'socket_busy', message: frame.detail ?? 'endpoint busy' });
            return;
          }
          if (frame.state === 'dropped' && (frame.detail ?? '').includes('rate')) {
            finish({ ok: false, errorClass: 'sender_paced', message: frame.detail ?? 'rate limited' });
            return;
          }
          finish({ ok: true, reply: frame, via: 'pipe', bytes: Buffer.byteLength(line, 'utf8') });
          return;
        }
      }
    });
  });
}
