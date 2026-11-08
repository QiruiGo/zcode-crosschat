import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STATE_DIR_NAME,
  engineLogFile,
  inboxFile,
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
