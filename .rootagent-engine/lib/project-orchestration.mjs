import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { atomicWriteJson, durableAppendJsonLine, isRootAgentControlPath, projectTreeHash, readJson, sha256 } from './trust-core.mjs';
import { commandDisplay, commandIdentity, isCommandSpec, validateCommandSpec } from './command-execution.mjs';
import { evaluateAcceptanceCriteria, formatAcceptanceFinding } from './acceptance-criteria-quality.mjs';
import { validateRequirementManifest } from './requirement-coverage.mjs';

export const ORCHESTRATION_SCHEMA_VERSION = 1;
export const ADAPTER_OPERATIONS = Object.freeze(['start', 'status', 'send', 'wait', 'cancel', 'resume']);
export const ROLES = Object.freeze(['maker', 'checker', 'planner', 'integrator', 'reviewer']);
export const ROLE_CAPABILITIES = Object.freeze({
  maker: Object.freeze({ allow: ['code:read', 'workspace:write', 'command:run', 'candidate:propose'], deny: ['policy:write', 'verifier:write', 'attestation:write', 'approval:write', 'receipt:write', 'integration:write'] }),
  checker: Object.freeze({ allow: ['code:read', 'candidate:read', 'command:validate', 'attestation:write'], deny: ['workspace:write', 'policy:write', 'approval:write', 'receipt:write', 'integration:write'] }),
  planner: Object.freeze({ allow: ['code:read', 'proposal:write'], deny: ['workspace:write', 'task-graph:write', 'attestation:write', 'approval:write', 'receipt:write', 'integration:write'] }),
  integrator: Object.freeze({ allow: ['candidate:read', 'integration:write', 'command:validate', 'receipt:write'], deny: ['workspace:write', 'policy:write', 'verifier:write', 'attestation:write', 'approval:write'] }),
  reviewer: Object.freeze({ allow: ['code:read', 'candidate:read', 'attestation:read', 'approval:write'], deny: ['workspace:write', 'policy:write', 'verifier:write', 'attestation:write', 'receipt:write', 'integration:write'] }),
});

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const safeId = value => String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
const root = cwd => path.join(cwd, '.rootagent', 'runtime', 'orchestration');
const store = (cwd, name) => path.join(root(cwd), name);
const git = (cwd, args, options = {}) => execFileSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
function seal(value) { const copy = clone(value); delete copy.digest; value.digest = sha256(copy); return value; }

function orchestrationError(code, message, data = {}) {
  const error = new Error(message); error.code = code; error.data = data; return error;
}

function isGitRepo(cwd) {
  try { return git(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true'; } catch { return false; }
}
export function isGitProject(cwd) { return isGitRepo(cwd); }

function branchName(cwd) {
  try { return git(cwd, ['symbolic-ref', '--short', 'HEAD']); }
  catch { throw orchestrationError('DETACHED_TARGET', '目标工作区必须位于命名分支，不能是 detached HEAD'); }
}

function gitStatusPaths(cwd) {
  // Porcelain v1 uses leading spaces as significant status bytes (e.g. " M path").
  // Never pass this output through the generic trimmed git() helper or the first path
  // character can be lost for unstaged modifications.
  const output = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], {
    cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!output) return [];
  return output.split('\0').filter(Boolean).filter(line => {
    const rel = line.slice(3);
    if (rel.startsWith('.rootagent/runtime/')) return false;
    return !(line.slice(0, 2) === '??' && rel.startsWith('.rootagent/'));
  }).map(line => line.slice(3)).sort();
}

// Self-hosting invariant: tracked durable .rootagent state may be dirty while RootAgent is
// running. Target-branch safety gates therefore care about product dirtiness, not control-plane
// dirtiness. Candidate worktrees still use gitStatusPaths() directly and remain strict.
function productStatusPaths(cwd) {
  return gitStatusPaths(cwd).filter(rel => !isRootAgentControlPath(rel));
}

function changedCommittedPaths(cwd, base, head = 'HEAD') {
  const output = git(cwd, ['diff', '--name-only', '-z', `${base}..${head}`, '--']);
  return output.split('\0').filter(Boolean).sort();
}

function workspaceDir(cwd, workspaceId) {
  const repo = path.basename(cwd);
  return path.join(path.dirname(cwd), `.${repo}-rootagent-worktrees`, safeId(workspaceId));
}

function workspaceFile(cwd, workspaceId) { return store(cwd, path.join('workspaces', `${safeId(workspaceId)}.json`)); }
function candidateFile(cwd, digest) { return store(cwd, path.join('candidates', `${safeId(digest)}.json`)); }
function queueFile(cwd) { return store(cwd, path.join('integration', 'queue.json')); }
function resourcesFile(cwd) { return store(cwd, 'resources.json'); }

function normalizeResource(value) {
  const raw = String(value || '').trim();
  if (!raw) throw orchestrationError('INVALID_RESOURCE', '资源不能为空');
  const i = raw.indexOf(':');
  const type = i < 0 ? 'file' : raw.slice(0, i).toLowerCase();
  const name = (i < 0 ? raw : raw.slice(i + 1)).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!['file', 'port', 'db', 'env', 'lockfile'].includes(type) || !name || name.includes('..')) throw orchestrationError('INVALID_RESOURCE', `无效资源：${raw}`);
  return `${type}:${name}`;
}

function resourceConflict(a, b) {
  const [at, ...an] = a.split(':'); const [bt, ...bn] = b.split(':');
  if (at !== bt) return false;
  const av = an.join(':'); const bv = bn.join(':');
  if (at !== 'file') return av === bv;
  const clean = value => value.replace(/\/\*\*?$/, '').replace(/\/$/, '');
  const x = clean(av); const y = clean(bv);
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

function activeResourceState(cwd) {
  const state = readJson(resourcesFile(cwd), { schemaVersion: 1, revision: 0, nextFence: 1, locks: [] });
  const time = Date.now();
  state.locks = state.locks.filter(lock => lock.status === 'ACTIVE' && new Date(lock.leaseUntil).getTime() > time);
  return state;
}

function acquireResources(cwd, workspaceId, resources, leaseMs) {
  const state = activeResourceState(cwd); const wanted = [...new Set(resources.map(normalizeResource))].sort();
  const conflicts = [];
  for (const resource of wanted) for (const lock of state.locks) {
    if (lock.workspaceId !== workspaceId && resourceConflict(resource, lock.resource)) conflicts.push({ resource, heldResource: lock.resource, workspaceId: lock.workspaceId, leaseUntil: lock.leaseUntil });
  }
  if (conflicts.length) throw orchestrationError('RESOURCE_CONFLICT', `${conflicts.length} 个资源正被其他工作区占用`, { conflicts });
  const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
  const locks = wanted.map(resource => ({ resource, workspaceId, fencingToken: state.nextFence++, leaseUntil, status: 'ACTIVE', acquiredAt: now() }));
  state.locks.push(...locks); state.revision += 1; atomicWriteJson(resourcesFile(cwd), state);
  return locks;
}

function releaseResources(cwd, workspaceId) {
  const state = activeResourceState(cwd); const before = state.locks.length;
  state.locks = state.locks.filter(lock => lock.workspaceId !== workspaceId); state.revision += 1;
  atomicWriteJson(resourcesFile(cwd), state); return before - state.locks.length;
}

export function createWorkspace(cwd, task, options = {}) {
  if (!isGitRepo(cwd)) throw orchestrationError('GIT_REQUIRED', '写并行要求 Git；非 Git 项目默认禁止创建写工作区');
  if (!task?.id || task.status !== 'in_progress' || !task.attempt || task.attempt.status !== 'ACTIVE') throw orchestrationError('ACTIVE_ATTEMPT_REQUIRED', '工作区必须绑定 in_progress 任务的 ACTIVE Attempt');
  const workspaceId = options.workspaceId || `ws_${safeId(task.id)}_${crypto.randomUUID().slice(0, 8)}`;
  if (fs.existsSync(workspaceFile(cwd, workspaceId))) throw orchestrationError('WORKSPACE_EXISTS', `工作区已存在：${workspaceId}`);
  const baseCommit = git(cwd, ['rev-parse', options.base || task.attempt.baseCommit || 'HEAD']);
  if (task.attempt.baseCommit && baseCommit !== task.attempt.baseCommit) throw orchestrationError('BASE_COMMIT_MISMATCH', '工作区 base 必须等于 Attempt 绑定的 baseCommit');
  const targetBranch = branchName(cwd); const worktreePath = workspaceDir(cwd, workspaceId);
  if (fs.existsSync(worktreePath)) throw orchestrationError('WORKTREE_PATH_EXISTS', `工作树路径已存在：${worktreePath}`);
  const branch = `rootagent/${safeId(task.id)}/${workspaceId.slice(-8)}`;
  const declaredWrites = [...new Set(task.writes || [])].sort();
  const resources = [...declaredWrites.map(value => normalizeResource(`file:${value}`)), ...(task.resources || []).map(normalizeResource), ...(options.resources || []).map(normalizeResource)];
  const attemptRemaining = new Date(task.attempt.leaseUntil).getTime() - Date.now();
  if (attemptRemaining <= 0) throw orchestrationError('LEASE_EXPIRED', `Attempt lease 已过期：${task.attempt.leaseUntil}`);
  const locks = acquireResources(cwd, workspaceId, resources, Math.min(Number(options.leaseMs || 60 * 60 * 1000), attemptRemaining));
  try {
    git(cwd, ['worktree', 'add', '-b', branch, worktreePath, baseCommit]);
  }
  catch (error) {
    if (fs.existsSync(worktreePath)) try { git(cwd, ['worktree', 'remove', '--force', worktreePath]); } catch { /* 保留现场供人工诊断 */ }
    try { git(cwd, ['branch', '-D', branch]); } catch { /* 分支可能尚未创建 */ }
    releaseResources(cwd, workspaceId);
    throw orchestrationError('WORKTREE_CREATE_FAILED', error.stderr?.trim() || error.message);
  }
  const record = {
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION, workspaceId, taskId: task.id, attemptId: task.attempt.attemptId,
    fencingToken: task.attempt.fencingToken, contractDigest: task.contractDigest, path: worktreePath, branch,
    baseCommit, targetBranch, declaredWrites, resources: locks, validationCommands: clone(task.validationCommands || []),
    setupCommands: clone(task.setupCommands || []), runtimeStatus: (task.setupCommands || []).length ? 'REQUIRED' : 'NOT_REQUIRED', runtimeReceipts: [],
    status: 'ACTIVE', createdAt: now(), updatedAt: now(),
  };
  seal(record); atomicWriteJson(workspaceFile(cwd, workspaceId), record);
  durableAppendJsonLine(store(cwd, 'events.jsonl'), { type: 'WORKSPACE_CREATED', at: now(), workspaceId, taskId: task.id, baseCommit, branch, resources: locks.map(lock => lock.resource) });
  return record;
}

export function preflightWorkspaceBatch(cwd, tasks, options = {}) {
  if (!isGitRepo(cwd)) throw orchestrationError('GIT_REQUIRED', '并行 worktree 要求 Git');
  const dirty = productStatusPaths(cwd); if (dirty.length) throw orchestrationError('DIRTY_TARGET', '批量 worktree 基线存在未提交产品修改', { paths: dirty });
  const targetBranch = branchName(cwd); const baseCommit = git(cwd, ['rev-parse', options.base || 'HEAD']); const active = activeResourceState(cwd);
  const descriptors = tasks.map(task => {
    const workspaceId = options.workspaceIds?.[task.id] || `ws_${safeId(task.id)}_${crypto.randomUUID().slice(0, 8)}`;
    const branch = `rootagent/${safeId(task.id)}/${workspaceId.slice(-8)}`; const worktreePath = workspaceDir(cwd, workspaceId);
    if (fs.existsSync(workspaceFile(cwd, workspaceId)) || fs.existsSync(worktreePath)) throw orchestrationError('WORKTREE_PATH_EXISTS', `批量预检发现工作区目标已存在：${workspaceId}`);
    try { git(cwd, ['show-ref', '--verify', `refs/heads/${branch}`]); throw orchestrationError('WORKSPACE_BRANCH_EXISTS', `批量预检发现分支已存在：${branch}`); } catch (error) { if (error.code === 'WORKSPACE_BRANCH_EXISTS') throw error; }
    const resources = [...(task.writes || []).map(value => normalizeResource(`file:${value}`)), ...(task.resources || []).map(normalizeResource)];
    return { taskId: task.id, workspaceId, branch, path: worktreePath, baseCommit, targetBranch, resources };
  });
  for (let i = 0; i < descriptors.length; i++) for (let j = i + 1; j < descriptors.length; j++) {
    const shared = descriptors[i].resources.find(a => descriptors[j].resources.some(b => resourceConflict(a, b)));
    if (shared) throw orchestrationError('RESOURCE_CONFLICT', `批量预检发现任务资源冲突：${shared}`);
  }
  for (const descriptor of descriptors) for (const resource of descriptor.resources) for (const lock of active.locks) {
    if (resourceConflict(resource, lock.resource)) throw orchestrationError('RESOURCE_CONFLICT', `批量预检发现资源已占用：${resource}`, { lock });
  }
  return { baseCommit, targetBranch, descriptors };
}

export function rollbackWorkspaceBatch(cwd, records, reason = 'batch creation failed') {
  const rolledBack = [];
  for (const value of [...records].reverse()) {
    const workspaceId = value.workspaceId; const file = workspaceFile(cwd, workspaceId); const record = fs.existsSync(file) ? readJson(file) : value;
    if (record?.path && fs.existsSync(record.path)) try { git(cwd, ['worktree', 'remove', '--force', record.path]); } catch { fs.rmSync(record.path, { recursive: true, force: true }); try { git(cwd, ['worktree', 'prune']); } catch { /* 后续分支清理仍会验证结果 */ } }
    if (record?.branch) try { git(cwd, ['branch', '-D', record.branch]); } catch { /* 分支可能已随 worktree 清理 */ }
    releaseResources(cwd, workspaceId);
    if (fs.existsSync(file)) fs.rmSync(file);
    rolledBack.push(workspaceId);
  }
  durableAppendJsonLine(store(cwd, 'events.jsonl'), { type: 'WORKSPACE_BATCH_ROLLED_BACK', at: now(), reason, workspaceIds: rolledBack });
  return rolledBack;
}

export function loadWorkspace(cwd, workspaceId) {
  const record = readJson(workspaceFile(cwd, workspaceId));
  if (!record) throw orchestrationError('WORKSPACE_NOT_FOUND', `工作区不存在：${workspaceId}`);
  const copy = clone(record); const digest = copy.digest; delete copy.digest;
  if (digest !== sha256(copy)) throw orchestrationError('WORKSPACE_CORRUPT', `工作区摘要失配：${workspaceId}`);
  return record;
}

export function listWorkspaces(cwd) {
  const dir = store(cwd, 'workspaces');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(file => file.endsWith('.json')).map(file => readJson(path.join(dir, file))).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : [];
}

function workspaceSnapshot(dir, prefix = '', result = new Map()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!prefix && entry.name === '.git') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name; const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) workspaceSnapshot(absolute, rel, result);
    else { const stat = fs.lstatSync(absolute); result.set(rel, `${stat.size}:${stat.mtimeMs}:${entry.isSymbolicLink() ? fs.readlinkSync(absolute) : ''}`); }
  }
  return result;
}

export function prepareWorkspaceRuntime(cwd, workspaceId, options = {}) {
  const workspace = loadWorkspace(cwd, workspaceId);
  if (workspace.status !== 'ACTIVE') throw orchestrationError('WORKSPACE_NOT_ACTIVE', `工作区状态为 ${workspace.status}`);
  if (!fs.existsSync(workspace.path)) throw orchestrationError('WORKTREE_MISSING', `工作树目录不存在：${workspace.path}`);
  const commands = workspace.setupCommands || [];
  if (!commands.length) return { workspace, status: 'NOT_REQUIRED', receipts: [], duplicate: true };
  if (workspace.runtimeStatus === 'READY') return { workspace, status: 'READY', receipts: workspace.runtimeReceipts || [], duplicate: true, preparationId: workspace.runtimePreparation?.preparationId || null };
  if (workspace.runtimeStatus === 'PREPARING' && preparationOwnerActive(workspace.runtimePreparation?.owner)) {
    throw orchestrationError('WORKSPACE_PREPARE_IN_PROGRESS', `工作区运行时正由 ${workspace.runtimePreparation.owner.worker} 准备`, { runtimePreparation: workspace.runtimePreparation });
  }
  if (typeof options.executeSetup !== 'function') throw orchestrationError('SETUP_EXECUTOR_REQUIRED', 'workspace prepare 需要统一 setup executor');
  const preparationId = crypto.randomUUID();
  workspace.runtimeStatus = 'PREPARING';
  workspace.runtimeReceipts = [];
  workspace.runtimePreparation = {
    preparationId,
    owner: { pid: process.pid, host: os.hostname(), worker: process.env.ROOTAGENT_WORKER_ID || 'local-cli', startedAt: now() },
    startedAt: now(),
  };
  workspace.updatedAt = now(); seal(workspace); atomicWriteJson(workspaceFile(cwd, workspaceId), workspace);
  const receipts = [];
  for (const command of commands) {
    let result; const before = workspaceSnapshot(workspace.path);
    try { result = options.executeSetup(command, workspace.path); }
    catch (error) { result = { ok: false, code: 70, out: error.message, receipt: { errorCode: error.code || 'SETUP_ERROR', message: error.message } }; }
    const after = workspaceSnapshot(workspace.path); const changed = [...new Set([...before.keys(), ...after.keys()])].filter(rel => before.get(rel) !== after.get(rel));
    const outsideDeclared = changed.filter(rel => !pathAllowed(rel, command.writePaths || []));
    if (outsideDeclared.length) result = { ...result, ok: false, code: 73, out: `${result.out || ''}\nsetup 写出声明范围：${outsideDeclared.join(', ')}`, receipt: { ...(result.receipt || {}), errorCode: 'SETUP_WRITE_SET_VIOLATION', outsideDeclared } };
    receipts.push({ commandIdentity: commandIdentity(command), command: commandDisplay(command), verdict: result.ok ? 'PASS' : 'FAIL', exitCode: result.code ?? 70, changedPaths: changed, receipt: result.receipt || null });
    if (!result.ok) break;
  }
  workspace.runtimeReceipts = receipts; workspace.runtimeStatus = receipts.length === commands.length && receipts.every(item => item.verdict === 'PASS') ? 'READY' : 'FAILED'; workspace.updatedAt = now();
  workspace.runtimePreparation = { preparationId, startedAt: workspace.runtimePreparation.startedAt, completedAt: now(), status: workspace.runtimeStatus };
  seal(workspace); atomicWriteJson(workspaceFile(cwd, workspaceId), workspace);
  durableAppendJsonLine(store(cwd, 'events.jsonl'), { type: 'WORKSPACE_RUNTIME_PREPARED', at: now(), workspaceId, taskId: workspace.taskId, preparationId, runtimeStatus: workspace.runtimeStatus, receipts });
  return { workspace, status: workspace.runtimeStatus, receipts, duplicate: false, preparationId };
}

function pathAllowed(rel, patterns) {
  const value = rel.replace(/\\/g, '/');
  return patterns.some(pattern => {
    const normalized = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '');
    if (normalized.endsWith('/**')) { const prefix = normalized.slice(0, -3).replace(/\/$/, ''); return value === prefix || value.startsWith(`${prefix}/`); }
    if (normalized.endsWith('/*')) { const prefix = normalized.slice(0, -2).replace(/\/$/, ''); return value.startsWith(`${prefix}/`) && !value.slice(prefix.length + 1).includes('/'); }
    return value === normalized || value.startsWith(`${normalized.replace(/\/$/, '')}/`);
  });
}
export function snapshotWorkspaceCandidate(cwd, workspaceId, task = null) {
  const workspace = loadWorkspace(cwd, workspaceId);
  if (workspace.status !== 'ACTIVE') throw orchestrationError('WORKSPACE_NOT_ACTIVE', `工作区状态为 ${workspace.status}`);
  if (task && (task.id !== workspace.taskId || task.attempt?.attemptId !== workspace.attemptId || task.attempt?.fencingToken !== workspace.fencingToken)) throw orchestrationError('STALE_WORKSPACE', '工作区绑定的 Attempt/Fencing 已失效');
  if (task && new Date(task.attempt.leaseUntil).getTime() <= Date.now()) throw orchestrationError('LEASE_EXPIRED', `Attempt lease 已过期：${task.attempt.leaseUntil}`);
  const resourceState = activeResourceState(cwd); const activeLocks = resourceState.locks.filter(lock => lock.workspaceId === workspaceId);
  if (activeLocks.length !== workspace.resources.length) throw orchestrationError('RESOURCE_LEASE_LOST', '工作区资源 lease 已过期或被回收，拒绝创建候选');
  if (!fs.existsSync(workspace.path)) throw orchestrationError('WORKTREE_MISSING', `工作树目录不存在：${workspace.path}`);
  if ((workspace.setupCommands || []).length && workspace.runtimeStatus !== 'READY') throw orchestrationError('RUNTIME_NOT_READY', `工作区运行时尚未准备成功：${workspace.runtimeStatus}`, { runtimeReceipts: workspace.runtimeReceipts || [] });
  const dirty = gitStatusPaths(workspace.path);
  if (dirty.length) throw orchestrationError('DIRTY_WORKTREE', '候选必须来自已提交且干净的工作树', { paths: dirty });
  const headCommit = git(workspace.path, ['rev-parse', 'HEAD']);
  if (headCommit === workspace.baseCommit) throw orchestrationError('EMPTY_CANDIDATE', '工作区没有产生提交');
  const actualWrites = changedCommittedPaths(workspace.path, workspace.baseCommit, headCommit);
  const controlWrites = actualWrites.filter(isRootAgentControlPath);
  if (controlWrites.length) throw orchestrationError('ROLE_CAPABILITY_VIOLATION', 'Maker 产品候选不能包含 .rootagent 控制面路径；控制状态必须由后续 Audit Seal 独立提交', { protectedWrites: controlWrites, controlWrites });
  const outsideDeclared = actualWrites.filter(rel => !pathAllowed(rel, workspace.declaredWrites));
  if (outsideDeclared.length) throw orchestrationError('WRITE_SET_VIOLATION', '实际 diff 超出声明 writes', { actualWrites, declaredWrites: workspace.declaredWrites, outsideDeclared });
  const tree = projectTreeHash(workspace.path);
  const candidate = {
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION, candidateId: crypto.randomUUID(), workspaceId, taskId: workspace.taskId,
    attemptId: workspace.attemptId, fencingToken: workspace.fencingToken, contractDigest: workspace.contractDigest,
    baseCommit: workspace.baseCommit, headCommit, treeHash: tree.treeHash, fileCount: tree.files,
    actualWrites, declaredWrites: workspace.declaredWrites, validationCommands: workspace.validationCommands, setupCommands: workspace.setupCommands || [], runtimeReceipts: workspace.runtimeReceipts || [], createdAt: now(),
  };
  candidate.digest = sha256(candidate); const file = candidateFile(cwd, candidate.digest);
  if (!fs.existsSync(file)) atomicWriteJson(file, candidate);
  durableAppendJsonLine(store(cwd, 'events.jsonl'), { type: 'CANDIDATE_SNAPSHOTTED', at: now(), workspaceId, taskId: workspace.taskId, candidateDigest: candidate.digest, headCommit, actualWrites });
  return candidate;
}

export function loadCandidate(cwd, digest) {
  const candidate = readJson(candidateFile(cwd, digest));
  if (!candidate) throw orchestrationError('CANDIDATE_NOT_FOUND', `候选不存在：${digest}`);
  const copy = clone(candidate); const saved = copy.digest; delete copy.digest;
  if (saved !== sha256(copy)) throw orchestrationError('CANDIDATE_CORRUPT', `候选摘要失配：${digest}`);
  return candidate;
}

export function releaseWorkspace(cwd, workspaceId, options = {}) {
  const workspace = loadWorkspace(cwd, workspaceId);
  if (workspace.status === 'RELEASED') return { workspace, duplicate: true, releasedLocks: 0 };
  if (options.remove && fs.existsSync(workspace.path)) {
    if (gitStatusPaths(workspace.path).length) throw orchestrationError('DIRTY_WORKTREE', '拒绝移除有未提交修改的工作树');
    git(cwd, ['worktree', 'remove', workspace.path]);
  }
  const releasedLocks = releaseResources(cwd, workspaceId); workspace.status = 'RELEASED'; workspace.updatedAt = now(); workspace.releasedAt = now();
  seal(workspace); atomicWriteJson(workspaceFile(cwd, workspaceId), workspace);
  durableAppendJsonLine(store(cwd, 'events.jsonl'), { type: 'WORKSPACE_RELEASED', at: now(), workspaceId, releasedLocks, removed: !!options.remove });
  return { workspace, duplicate: false, releasedLocks };
}

function loadQueue(cwd) { return readJson(queueFile(cwd), { schemaVersion: 1, revision: 0, entries: [] }); }
function saveQueue(cwd, queue) { queue.revision += 1; atomicWriteJson(queueFile(cwd), queue); }

export function enqueueCandidate(cwd, digest) {
  const candidate = loadCandidate(cwd, digest); const queue = loadQueue(cwd);
  const prior = queue.entries.find(entry => entry.candidateDigest === digest);
  if (prior) return { entry: prior, duplicate: true };
  const entry = { schemaVersion: 1, entryId: `iq_${crypto.randomUUID()}`, candidateDigest: digest, taskId: candidate.taskId, targetBranch: loadWorkspace(cwd, candidate.workspaceId).targetBranch, status: 'QUEUED', enqueuedAt: now(), attempts: 0 };
  queue.entries.push(entry); saveQueue(cwd, queue); durableAppendJsonLine(store(cwd, path.join('integration', 'events.jsonl')), { type: 'INTEGRATION_ENQUEUED', at: now(), ...entry });
  return { entry, duplicate: false };
}

export function listIntegrationQueue(cwd) { return loadQueue(cwd); }

function runValidationCommands(cwd, commands, executor = null) {
  return commands.map(value => {
    const started = Date.now();
    if (!executor) throw orchestrationError('COMMAND_EXECUTOR_REQUIRED', '集成验证必须使用统一命令执行器');
    const result = executor(value, cwd); const output = String(result.out || ''); const exitCode = result.code;
    return { command: commandDisplay(value), commandIdentity: commandIdentity(value), verdict: exitCode === 0 ? 'PASS' : 'FAIL', exitCode: exitCode ?? 70, durationMs: Date.now() - started, outputDigest: sha256(output), outputTail: output.slice(-4000), ...(result.receipt ? { securityReceipt: result.receipt } : {}) };
  });
}

function cleanupIntegrationWorktree(cwd, tempPath, branch) {
  try { git(cwd, ['worktree', 'remove', tempPath]); } catch { /* 保留现场供人工诊断 */ return false; }
  try { git(cwd, ['branch', '-D', branch]); } catch { /* 已被清理或仍被引用 */ }
  return true;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function preparationOwnerActive(owner) {
  if (!owner) return false;
  if (owner.host !== os.hostname()) return true; // 远端进程无法可靠探测，保守地拒绝抢占。
  return processAlive(owner.pid);
}

function recoverOrphanedIntegration(cwd, queue) {
  const active = queue.entries.find(entry => entry.status === 'APPLYING');
  if (!active) return null;
  if (active.owner?.host !== os.hostname() || processAlive(active.owner?.pid)) return active;
  if (active.tempPath && fs.existsSync(active.tempPath)) {
    try { git(active.tempPath, ['merge', '--abort']); } catch { /* merge 可能尚未开始 */ }
    if (!cleanupIntegrationWorktree(cwd, active.tempPath, active.tempBranch)) return active;
  } else if (active.tempBranch) try { git(cwd, ['branch', '-D', active.tempBranch]); } catch { /* 分支可能尚未创建 */ }
  active.status = 'QUEUED'; active.recoveredAt = now(); active.lastInfrastructureFailure = { at: now(), code: 'ORPHANED_INTEGRATOR', message: '检测到 Integrator 进程退出，已从安全 checkpoint 重新入队' };
  saveQueue(cwd, queue); return null;
}

export function integrateNext(cwd, options = {}) {
  if (!isGitRepo(cwd)) throw orchestrationError('GIT_REQUIRED', '集成队列要求 Git');
  const queue = loadQueue(cwd); const active = recoverOrphanedIntegration(cwd, queue);
  if (active) throw orchestrationError('INTEGRATION_BUSY', `已有集成项处理中：${active.entryId}`);
  const entry = options.entryId ? queue.entries.find(item => item.entryId === options.entryId) : queue.entries.find(item => item.status === 'QUEUED');
  if (!entry) throw orchestrationError('NO_QUEUED_CANDIDATE', '没有待集成候选');
  if (entry.status !== 'QUEUED') throw orchestrationError('INTEGRATION_NOT_QUEUED', `集成项状态为 ${entry.status}`);
  if (branchName(cwd) !== entry.targetBranch) throw orchestrationError('TARGET_BRANCH_MISMATCH', `当前分支不是目标分支 ${entry.targetBranch}`);
  const dirty = productStatusPaths(cwd); if (dirty.length) throw orchestrationError('DIRTY_TARGET', '目标分支有未提交产品修改，拒绝集成', { paths: dirty });
  const candidate = loadCandidate(cwd, entry.candidateDigest); const preHead = git(cwd, ['rev-parse', 'HEAD']);
  if (typeof options.authorizeValidation === 'function') options.authorizeValidation(candidate);
  const suffix = entry.entryId.slice(-8); const tempBranch = `rootagent/integration/${suffix}`; const tempPath = workspaceDir(cwd, `integration_${suffix}`);
  entry.status = 'APPLYING'; entry.attempts += 1; entry.startedAt = now(); entry.preHead = preHead; entry.tempBranch = tempBranch; entry.tempPath = tempPath; entry.owner = { pid: process.pid, host: os.hostname() }; saveQueue(cwd, queue);
  if (options.crashPoint === 'after_integration_claim') process.exit(87);
  try {
    git(cwd, ['worktree', 'add', '-b', tempBranch, tempPath, preHead]);
    const merge = spawnSync('git', ['merge', '--no-ff', '--no-edit', candidate.headCommit], { cwd: tempPath, encoding: 'utf-8' });
    if (merge.status !== 0) {
      try { git(tempPath, ['merge', '--abort']); } catch { /* noop */ }
      entry.status = 'CONFLICT'; entry.failure = { class: 'CONFLICT', message: `${merge.stdout || ''}${merge.stderr || ''}`.slice(-4000) };
      entry.resolutionTask = { taskId: `integration_${suffix}`, kind: 'INTEGRATION_CONFLICT', candidateDigest: candidate.digest, targetHead: preHead, status: 'PENDING', acceptanceCriteria: ['冲突已逐项解决', '候选实际写集保持可追溯', '最新目标分支验证全部通过'] };
      entry.completedAt = now(); cleanupIntegrationWorktree(cwd, tempPath, tempBranch); saveQueue(cwd, queue);
      return { entry, status: 'CONFLICT' };
    }
    const integrationCommit = git(tempPath, ['rev-parse', 'HEAD']);
    const setupChecks = runValidationCommands(tempPath, candidate.setupCommands || [], options.executeSetup);
    const setupFailed = setupChecks.filter(check => check.verdict !== 'PASS');
    if (setupFailed.length) {
      entry.status = 'SETUP_FAILED'; entry.failure = { class: 'INFRASTRUCTURE', message: `${setupFailed.length}/${setupChecks.length} 个 setup 命令失败` };
      entry.setupChecks = setupChecks; entry.integrationCommit = integrationCommit; entry.completedAt = now(); cleanupIntegrationWorktree(cwd, tempPath, tempBranch); saveQueue(cwd, queue);
      return { entry, status: entry.status };
    }
    const checks = runValidationCommands(tempPath, candidate.validationCommands || [], options.executeValidation); const failed = checks.filter(check => check.verdict !== 'PASS');
    if (failed.length || !checks.length) {
      entry.status = 'VALIDATION_FAILED'; entry.failure = { class: 'VERIFIER', message: !checks.length ? '候选没有集成后验证命令' : `${failed.length}/${checks.length} 个验证命令失败` };
      entry.checks = checks; entry.integrationCommit = integrationCommit; entry.completedAt = now(); cleanupIntegrationWorktree(cwd, tempPath, tempBranch); saveQueue(cwd, queue);
      return { entry, status: entry.status };
    }
    if (typeof options.verifyImprovement === 'function') options.verifyImprovement(candidate, tempPath);
    if (git(cwd, ['rev-parse', 'HEAD']) !== preHead) throw orchestrationError('TARGET_MOVED', '验证期间目标分支 HEAD 已变化');
    if (productStatusPaths(cwd).length) throw orchestrationError('DIRTY_TARGET', '验证期间目标分支产生未提交产品修改');
    git(cwd, ['merge', '--ff-only', integrationCommit]);
    const targetHead = git(cwd, ['rev-parse', 'HEAD']);
    const receipt = { schemaVersion: 1, receiptId: crypto.randomUUID(), entryId: entry.entryId, candidateDigest: candidate.digest, contractDigest: candidate.contractDigest, preHead, targetHead, integrationCommit, setupChecks, checks, integratedAt: now() };
    receipt.digest = sha256(receipt); atomicWriteJson(store(cwd, path.join('integration', 'receipts', `${receipt.digest}.json`)), receipt);
    entry.status = 'INTEGRATED'; entry.integrationCommit = integrationCommit; entry.targetHead = targetHead; entry.receiptDigest = receipt.digest; entry.checks = checks; entry.completedAt = now();
    const workspace = loadWorkspace(cwd, candidate.workspaceId); workspace.status = 'INTEGRATED'; workspace.integrationReceiptDigest = receipt.digest; workspace.updatedAt = now();
    workspace.releasedLocks = releaseResources(cwd, workspace.workspaceId); seal(workspace); atomicWriteJson(workspaceFile(cwd, workspace.workspaceId), workspace);
    cleanupIntegrationWorktree(cwd, tempPath, tempBranch); saveQueue(cwd, queue);
    durableAppendJsonLine(store(cwd, path.join('integration', 'events.jsonl')), { type: 'INTEGRATION_COMPLETED', at: now(), entryId: entry.entryId, candidateDigest: candidate.digest, targetHead, receiptDigest: receipt.digest });
    return { entry, receipt, status: 'INTEGRATED' };
  } catch (error) {
    cleanupIntegrationWorktree(cwd, tempPath, tempBranch);
    entry.status = 'QUEUED'; entry.lastInfrastructureFailure = { at: now(), code: error.code || 'INTEGRATION_ERROR', message: error.message }; saveQueue(cwd, queue);
    throw error;
  }
}

function proposalErr(code, message, taskId = null) { return { code, message, ...(taskId ? { taskId } : {}) }; }
function validationCommandText(value) { return commandDisplay(value); }
function hasPath(tasks, from, target, seen = new Set()) {
  if (from === target) return true; if (seen.has(from)) return false; seen.add(from);
  const task = tasks.get(from); return (task?.dependsOn || []).some(dep => hasPath(tasks, dep, target, new Set(seen)));
}

function dependencyCycle(tasks) {
  const visiting = new Set(); const visited = new Set();
  const visit = id => {
    if (visiting.has(id)) return true; if (visited.has(id)) return false;
    visiting.add(id);
    for (const dep of tasks.get(id)?.dependsOn || []) if (tasks.has(dep) && visit(dep)) return true;
    visiting.delete(id); visited.add(id); return false;
  };
  return [...tasks.keys()].some(visit);
}

function evaluateNumericCalculation(node, depth = 0) {
  if (depth > 8) throw orchestrationError('NUMERIC_CALC_TOO_DEEP', '数值计算 AST 最深 8 层');
  if (typeof node === 'number') {
    if (!Number.isFinite(node)) throw orchestrationError('NUMERIC_CALC_INVALID', '数值计算只能包含有限数');
    return node;
  }
  if (!node || typeof node !== 'object' || typeof node.op !== 'string' || !Array.isArray(node.args) || node.args.length > 16) throw orchestrationError('NUMERIC_CALC_INVALID', 'calculation 必须是 {op,args}，每层最多 16 个参数');
  const args = node.args.map(value => evaluateNumericCalculation(value, depth + 1));
  let value;
  if (node.op === 'add' && args.length >= 2) value = args.reduce((a, b) => a + b, 0);
  else if (node.op === 'subtract' && args.length === 2) value = args[0] - args[1];
  else if (node.op === 'multiply' && args.length >= 2) value = args.reduce((a, b) => a * b, 1);
  else if (node.op === 'divide' && args.length === 2 && args[1] !== 0) value = args[0] / args[1];
  else if (node.op === 'pow' && args.length === 2) value = args[0] ** args[1];
  else if (node.op === 'sqrt' && args.length === 1 && args[0] >= 0) value = Math.sqrt(args[0]);
  else if (node.op === 'abs' && args.length === 1) value = Math.abs(args[0]);
  else throw orchestrationError('NUMERIC_CALC_INVALID', `不支持的数值计算或参数数量：${node.op}`);
  if (!Number.isFinite(value)) throw orchestrationError('NUMERIC_CALC_INVALID', '数值计算结果不是有限数');
  return value;
}

function criterionNumericTarget(criterion) {
  const match = String(criterion).match(/(?:≈|约为|约等于)\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i);
  return match ? Number(match[1]) : null;
}

export function validatePlannerProposal(input, options = {}) {
  const errors = []; const warnings = []; const proposal = clone(input || {}); delete proposal.digest;
  if (![1, 2].includes(proposal.schemaVersion)) errors.push(proposalErr('SCHEMA_VERSION', 'schemaVersion 必须为 1 或 2'));
  if (!proposal.proposalId || !/^[a-zA-Z0-9._-]+$/.test(proposal.proposalId)) errors.push(proposalErr('INVALID_PROPOSAL_ID', 'proposalId 无效'));
  if (!proposal.goal || typeof proposal.goal !== 'string') errors.push(proposalErr('GOAL_REQUIRED', 'goal 必须是非空字符串'));
  if (!Array.isArray(proposal.parentCriteria) || !proposal.parentCriteria.length) errors.push(proposalErr('PARENT_CRITERIA_REQUIRED', 'parentCriteria 不能为空'));
  if (!Array.isArray(proposal.tasks) || !proposal.tasks.length) errors.push(proposalErr('TASKS_REQUIRED', 'tasks 不能为空'));
  if (errors.length) return { ok: false, errors, warnings };
  const requirementCoverage = validateRequirementManifest(proposal, { projectGoal: options.projectGoal || '' });
  requirementCoverage.errors.forEach(item => errors.push(proposalErr(item.code, item.message)));
  requirementCoverage.warnings.forEach(item => warnings.push(proposalErr(item.code, item.message)));
  if (requirementCoverage.strict && requirementCoverage.requirementSourceDigest) {
    proposal.requirementSourceDigest = requirementCoverage.requirementSourceDigest;
  }
  const criteria = new Set();
  for (const criterion of proposal.parentCriteria) {
    if (!criterion?.id || criteria.has(criterion.id)) errors.push(proposalErr('INVALID_CRITERION', `父验收标准 id 缺失或重复：${criterion?.id || '(空)'}`));
    else criteria.add(criterion.id);
  }
  const tasks = new Map();
  for (const task of proposal.tasks) {
    if (!task?.id || tasks.has(task.id)) { errors.push(proposalErr('INVALID_TASK_ID', `任务 id 缺失或重复：${task?.id || '(空)'}`)); continue; }
    tasks.set(task.id, task);
    for (const field of ['dependsOn', 'artifacts', 'writes', 'resources', 'acceptanceCriteria', 'validationCommands', 'covers']) if (!Array.isArray(task[field])) errors.push(proposalErr('INVALID_TASK_FIELD', `${field} 必须是数组`, task.id));
    if (task.setupCommands != null && !Array.isArray(task.setupCommands)) errors.push(proposalErr('INVALID_TASK_FIELD', 'setupCommands 必须是数组', task.id));
    if (!task.risk || !['low', 'medium', 'high', 'critical'].includes(task.risk)) errors.push(proposalErr('INVALID_RISK', 'risk 必须是 low/medium/high/critical', task.id));
    if (!task.acceptanceCriteria?.length || !task.validationCommands?.length || !task.covers?.length) errors.push(proposalErr('UNVERIFIABLE_TASK', '每个任务必须有 acceptanceCriteria、validationCommands 和 covers', task.id));
    const acceptanceQuality = evaluateAcceptanceCriteria(task.acceptanceCriteria || []);
    acceptanceQuality.errors.forEach(item => errors.push(proposalErr('ACCEPTANCE_CRITERIA_QUALITY', formatAcceptanceFinding(item), task.id)));
    acceptanceQuality.warnings.forEach(item => warnings.push(proposalErr('ACCEPTANCE_CRITERIA_QUALITY_WARNING', formatAcceptanceFinding(item), task.id)));
    if ((task.parallelWith || []).length && !task.parallelRationale) errors.push(proposalErr('PARALLEL_RATIONALE_REQUIRED', '声明并行必须说明理由', task.id));
    for (const command of task.validationCommands || []) {
      const checked = validateCommandSpec(command, { validation: true });
      if (!checked.ok) errors.push(proposalErr('STRUCTURED_COMMAND_REQUIRED', `Proposal 验证命令必须是有效 CommandSpec：${checked.errors.join('；')}`, task.id));
    }
    for (const command of task.setupCommands || []) {
      const checked = validateCommandSpec(command, { setup: true });
      if (!checked.ok) errors.push(proposalErr('INVALID_SETUP_COMMAND', checked.errors.join('；'), task.id));
    }
    const referenceChecks = Array.isArray(task.referenceChecks) ? task.referenceChecks : [];
    for (const check of referenceChecks) {
      if (!Number.isInteger(check?.criterionIndex) || check.criterionIndex < 0 || check.criterionIndex >= (task.acceptanceCriteria || []).length || !check.command) {
        errors.push(proposalErr('INVALID_REFERENCE_CHECK', 'referenceChecks 需要有效的 criterionIndex 与 command', task.id));
      } else if (!isCommandSpec(check.command) || !validateCommandSpec(check.command, { validation: true }).ok) {
        errors.push(proposalErr('INVALID_REFERENCE_CHECK', 'reference check command 必须是有效 CommandSpec', task.id));
      } else if (!(task.validationCommands || []).some(command => commandIdentity(command) === commandIdentity(check.command))) {
        errors.push(proposalErr('REFERENCE_CHECK_NOT_EXECUTED', `reference check 必须同时列入 validationCommands：${validationCommandText(check.command)}`, task.id));
      }
    }
    for (let index = 0; index < (task.acceptanceCriteria || []).length; index++) {
      const criterion = String(task.acceptanceCriteria[index]);
      if (/[≈±]/.test(criterion) || /误差|tolerance/i.test(criterion)) {
        const reference = referenceChecks.find(check => check?.criterionIndex === index);
        if (!reference) errors.push(proposalErr('NUMERIC_CRITERION_UNVERIFIED', `数值验收标准 #${index + 1} 必须绑定 referenceChecks`, task.id));
        else if (!Number.isFinite(reference.expected) || !reference.calculation) errors.push(proposalErr('NUMERIC_STATIC_CHECK_REQUIRED', `数值标准 #${index + 1} 必须声明 expected 与 calculation AST`, task.id));
        else {
          try {
            const calculated = evaluateNumericCalculation(reference.calculation);
            const tolerance = reference.relativeTolerance == null ? 1e-9 : Number(reference.relativeTolerance);
            if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) errors.push(proposalErr('INVALID_NUMERIC_TOLERANCE', `数值标准 #${index + 1} relativeTolerance 必须在 0..1`, task.id));
            else {
              const relativeError = Math.abs(calculated - reference.expected) / Math.max(Math.abs(reference.expected), Number.EPSILON);
              if (relativeError > tolerance) errors.push(proposalErr('NUMERIC_REFERENCE_MISMATCH', `数值标准 #${index + 1} 静态复算 ${calculated} 与 expected ${reference.expected} 不符（relativeError=${relativeError}）`, task.id));
              const criterionTarget = criterionNumericTarget(criterion);
              if (criterionTarget != null) {
                const criterionError = Math.abs(criterionTarget - reference.expected) / Math.max(Math.abs(reference.expected), Number.EPSILON);
                if (criterionError > tolerance) errors.push(proposalErr('NUMERIC_CRITERION_MISMATCH', `数值标准 #${index + 1} 文本目标 ${criterionTarget} 与 expected ${reference.expected} 不符`, task.id));
              }
            }
          } catch (error) { errors.push(proposalErr(error.code || 'NUMERIC_CALC_INVALID', error.message, task.id)); }
        }
      }
    }
    try { (task.resources || []).forEach(normalizeResource); (task.writes || []).forEach(value => normalizeResource(`file:${value}`)); }
    catch (error) { errors.push(proposalErr('INVALID_RESOURCE', error.message, task.id)); }
  }
  const covered = new Set();
  for (const task of tasks.values()) {
    for (const dep of task.dependsOn || []) if (!tasks.has(dep) || dep === task.id) errors.push(proposalErr('INVALID_DEPENDENCY', `依赖不存在或自依赖：${dep}`, task.id));
    for (const id of task.covers || []) { if (!criteria.has(id)) errors.push(proposalErr('UNKNOWN_CRITERION', `覆盖了未知父标准：${id}`, task.id)); else covered.add(id); }
    for (const peer of task.parallelWith || []) {
      if (!tasks.has(peer) || peer === task.id) errors.push(proposalErr('INVALID_PARALLEL_PEER', `并行任务不存在或指向自身：${peer}`, task.id));
      else if (!(tasks.get(peer).parallelWith || []).includes(task.id)) errors.push(proposalErr('ASYMMETRIC_PARALLELISM', `parallelWith 必须双向声明：${task.id} ↔ ${peer}`, task.id));
    }
  }
  for (const id of criteria) if (!covered.has(id)) errors.push(proposalErr('UNCOVERED_CRITERION', `父验收标准未覆盖：${id}`));
  if (dependencyCycle(tasks)) errors.push(proposalErr('DEPENDENCY_CYCLE', '任务依赖存在环'));
  const list = [...tasks.values()];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i]; const b = list[j];
    let ar = []; let br = [];
    try { ar = [...(a.writes || []).map(v => normalizeResource(`file:${v}`)), ...(a.resources || []).map(normalizeResource)]; } catch { /* 已在字段校验中报告 */ }
    try { br = [...(b.writes || []).map(v => normalizeResource(`file:${v}`)), ...(b.resources || []).map(normalizeResource)]; } catch { /* 已在字段校验中报告 */ }
    const shared = ar.find(x => br.some(y => resourceConflict(normalizeResource(x), normalizeResource(y))));
    const serialized = hasPath(tasks, a.id, b.id) || hasPath(tasks, b.id, a.id);
    if (shared && !serialized) errors.push(proposalErr('SHARED_RESOURCE_NOT_SERIALIZED', `${a.id} 与 ${b.id} 共享 ${shared}，但没有依赖路径串行化`));
    if (shared && ((a.parallelWith || []).includes(b.id) || (b.parallelWith || []).includes(a.id))) errors.push(proposalErr('UNSAFE_PARALLELISM', `${a.id} 与 ${b.id} 共享资源却声明并行`));
  }
  const rank = { low: 0, medium: 1, high: 2, critical: 3 }; const parentRisk = proposal.risk || 'low';
  for (const task of tasks.values()) if (rank[task.risk] < rank[parentRisk]) errors.push(proposalErr('RISK_NOT_INHERITED', `子任务风险 ${task.risk} 低于父提案 ${parentRisk}`, task.id));
  if (errors.length) return { ok: false, errors, warnings };
  proposal.digest = sha256(proposal); return { ok: true, proposal, digest: proposal.digest, errors, warnings };
}

function authoritativeProjectGoal(cwd) {
  return readJson(path.join(cwd, '.rootagent', 'tasks.json'), {})?.goal || '';
}

export function submitPlannerProposal(cwd, input) {
  const checked = validatePlannerProposal(input, { projectGoal: authoritativeProjectGoal(cwd) }); if (!checked.ok) return checked;
  const file = store(cwd, path.join('proposals', `${checked.digest}.json`));
  const duplicate = fs.existsSync(file);
  if (!duplicate) atomicWriteJson(file, checked.proposal);
  return { ...checked, path: file, duplicate };
}

export function approvePlannerProposal(cwd, digest, issuer) {
  const file = store(cwd, path.join('proposals', `${safeId(digest)}.json`)); const proposal = readJson(file);
  if (!proposal) throw orchestrationError('PROPOSAL_NOT_FOUND', `提案不存在：${digest}`);
  const checked = validatePlannerProposal(proposal, { projectGoal: authoritativeProjectGoal(cwd) }); if (!checked.ok || checked.digest !== digest) throw orchestrationError('PROPOSAL_CORRUPT', '提案内容、Requirement Manifest 或摘要无效');
  if (!issuer) throw orchestrationError('ISSUER_REQUIRED', '批准必须声明 reviewer issuer');
  const approval = { schemaVersion: 1, approvalId: crypto.randomUUID(), subjectDigest: digest, issuer, role: 'reviewer', approvedAt: now() }; approval.digest = sha256(approval);
  atomicWriteJson(store(cwd, path.join('proposal-approvals', `${digest}.json`)), approval); return approval;
}

export function materializePlannerProposal(cwd, digest) {
  const proposal = readJson(store(cwd, path.join('proposals', `${safeId(digest)}.json`)));
  const approval = readJson(store(cwd, path.join('proposal-approvals', `${safeId(digest)}.json`)));
  if (!proposal) throw orchestrationError('PROPOSAL_NOT_FOUND', `提案不存在：${digest}`);
  const checked = validatePlannerProposal(proposal, { projectGoal: authoritativeProjectGoal(cwd) });
  if (!checked.ok || checked.digest !== digest) throw orchestrationError('PROPOSAL_CORRUPT', '提案内容、Requirement Manifest 或摘要无效');
  if (!approval || approval.subjectDigest !== digest) throw orchestrationError('PROPOSAL_NOT_APPROVED', 'Planner 提案不能直接改任务图；需 Reviewer 对精确 digest 批准');
  const approvalCopy = clone(approval); const approvalDigest = approvalCopy.digest; delete approvalCopy.digest;
  if (approvalDigest !== sha256(approvalCopy) || approval.role !== 'reviewer') throw orchestrationError('APPROVAL_CORRUPT', 'Reviewer approval 摘要或角色无效');
  const plan = {
    schemaVersion: proposal.schemaVersion,
    sourceProposalDigest: digest,
    approvalDigest: approval.digest,
    goal: proposal.goal,
    requirementSourceDigest: proposal.requirementSourceDigest || null,
    requirements: clone(proposal.requirements || []),
    parentCriteria: clone(proposal.parentCriteria || []),
    tasks: proposal.tasks,
    materializedAt: now(),
  }; plan.digest = sha256(plan);
  const file = store(cwd, path.join('approved-plans', `${plan.digest}.json`)); if (!fs.existsSync(file)) atomicWriteJson(file, plan);
  return { plan, path: file };
}

export function buildContextPacket(cwd, role, input = {}) {
  if (!ROLES.includes(role)) throw orchestrationError('INVALID_ROLE', `未知角色：${role}`);
  const capabilities = ROLE_CAPABILITIES[role];
  const packet = {
    schemaVersion: 1, packetId: crypto.randomUUID(), role, capabilities: clone(capabilities),
    projectGoal: input.projectGoal || input.contract?.projectGoal || null,
    contract: clone(input.contract || null), base: clone(input.base || null), candidate: clone(input.candidate || null),
    codeMap: clone(input.codeMap || []), recentFailures: clone(input.recentFailures || []), lessons: clone(input.lessons || []),
    tools: clone(input.tools || []), budget: clone(input.budget || null), traceContext: clone(input.traceContext || null), createdAt: now(),
  };
  packet.digest = sha256(packet); atomicWriteJson(store(cwd, path.join('contexts', `${packet.digest}.json`)), packet); return packet;
}

export function verifyContextPacket(packet) {
  if (!packet || !ROLES.includes(packet.role)) return { ok: false, reason: 'role 无效' };
  const copy = clone(packet); const digest = copy.digest; delete copy.digest;
  if (digest !== sha256(copy)) return { ok: false, reason: 'ContextPacket digest 不匹配' };
  if (JSON.stringify(packet.capabilities) !== JSON.stringify(ROLE_CAPABILITIES[packet.role])) return { ok: false, reason: '角色能力被篡改' };
  return { ok: true, digest };
}

export function validateAdapterManifest(input) {
  const errors = []; const manifest = clone(input || {}); delete manifest.digest;
  if (manifest.schemaVersion !== 1 || manifest.protocolVersion !== 1) errors.push('schemaVersion/protocolVersion 必须为 1');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(manifest.adapterId || '')) errors.push('adapterId 无效');
  if (!Array.isArray(manifest.operations) || ADAPTER_OPERATIONS.some(op => !manifest.operations.includes(op))) errors.push(`operations 必须完整实现：${ADAPTER_OPERATIONS.join(', ')}`);
  if (!['mailbox', 'scripted'].includes(manifest.transport?.type)) errors.push('核心仅接受 mailbox 或测试用 scripted transport');
  if (manifest.transport?.type === 'scripted' && (!manifest.transport.responses || typeof manifest.transport.responses !== 'object')) errors.push('scripted transport 需要 responses');
  if (errors.length) return { ok: false, errors };
  manifest.operations = [...ADAPTER_OPERATIONS]; manifest.digest = sha256(manifest); return { ok: true, manifest, digest: manifest.digest, errors: [] };
}

export function installAdapter(cwd, input) {
  const checked = validateAdapterManifest(input); if (!checked.ok) return checked;
  const file = store(cwd, path.join('adapters', `${safeId(checked.manifest.adapterId)}.json`));
  if (fs.existsSync(file)) {
    const prior = readJson(file); if (prior.digest !== checked.digest) throw orchestrationError('ADAPTER_CONFLICT', `adapterId ${checked.manifest.adapterId} 已绑定另一摘要`);
    return { ...checked, path: file, duplicate: true };
  }
  atomicWriteJson(file, checked.manifest); return { ...checked, path: file, duplicate: false };
}

export function listAdapters(cwd) {
  const dir = store(cwd, 'adapters'); return fs.existsSync(dir) ? fs.readdirSync(dir).filter(file => file.endsWith('.json')).map(file => readJson(path.join(dir, file))) : [];
}

function adapterRequestFile(cwd, requestId) { return store(cwd, path.join('adapter-requests', `${safeId(requestId)}.json`)); }
export function requestAdapterOperation(cwd, adapterId, operation, payload = {}, contextDigest = null, idempotencyKey = null) {
  if (!ADAPTER_OPERATIONS.includes(operation)) throw orchestrationError('INVALID_ADAPTER_OPERATION', `未知 adapter operation：${operation}`);
  const manifest = readJson(store(cwd, path.join('adapters', `${safeId(adapterId)}.json`)));
  if (!manifest) throw orchestrationError('ADAPTER_NOT_FOUND', `adapter 不存在：${adapterId}`);
  const checked = validateAdapterManifest(manifest); if (!checked.ok || checked.digest !== manifest.digest) throw orchestrationError('ADAPTER_CORRUPT', 'adapter manifest 无效');
  if (contextDigest) {
    const packet = readJson(store(cwd, path.join('contexts', `${safeId(contextDigest)}.json`)));
    const packetCheck = verifyContextPacket(packet);
    if (!packetCheck.ok || packetCheck.digest !== contextDigest) throw orchestrationError('CONTEXT_INVALID', `Adapter 请求引用的 ContextPacket 无效：${packetCheck.reason || 'digest mismatch'}`);
  }
  if (idempotencyKey) {
    const dir = store(cwd, 'adapter-requests');
    const prior = fs.existsSync(dir) ? fs.readdirSync(dir).filter(file => file.endsWith('.json')).map(file => readJson(path.join(dir, file))).find(item => item.adapterDigest === manifest.digest && item.operation === operation && item.idempotencyKey === idempotencyKey) : null;
    if (prior) return { ...prior, duplicate: true };
  }
  const request = { schemaVersion: 1, requestId: `ar_${crypto.randomUUID()}`, adapterId, adapterDigest: manifest.digest, operation, idempotencyKey, payload: clone(payload), contextDigest, status: 'PENDING', createdAt: now() };
  request.digest = sha256(request); atomicWriteJson(adapterRequestFile(cwd, request.requestId), request);
  durableAppendJsonLine(store(cwd, path.join('adapter-mailbox', adapterId, 'requests.jsonl')), request);
  if (manifest.transport.type === 'scripted') {
    const scripted = clone(manifest.transport.responses[operation] ?? { ok: true });
    return respondAdapterOperation(cwd, request.requestId, { ok: true, value: scripted, scripted: true });
  }
  return request;
}

export function respondAdapterOperation(cwd, requestId, response) {
  const request = readJson(adapterRequestFile(cwd, requestId)); if (!request) throw orchestrationError('ADAPTER_REQUEST_NOT_FOUND', `adapter request 不存在：${requestId}`);
  if (request.status !== 'PENDING') return request;
  request.status = response?.ok === false ? 'FAILED' : 'COMPLETED'; request.response = clone(response); request.completedAt = now();
  const copy = clone(request); delete copy.digest; request.digest = sha256(copy); atomicWriteJson(adapterRequestFile(cwd, requestId), request);
  durableAppendJsonLine(store(cwd, path.join('adapter-mailbox', request.adapterId, 'responses.jsonl')), { requestId, status: request.status, response: request.response, at: request.completedAt, digest: request.digest }); return request;
}

export function inspectAdapterRequest(cwd, requestId) {
  const request = readJson(adapterRequestFile(cwd, requestId)); if (!request) throw orchestrationError('ADAPTER_REQUEST_NOT_FOUND', `adapter request 不存在：${requestId}`); return request;
}

export function orchestrationHealth(cwd) {
  const problems = []; const healthy = [];
  for (const workspace of listWorkspaces(cwd)) {
    if (workspace.status === 'ACTIVE' && !fs.existsSync(workspace.path)) problems.push(`workspace ${workspace.workspaceId}: worktree 缺失`);
    else healthy.push(`workspace ${workspace.workspaceId}: ${workspace.status}`);
  }
  for (const candidate of (() => { const dir = store(cwd, 'candidates'); return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => readJson(path.join(dir, f))) : []; })()) {
    try { loadCandidate(cwd, candidate.digest); healthy.push(`candidate ${candidate.digest.slice(0, 12)}: digest 有效`); } catch (error) { problems.push(error.message); }
  }
  for (const adapter of listAdapters(cwd)) { const checked = validateAdapterManifest(adapter); if (!checked.ok || checked.digest !== adapter.digest) problems.push(`adapter ${adapter.adapterId}: manifest 无效`); else healthy.push(`adapter ${adapter.adapterId}: protocol v1`); }
  return { problems, healthy, host: os.hostname() };
}
