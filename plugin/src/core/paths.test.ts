import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STATE_DIR_NAME,
  engineLogFile,
  inboxFile,
  isValidTeamId,
  lockFile,
  namesFile,
  registryLockNames,
  resolveStateRoot,
  sessionFile,
  snapshotFile,
  teamFile,
  teamLockNames,
  wakeFile,
  workspaceFromEnv,
} from './paths.js';

describe('paths (DESIGN §2.2 磁盘真源布局)', () => {
  it('resolves the state root as <workspace>/.crosschat (absolute)', () => {
    const root = resolveStateRoot('D:\\ws\\.scratch');
    expect(root).toBe('D:\\ws\\.scratch\\.crosschat');
    expect(root).toContain(STATE_DIR_NAME);
    // The argument is a WORKSPACE (not a root): an absolute workspace still
    // gets the state dir appended, and relative workspaces are anchored to cwd.
    expect(resolveStateRoot('.scratch')).toContain('.scratch\\.crosschat');
  });

  it('falls back to cwd when ZCODE_PROJECT_DIR is unset/blank', () => {
    expect(workspaceFromEnv({} as NodeJS.ProcessEnv)).toBe(process.cwd());
    expect(workspaceFromEnv({ ZCODE_PROJECT_DIR: '  ' } as unknown as NodeJS.ProcessEnv)).toBe(process.cwd());
    expect(workspaceFromEnv({ ZCODE_PROJECT_DIR: 'D:\\x' } as NodeJS.ProcessEnv)).toBe('D:\\x');
  });

  it('builds the documented layout paths (§2.2 tree, 1:1)', () => {
    const root = 'R';
    expect(sessionFile(root, 'sess_1')).toBe(join(root, 'registry', 'sessions', 'sess_1.json'));
    expect(namesFile(root)).toBe(join(root, 'registry', 'names.json'));
    expect(wakeFile(root, 'tok')).toBe(join(root, 'registry', 'wake', 'tok.json'));
    expect(teamFile(root, 'default')).toBe(join(root, 'teams', 'default', 'team.json'));
    expect(inboxFile(root, 'default', 'b')).toBe(join(root, 'teams', 'default', 'inbox', 'b.jsonl'));
    expect(snapshotFile(root, 'default')).toBe(join(root, 'teams', 'default', 'snapshot.json'));
    expect(engineLogFile(root)).toBe(join(root, 'logs', 'engine.jsonl'));
    expect(lockFile(root, 'x')).toBe(join(root, 'locks', 'x.lock'));
  });

  it('in-process team lock key keeps the dsh spelling; file name is Windows-safe', () => {
    const { processKey, file } = teamLockNames('D:\\ws\\.scratch', 'default');
    expect(processKey).toBe('team:D:\\ws\\.scratch:default');
    // Colons and backslashes are illegal in Windows file names:
    expect(file).toMatch(/^team-[0-9a-f]{8}-default$/);
    expect(file).not.toContain(':');
    // Same workspace -> same identity; different workspace -> different file.
    const other = teamLockNames('D:\\other', 'default');
    expect(other.file).not.toBe(file);
    expect(other.processKey).toBe('team:D:\\other:default');
    expect(registryLockNames('D:\\ws\\.scratch').file).toMatch(/^registry-[0-9a-f]{8}$/);
  });
});

// v0.5.1（BND-1 回归）：xc_status.teamId 路径穿越修复的段合法性闸。
// 红队原始载荷（adjudication.md #1）逐条入表：相对穿越、反斜杠变体、
// 越过工作区、越过状态根三级、盘符绝对路径。
describe('isValidTeamId (BND-1: teamId 必须是单个安全路径段)', () => {
  it('产品合法 teamId 与常见段名接受', () => {
    expect(isValidTeamId('default')).toBe(true); // DEFAULT_TEAM_ID（types.ts:94）
    expect(isValidTeamId('team-1')).toBe(true);
    expect(isValidTeamId('My.Team_2-x')).toBe(true);
    expect(isValidTeamId('a'.repeat(128))).toBe(true); // 上限内
  });

  it('红队穿越载荷全拒（正向与反斜杠分隔符、深穿越、盘符）', () => {
    expect(isValidTeamId('../../evil-adj')).toBe(false); // 逃出 .crosschat/ 落工作区根
    expect(isValidTeamId('..\\..\\evil2-adj')).toBe(false); // 反斜杠变体
    expect(isValidTeamId('../../xc-adj-escape-proof')).toBe(false);
    expect(isValidTeamId('../../../../xc-adj-deep-escape')).toBe(false); // 逃出工作区
    expect(isValidTeamId('../../../xc-adj-3up')).toBe(false);
    expect(isValidTeamId('D:/xc-adj-abs-proof')).toBe(false); // 绝对路径（原为 ENOENT 拒，现显式拒）
    expect(isValidTeamId('D:\\xc-adj-abs-proof')).toBe(false);
  });

  it('`..`/`.`/分隔符/盘符冒号/控制字符/超长/空串全拒（结构性排除，不靠 incidentally-ENOENT）', () => {
    expect(isValidTeamId('..')).toBe(false);
    expect(isValidTeamId('.')).toBe(false);
    expect(isValidTeamId('../')).toBe(false);
    expect(isValidTeamId('a/b')).toBe(false);
    expect(isValidTeamId('a\\b')).toBe(false);
    expect(isValidTeamId('D:x')).toBe(false); // 盘符语法（无分隔符也要拒）
    expect(isValidTeamId('a:b')).toBe(false); // Windows 备用数据流语法
    expect(isValidTeamId('default extra space')).toBe(false); // 红队 C-64 变体
    expect(isValidTeamId('a\nb')).toBe(false);
    expect(isValidTeamId('.hidden')).toBe(false);
    expect(isValidTeamId('')).toBe(false);
    expect(isValidTeamId('a'.repeat(129))).toBe(false); // 超上限
  });
});
