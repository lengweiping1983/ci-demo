import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

export const RESULT_SCHEMA_VERSION = 1;
export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  STATE: 3,
  VALIDATION: 4,
  POLICY: 5,
  CONFLICT: 6,
  BLOCKED: 7,
  EXHAUSTED: 8,
  NOT_MET: 9,
  INTERNAL: 70,
});

export const TASK_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['in_progress', 'decomposed']),
  in_progress: Object.freeze(['pending', 'blocked', 'completed']),
  blocked: Object.freeze(['pending']),
  decomposed: Object.freeze(['completed']),
  completed: Object.freeze([]),
});

export function canTransition(from, to) {
  return !!TASK_TRANSITIONS[from]?.includes(to);
}

export function result(ok, status, reason = '', data = {}, code = ok ? EXIT.OK : EXIT.STATE) {
  return { schemaVersion: RESULT_SCHEMA_VERSION, ok, code, status, reason, data };
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJson(value)).digest('hex');
}

export function atomicWriteFile(file, content, encoding = 'utf-8') {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, content, encoding);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    try {
      const dfd = fs.openSync(dir, 'r');
      fs.fsyncSync(dfd);
      fs.closeSync(dfd);
    } catch { /* 某些文件系统不允许 fsync 目录；文件 rename 仍保持原子性 */ }
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* noop */ }
    try { fs.unlinkSync(temp); } catch { /* noop */ }
    throw error;
  }
}

export function atomicWriteJson(file, value) {
  atomicWriteFile(file, JSON.stringify(value, null, 2) + '\n');
}

export function readJson(file, fallback = null) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : fallback;
}

export function durableAppendJsonLine(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(value) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function waitSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function clearLock(lockDir, expectedToken = null) {
  if (expectedToken) {
    let current;
    try { current = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf-8')); }
    catch { return false; }
    if (current?.token !== expectedToken) return false;
  }
  try { fs.unlinkSync(path.join(lockDir, 'owner.json')); } catch { /* noop */ }
  try { fs.rmdirSync(lockDir); return true; } catch { return false; }
}

export class LockTimeoutError extends Error {
  constructor(message, owner = null) {
    super(message);
    this.name = 'LockTimeoutError';
    this.owner = owner;
  }
}

export function acquireProjectLock(cwd, options = {}) {
  const lockDir = path.join(cwd, '.rootagent', 'runtime', 'locks', 'project.lock');
  const timeoutMs = Number(options.timeoutMs ?? process.env.ROOTAGENT_LOCK_TIMEOUT_MS ?? 10000);
  const staleMs = Number(options.staleMs ?? 10 * 60 * 1000);
  const started = Date.now();
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      const owner = { token: crypto.randomUUID(), pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(), command: process.argv.slice(2) };
      atomicWriteJson(path.join(lockDir, 'owner.json'), owner);
      let released = false;
      return {
        owner,
        release() {
          if (released) return;
          released = true;
          clearLock(lockDir, owner.token);
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf-8')); } catch { /* owner 正在创建或已损坏 */ }
      const age = owner?.acquiredAt ? Date.now() - new Date(owner.acquiredAt).getTime() : 0;
      let orphanAge = 0;
      try { orphanAge = Date.now() - fs.statSync(lockDir).mtimeMs; } catch { /* noop */ }
      const localOwner = owner?.host === os.hostname();
      const stale = owner
        ? (localOwner ? !processAlive(owner.pid) : age > staleMs)
        : orphanAge > 1000;
      if (stale && clearLock(lockDir, owner?.token || null)) continue;
      if (Date.now() - started >= timeoutMs) throw new LockTimeoutError(`等待项目写锁超时（${timeoutMs}ms）`, owner);
      waitSync(15 + Math.floor(Math.random() * 25));
    }
  }
}

export function withProjectLock(cwd, fn, options) {
  const lock = acquireProjectLock(cwd, options);
  try { return fn(); } finally { lock.release(); }
}

export function workerIdentity() {
  return process.env.ROOTAGENT_WORKER_ID || 'local-cli';
}

export function currentCommit(cwd) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

const ROOTAGENT_CONTROL_DIR = '.rootagent';
const GIT_CONTROL_DIR = '.git';

function normalizedProjectPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}

export function isRootAgentControlPath(value) {
  const normalized = normalizedProjectPath(value);
  return normalized === ROOTAGENT_CONTROL_DIR || normalized.startsWith(`${ROOTAGENT_CONTROL_DIR}/`);
}

function isGitControlPath(value) {
  const normalized = normalizedProjectPath(value);
  return normalized === GIT_CONTROL_DIR || normalized.startsWith(`${GIT_CONTROL_DIR}/`);
}

function isProductPath(value) {
  return !isRootAgentControlPath(value) && !isGitControlPath(value);
}

function trackedFiles(cwd) {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.toString('utf-8').split('\0').filter(Boolean).filter(isProductPath).sort();
  } catch {
    const result = [];
    const walk = rel => {
      const dir = path.join(cwd, rel);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = rel ? path.join(rel, entry.name) : entry.name;
        if (entry.name === 'node_modules' || !isProductPath(child)) continue;
        if (entry.isDirectory()) walk(child);
        else result.push(child);
      }
    };
    walk('');
    return result.filter(isProductPath).sort();
  }
}

export function projectTreeHash(cwd) {
  const hash = crypto.createHash('sha256');
  const files = trackedFiles(cwd);
  for (const rel of files) {
    const abs = path.join(cwd, rel);
    let stat;
    try { stat = fs.lstatSync(abs); } catch { continue; }
    hash.update(rel.split(path.sep).join('/') + '\0');
    if (stat.isSymbolicLink()) hash.update('symlink\0' + fs.readlinkSync(abs));
    else if (stat.isFile()) hash.update(fs.readFileSync(abs));
    hash.update('\0');
  }
  return { treeHash: hash.digest('hex'), files: files.length };
}

export function changedPaths(cwd, baseCommit = '') {
  try {
    const args = baseCommit ? ['diff', '--name-only', baseCommit, '--'] : ['diff', '--name-only', 'HEAD', '--'];
    const changed = execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
    return [...new Set([...changed, ...untracked].filter(isProductPath))].sort();
  } catch { return []; }
}

export function commitChangedPaths(cwd, commit = 'HEAD') {
  try {
    return execFileSync('git', ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit, '--'], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean).filter(isProductPath).sort();
  } catch { return []; }
}

export function commitRootAgentControlPaths(cwd, commit = 'HEAD') {
  try {
    return execFileSync('git', ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit, '--'], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean).filter(isRootAgentControlPath).sort();
  } catch { return []; }
}

export function taskContractDigest(task) {
  const contract = {
    id: task.id,
    name: task.name,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria || [],
    validationCommands: task.validationCommands || [],
    dependsOn: task.dependsOn || [],
    writes: task.writes || [],
    requiresReview: !!task.requiresReview,
  };
  if (task.setupCommands !== undefined) contract.setupCommands = task.setupCommands || [];
  if (task.resources !== undefined) contract.resources = task.resources || [];
  if (task.hostPolicy !== undefined) contract.hostPolicy = task.hostPolicy || null;
  for (const key of ['proposalSource', 'improvementSource', 'requirementCoverage']) if (task[key] !== undefined) contract[key] = task[key];
  return sha256(contract);
}

export function createAttempt(cwd, task, sequence, leaseMs) {
  const now = Date.now();
  return {
    attemptId: crypto.randomUUID(),
    taskId: task.id,
    owner: workerIdentity(),
    status: 'ACTIVE',
    fencingToken: sequence,
    baseRevision: task.revision ?? null,
    baseCommit: currentCommit(cwd),
    acquiredAt: new Date(now).toISOString(),
    leaseUntil: new Date(now + leaseMs).toISOString(),
  };
}

export function assertAttempt(task, supplied = {}) {
  const attempt = task.attempt;
  if (!attempt || attempt.status !== 'ACTIVE') return { ok: false, reason: '任务没有 ACTIVE Attempt' };
  if (Date.now() > new Date(attempt.leaseUntil).getTime()) return { ok: false, reason: `Attempt lease 已过期：${attempt.leaseUntil}` };
  if (supplied.attemptId && supplied.attemptId !== attempt.attemptId) return { ok: false, reason: 'stale attemptId' };
  if (supplied.fencingToken != null && Number(supplied.fencingToken) !== attempt.fencingToken) return { ok: false, reason: 'stale fencing token' };
  return { ok: true, attempt };
}

export function createCandidate(cwd, task) {
  const tree = projectTreeHash(cwd);
  const candidate = {
    candidateId: crypto.randomUUID(),
    contractDigest: task.contractDigest || taskContractDigest(task),
    treeHash: tree.treeHash,
    fileCount: tree.files,
    baseCommit: task.attempt?.baseCommit || '',
    commit: currentCommit(cwd),
    changedPaths: changedPaths(cwd, task.attempt?.baseCommit || ''),
    commitChangedPaths: commitChangedPaths(cwd),
    createdAt: new Date().toISOString(),
  };
  candidate.digest = sha256(candidate);
  return candidate;
}
