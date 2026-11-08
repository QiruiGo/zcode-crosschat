/**
 * M1 core-store: state-root resolution and every on-disk path builder.
 *
 * Disk layout (DESIGN.md §2.2, 1:1 port of dsh state.js:4-12 layout):
 *
 *   <workspace>/.crosschat/
 *   ├── registry/sessions/<sessionId>.json
 *   ├── registry/names.json
 *   ├── registry/wake/<nonce>.json
 *   ├── teams/<teamId>/team.json
 *   ├── teams/<teamId>/inbox/<agentKey>.jsonl
 *   ├── teams/<teamId>/snapshot.json
 *   ├── locks/<name>.lock
 *   └── logs/engine.jsonl | wake-<to>-<ts>.json
 *
 * @module core/paths
 */
import { isAbsolute, join, resolve } from 'node:path';

/** State directory name under the workspace. Code constant, not userConfig
 * (hooks processes cannot read userConfig; DESIGN.md §8.2-A note). */
export const STATE_DIR_NAME = '.crosschat';

/**
 * Resolve the absolute state root for one workspace.
 * @param workspace the session workspace directory (may be relative).
 */
export function resolveStateRoot(workspace: string): string {
  return resolve(workspace, STATE_DIR_NAME);
}

/**
 * Resolve the workspace from the environment.
 * `ZCODE_PROJECT_DIR` is what the plugin manifest sets as the MCP server cwd
 * and what hooks read (DESIGN.md §2.3-1); fall back to process.cwd().
 */
export function workspaceFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env['ZCODE_PROJECT_DIR'];
  return typeof dir === 'string' && dir.trim() !== '' ? dir : process.cwd();
}

/** Whether `path` is already absolute (used by callers deciding to trust a cwd). */
export function isAbsolutePath(path: string): boolean {
  return isAbsolute(path);
}

// --- registry ---------------------------------------------------------------

export function registryDir(root: string): string {
  return join(root, 'registry');
}
export function sessionsDir(root: string): string {
  return join(root, 'registry', 'sessions');
}
export function sessionFile(root: string, sessionId: string): string {
  return join(root, 'registry', 'sessions', `${sessionId}.json`);
}
export function namesFile(root: string): string {
  return join(root, 'registry', 'names.json');
}
export function wakeDir(root: string): string {
  return join(root, 'registry', 'wake');
}
export function wakeFile(root: string, nonce: string): string {
  return join(root, 'registry', 'wake', `${nonce}.json`);
}

// --- teams ------------------------------------------------------------------

export function teamDir(root: string, teamId: string): string {
  return join(root, 'teams', teamId);
}
export function teamFile(root: string, teamId: string): string {
  return join(root, 'teams', teamId, 'team.json');
}
export function inboxDir(root: string, teamId: string): string {
  return join(root, 'teams', teamId, 'inbox');
}
export function inboxFile(root: string, teamId: string, agentKey: string): string {
  return join(root, 'teams', teamId, 'inbox', `${agentKey}.jsonl`);
}
export function snapshotFile(root: string, teamId: string): string {
  return join(root, 'teams', teamId, 'snapshot.json');
}

// --- locks & logs -----------------------------------------------------------

export function locksDir(root: string): string {
  return join(root, 'locks');
}
export function lockFile(root: string, name: string): string {
  return join(root, 'locks', `${name}.lock`);
}
export function logsDir(root: string): string {
  return join(root, 'logs');
}
export function engineLogFile(root: string): string {
  return join(root, 'logs', 'engine.jsonl');
}
export function wakeLogFile(root: string, to: string, ts: number): string {
  return join(root, 'logs', `wake-${to}-${ts}.json`);
}

// --- lock identity ----------------------------------------------------------

import { createHash } from 'node:crypto';

/** Longest workspace digest fragment embedded in lock file names. */
const LOCK_ROOT_DIGEST_LENGTH = 8;

/**
 * Cross-process + in-process lock identity for one team.
 * The in-process key keeps the dsh spelling `team:<abs stateRoot>:<teamId>`
 * (mailbox.js:44); the file name cannot contain `:` on Windows, so it uses a
 * workspace digest instead: `team-<digest8>-<teamId>`.
 */
export function teamLockNames(root: string, teamId: string): { processKey: string; file: string } {
  const abs = resolve(root);
  const digest = createHash('sha256').update(abs.toLowerCase()).digest('hex').slice(0, LOCK_ROOT_DIGEST_LENGTH);
  return { processKey: `team:${abs}:${teamId}`, file: `team-${digest}-${teamId}` };
}

/** Registry lock identity (fixed acquisition order: registry -> team, §2.7-3). */
export function registryLockNames(root: string): { processKey: string; file: string } {
  const abs = resolve(root);
  const digest = createHash('sha256').update(abs.toLowerCase()).digest('hex').slice(0, LOCK_ROOT_DIGEST_LENGTH);
  return { processKey: `registry:${abs}`, file: `registry-${digest}` };
}

/**
 * Bundle of path builders addressed as one object (module-3 call shape):
 * `const paths = statePaths(root); paths.lock('registry')`.
 */
export function statePaths(root: string): {
  root: string;
  lock(name: string): string;
  session(sessionId: string): string;
  names(): string;
  wake(token: string): string;
  team(teamId: string): string;
  teamFile(teamId: string): string;
  inbox(teamId: string, agentKey: string): string;
  snapshot(teamId: string): string;
  engineLog(): string;
} {
  return {
    root,
    lock: (name: string) => lockFile(root, name),
    session: (sessionId: string) => sessionFile(root, sessionId),
    names: () => namesFile(root),
    wake: (token: string) => wakeFile(root, token),
    team: (teamId: string) => teamDir(root, teamId),
    teamFile: (teamId: string) => teamFile(root, teamId),
    inbox: (teamId: string, agentKey: string) => inboxFile(root, teamId, agentKey),
    snapshot: (teamId: string) => snapshotFile(root, teamId),
    engineLog: () => engineLogFile(root),
  };
}
