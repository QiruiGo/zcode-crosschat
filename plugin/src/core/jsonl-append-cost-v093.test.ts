/**
 * v0.9.3 对抗轮 P0 回归：`appendJsonl` 追加成本必须有界（不随文件大小线性增长）。
 *
 * 缺陷形态（adv-1/R3 F-06）：旧实现每次追加前 `readFile` 整个目标文件（判尾行完整性/
 * 补分隔符），而读侧坏行审计是 per-line fire-and-forget ⇒ 2000 坏行的邮箱每拍 sweep
 * 触发 2000 次全文件读，单拍 RSS +1.7~2.9GB，3000 坏行直接 heap limit OOM。
 *
 * 判据：对 1 MiB 与 50 MiB 的 engine.jsonl 各追加一行，**实际 read 的字节数**相同且
 * ≤4 KiB（旧实现读满整个文件）。另覆盖半写尾行的分隔语义与正常追加的行格式。
 */
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendJsonl, readJsonl } from './jsonl.js';
import { isTeamMessage, type TeamMessage } from './types.js';

/**
 * 记录 `appendJsonl` 的尾探针实际读了多少字节。只包 `FileHandle.read`（旧实现的
 * 整文件读走 `readFile`，新实现走 fopen+fstat+定点 read）——断言的是 I/O 量，
 * 不是耗时，避免机器抖动。
 */
const io = vi.hoisted(() => ({ bytesRead: 0, readCalls: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (async (path: Parameters<typeof actual.open>[0], flags: Parameters<typeof actual.open>[1], mode?: number) => {
      const handle = await actual.open(path, flags, mode);
      const originalRead = handle.read.bind(handle) as (...args: unknown[]) => Promise<{ bytesRead: number }>;
      (handle as unknown as { read: (...args: unknown[]) => Promise<{ bytesRead: number }> }).read = async (...args: unknown[]) => {
        const result = await originalRead(...args);
        io.bytesRead += Number(result.bytesRead ?? 0);
        io.readCalls += 1;
        return result;
      };
      return handle;
    }) as typeof actual.open,
  };
});

const MIB = 1024 * 1024;
const TAIL_PROBE_LIMIT = 4096;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xc-jsonl-cost-'));
  io.bytesRead = 0;
  io.readCalls = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 预置一个以 `\n` 结尾的大文件（内容本身不参与断言，追加面不解析历史行）。 */
function seedFile(file: string, size: number): void {
  const body = Buffer.alloc(Math.max(0, size - 1), 0x61);
  writeFileSync(file, Buffer.concat([body, Buffer.from('\n')]));
}

/** 只读文件末尾 ≤max 字节（避免把 50 MiB 读回测试进程）。 */
function readTail(file: string, max: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(max, size);
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function message(id: string): TeamMessage {
  return { id, from: 'a', to: 'b', content: `c-${id}`, ts: 1 };
}

describe('appendJsonl: 追加成本与文件大小解耦（v0.9.3 P0）', () => {
  it('1 MiB 与 50 MiB 文件追加一行的 read 字节数相同且 ≤4 KiB', async () => {
    const small = join(dir, 'small-engine.jsonl');
    const large = join(dir, 'large-engine.jsonl');
    seedFile(small, 1 * MIB);
    seedFile(large, 50 * MIB);
    const line = JSON.stringify({ ts: Date.now(), event: 'probe', pad: 'x'.repeat(64) });

    io.bytesRead = 0;
    io.readCalls = 0;
    const smallStart = performance.now();
    await appendJsonl(small, [line]);
    const smallMs = performance.now() - smallStart;
    const smallReadBytes = io.bytesRead;
    const smallReadCalls = io.readCalls;

    io.bytesRead = 0;
    io.readCalls = 0;
    const largeStart = performance.now();
    await appendJsonl(large, [line]);
    const largeMs = performance.now() - largeStart;
    const largeReadBytes = io.bytesRead;
    const largeReadCalls = io.readCalls;

    // 旧实现：smallReadBytes=1 MiB、largeReadBytes=50 MiB（线性）。
    expect(smallReadBytes).toBeLessThanOrEqual(TAIL_PROBE_LIMIT);
    expect(largeReadBytes).toBeLessThanOrEqual(TAIL_PROBE_LIMIT);
    expect(smallReadBytes).toBe(largeReadBytes);
    expect(smallReadCalls).toBe(1);
    expect(largeReadCalls).toBe(1);
    // 只作诊断信息，不作硬断言（机器抖动）；关键判据是上面的 read 字节数。
    expect(largeMs).toBeLessThan(5_000);

    // 新行完整落盘（文件末尾就是我们追加的那一行）。
    const tail = readTail(large, 4096).toString('utf8');
    expect(tail.endsWith(`${line}\n`)).toBe(true);
    expect(JSON.parse(tail.trimEnd().split('\n').pop()!)).toEqual(JSON.parse(line));
    expect(smallMs).toBeLessThan(5_000);
  });

  it('半写尾行（无 \\n 结尾）：先补 \\n 再写新行，新行完整、旧半行成为可跳过的坏行', async () => {
    const file = join(dir, 'inbox.jsonl');
    const first = JSON.stringify(message('1'));
    const fragment = '{"id":"2","from":"a","to":"b","cont';
    writeFileSync(file, `${first}\n${fragment}`, 'utf8');

    const appended = JSON.stringify(message('3'));
    await appendJsonl(file, [appended]);

    // 半行没有被截掉（截断判定需要整文件读，已被移除），而是被 \n 隔离成坏行。
    expect(readFileSync(file, 'utf8')).toBe(`${first}\n${fragment}\n${appended}\n`);
    const malformed: number[] = [];
    const items = await readJsonl<TeamMessage>(file, isTeamMessage, (m) => malformed.push(m.lineNo));
    expect(items.map((m) => m.id)).toEqual(['1', '3']);
    expect(malformed).toEqual([2]);
  });

  it('正常追加行为不变：新文件逐行、已以 \\n 结尾时不多插空行', async () => {
    const file = join(dir, 'box.jsonl');
    const a = JSON.stringify(message('1'));
    const b = JSON.stringify(message('2'));
    await appendJsonl(file, [a]);
    await appendJsonl(file, [b]);
    expect(readFileSync(file, 'utf8')).toBe(`${a}\n${b}\n`);
    // 每行都是独立可解析对象（无粘连/无 BOM 破坏）。
    const raw = readFileSync(file, 'utf8');
    expect(raw.split('\n').filter(Boolean).map((line) => (JSON.parse(line) as TeamMessage).id)).toEqual(['1', '2']);
  });

  it('O_APPEND 并发追加不丢行/不粘行（原子性保持）', async () => {
    const file = join(dir, 'concurrent.jsonl');
    const lines = Array.from({ length: 25 }, (_, i) => JSON.stringify(message(`m${i}`)));
    await Promise.all(lines.map((line) => appendJsonl(file, [line])));
    const items = await readJsonl<TeamMessage>(file, isTeamMessage);
    expect(items.map((item) => item.id).sort()).toEqual(lines.map((_, i) => `m${i}`).sort());
  });
});
