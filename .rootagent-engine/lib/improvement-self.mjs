/** Fixed-version self-improvement checks. This is state/worktree isolation, not an OS sandbox. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { atomicWriteJson, sha256 } from './trust-core.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const seal = value => hash(JSON.stringify(value));
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function git(cwd, args, binary = false) {
  const r = spawnSync('git', args, { cwd, encoding: binary ? undefined : 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 60000 });
  if (r.error || r.status !== 0) fail('IMPROVE_SELF_GIT', String(r.error || r.stderr));
  return binary ? r.stdout : r.stdout.trim();
}
function safeId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(id)) fail('IMPROVE_SELF_ID', 'Invalid self-improvement session ID');
  return id;
}
function root(cwd) { return fs.realpathSync(git(cwd, ['rev-parse', '--show-toplevel'])); }
function productDirty(cwd) {
  return git(cwd, ['status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude).rootagent']).length > 0;
}
function manifest(cwd) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(cwd, 'controller-protocol.json'), 'utf8'));
    if (m.schema !== 'rootagent.controller.protocol' || !Number.isInteger(m.protocolVersion) || !fs.statSync(path.join(cwd, 'bin/rootagent.mjs')).isFile()) throw new Error();
    return m;
  } catch { fail('IMPROVE_SELF_TARGET', 'Self target must be a RootAgent engine with CLI and controller protocol'); }
}
function filesAt(cwd) {
  const files = {};
  function walk(dir, rel = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const key = rel ? `${rel}/${name}` : name;
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fail('IMPROVE_SELF_UNSAFE_FILE', `Engine symlinks are unsupported: ${key}`);
      if (stat.isDirectory()) walk(file, key);
      else if (stat.isFile()) files[key] = hash(fs.readFileSync(file));
      else fail('IMPROVE_SELF_UNSAFE_FILE', `Unsupported engine entry: ${key}`);
    }
  }
  walk(cwd);
  return files;
}
function extract(cwd, commit, dest) {
  const entries = git(cwd, ['ls-tree', '-rz', commit]).split('\0').filter(Boolean);
  for (const entry of entries) {
    const [metadata, name] = entry.split('\t');
    if (name === '.rootagent' || name.startsWith('.rootagent/')) continue;
    if (!/^100(644|755) blob /.test(metadata)) fail('IMPROVE_SELF_UNSAFE_FILE', `Only regular committed engine files supported: ${name}`);
  }
  fs.mkdirSync(dest, { recursive: true });
  // Explicit pathspec avoids live/untracked files and control state in the frozen engine.
  const archive = git(cwd, ['archive', '--format=tar', commit, '--', '.', ':(exclude).rootagent'], true);
  const r = spawnSync('tar', ['-xf', '-', '-C', dest], { input: archive, encoding: 'utf8', timeout: 60000 });
  if (r.error || r.status !== 0) fail('IMPROVE_SELF_ARCHIVE', String(r.error || r.stderr));
}

export function verifySupervisor(descriptor) {
  if (!descriptor || descriptor.schemaVersion !== 1 || !descriptor.root || !descriptor.files) fail('IMPROVE_SELF_DESCRIPTOR', 'Invalid supervisor descriptor');
  const { digest, ...body } = descriptor;
  if (seal(body) !== digest || descriptor.cli !== path.join(descriptor.root, 'bin/rootagent.mjs')) fail('IMPROVE_SELF_TAMPERED', 'Supervisor descriptor changed');
  if (!fs.existsSync(descriptor.root) || seal(filesAt(descriptor.root)) !== seal(descriptor.files)) fail('IMPROVE_SELF_TAMPERED', 'Frozen supervisor files changed');
  manifest(descriptor.root);
  return true;
}

export function pinSupervisor(cwd, sessionId, engineRoot = cwd) {
  safeId(sessionId);
  const target = root(cwd), engine = root(engineRoot);
  if (target !== engine || fs.realpathSync(cwd) !== target) fail('IMPROVE_SELF_TARGET', 'Self target must be the RootAgent Git root');
  manifest(engine);
  const storage = path.join(target, '.rootagent/improvement');
  const descriptorFile = path.join(storage, 'supervisors', `${sessionId}.json`);
  if (fs.existsSync(descriptorFile)) {
    const descriptor = JSON.parse(fs.readFileSync(descriptorFile, 'utf8'));
    if (descriptor.engineRoot !== engine || descriptor.sessionId !== sessionId) fail('IMPROVE_SELF_DESCRIPTOR', 'Supervisor belongs to another target/session');
    verifySupervisor(descriptor);
    return descriptor;
  }
  if (productDirty(engine)) fail('IMPROVE_SELF_DIRTY', 'Commit product changes before pinning a supervisor');
  const commit = git(engine, ['rev-parse', 'HEAD']);
  const snapshot = path.join(storage, 'engines', commit);
  const temp = `${snapshot}.tmp.${randomUUID()}`;
  try {
    extract(engine, commit, temp);
    manifest(temp);
    const expectedFiles = filesAt(temp);
    if (fs.existsSync(snapshot)) {
      if (seal(filesAt(snapshot)) !== seal(expectedFiles)) fail('IMPROVE_SELF_TAMPERED', 'Existing engine snapshot differs from its commit');
    } else fs.renameSync(temp, snapshot);
    const body = { schemaVersion: 1, sessionId, engineRoot: engine, commit, root: snapshot, cli: path.join(snapshot, 'bin/rootagent.mjs'), files: expectedFiles };
    const descriptor = { ...body, digest: seal(body) };
    atomicWriteJson(descriptorFile, descriptor);
    return descriptor;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

export function prepareSelfCandidate(cwd, sessionId, baseCommit) {
  safeId(sessionId);
  manifest(cwd);
  const target = root(cwd);
  if (!/^[0-9a-f]{40,64}$/.test(baseCommit || '')) fail('IMPROVE_SELF_BASE', 'A full committed base identity is required');
  const resolved = git(target, ['rev-parse', '--verify', `${baseCommit}^{commit}`]);
  const candidatePath = path.join(target, '.rootagent/improvement/candidates', sessionId);
  const recordFile = path.join(target, '.rootagent/improvement/candidate-bindings', `${sessionId}.json`);
  if (fs.existsSync(recordFile)) {
    const saved = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    if (saved.baseCommit !== resolved || saved.path !== candidatePath) fail('IMPROVE_SELF_BASE', 'Candidate session already bound to a different base');
  }
  if (fs.existsSync(candidatePath)) {
    if (root(candidatePath) !== fs.realpathSync(candidatePath) || git(candidatePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']) !== git(target, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) fail('IMPROVE_SELF_WORKTREE', 'Candidate path is not an isolated worktree of the target');
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', resolved, 'HEAD'], { cwd: candidatePath });
    if (ancestor.status !== 0) fail('IMPROVE_SELF_BASE', 'Candidate no longer descends from its pinned base');
  } else {
    fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
    git(target, ['worktree', 'add', '--detach', candidatePath, resolved]);
  }
  const record = { sessionId, path: candidatePath, baseCommit: resolved };
  atomicWriteJson(recordFile, record);
  return record;
}

/** Runs trusted checks against an exact committed candidate without its control state. */
export function testSelfCandidate(cwd, descriptor, candidatePath, options = {}) {
  verifySupervisor(descriptor);
  if (root(cwd) !== descriptor.engineRoot || root(candidatePath) !== fs.realpathSync(candidatePath) || fs.realpathSync(candidatePath) === root(cwd)) fail('IMPROVE_SELF_WORKTREE', 'Candidate must be isolated from live target');
  if (git(candidatePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']) !== git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) fail('IMPROVE_SELF_WORKTREE', 'Candidate belongs to a different repository');
  if (spawnSync('git', ['merge-base', '--is-ancestor', descriptor.commit, 'HEAD'], { cwd: candidatePath }).status !== 0) fail('IMPROVE_SELF_BASE', 'Candidate does not descend from its supervisor');
  if (productDirty(candidatePath)) fail('IMPROVE_SELF_DIRTY', 'Commit candidate product changes before testing');
  const candidateCommit = git(candidatePath, ['rev-parse', 'HEAD']);
  const candidateTree = git(candidatePath, ['rev-parse', 'HEAD^{tree}']);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rootagent-self-check-'));
  const engine = path.join(workspace, 'candidate'), project = path.join(workspace, 'project');
  const checks = [];
  const timeout = Math.min(Math.max(Number(options.timeoutMs) || 60000, 100), 300000);
  function run(name, args, expectFailure = false, entry = path.join(engine, 'bin/rootagent.mjs')) {
    const r = spawnSync(process.execPath, [entry, ...args], { cwd: project, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, ROOTAGENT_SELFTEST_PARENT: '1', ROOTAGENT_HOST_BRIDGE: '0' } });
    let payload;
    try { payload = JSON.parse(r.stdout); } catch { /* recorded below */ }
    const ok = !r.error && (expectFailure ? r.status !== null && r.status !== 0 && payload?.ok === false : r.status === 0);
    checks.push({ name, ok, exitCode: r.status, stdout: (r.stdout || '').slice(-16000), stderr: String(r.error || r.stderr || '').slice(-16000) });
    return payload;
  }
  try {
    extract(candidatePath, candidateCommit, engine);
    fs.mkdirSync(project);
    const old = manifest(descriptor.root), next = manifest(engine);
    checks.push({ name: 'protocol-major-compatible', ok: old.protocolVersion === next.protocolVersion && next.schema === old.schema });
    // Freeze both the compatibility assertions and their assertion helper outside candidate control.
    const frozenTest = path.join(descriptor.root, 'tests/t_controller_protocol.mjs');
    if (fs.existsSync(frozenTest)) {
      fs.mkdirSync(path.join(engine, 'tests'), { recursive: true });
      fs.writeFileSync(path.join(engine, 'tests/t_frozen_protocol.mjs'), fs.readFileSync(frozenTest));
      fs.writeFileSync(path.join(engine, 'tests/util.mjs'), 'export function assert(value, message) { if (!value) throw new Error(message); }\n');
      run('frozen-controller-protocol', [], false, path.join(engine, 'tests/t_frozen_protocol.mjs'));
    } else checks.push({ name: 'frozen-controller-protocol', ok: false, reason: 'Pinned supervisor has no controller protocol compatibility suite' });
    run('candidate-init', ['init', 'isolated candidate compatibility', '--json']);
    const snapshot = run('candidate-reads-fresh-state', ['snapshot', '--json']);
    checks.push({ name: 'snapshot-envelope', ok: snapshot?.ok === true && !!snapshot.data });
    run('reject-pass-without-task', ['pass', '--json'], true);
    run('reject-unknown-command', ['__improvement_negative_command__', '--json'], true);
    // A state produced by the old engine must remain readable by the candidate.
    fs.rmSync(path.join(project, '.rootagent'), { recursive: true, force: true });
    run('supervisor-creates-legacy-state', ['init', 'frozen supervisor compatibility', '--json'], false, descriptor.cli);
    const legacy = run('candidate-reads-supervisor-state', ['snapshot', '--json']);
    checks.push({ name: 'legacy-state-envelope', ok: legacy?.ok === true && !!legacy.data });
    fs.writeFileSync(path.join(project, '.rootagent/TASK.md'), '# 任务：frozen negative gate\n\n## 描述\nReject unverified completion.\n\n## 验收标准\n- [命令] negative gate is enforced\n\n## 验证命令\n- node -e "process.exit(1)"\n');
    run('supervisor-adds-negative-task', ['add', 'frozen negative gate', '--json'], false, descriptor.cli);
    run('supervisor-starts-negative-task', ['start', '--json'], false, descriptor.cli);
    run('reject-unverified-active-task', ['pass', '--json'], true);
    verifySupervisor(descriptor);
    if (candidateCommit !== git(candidatePath, ['rev-parse', 'HEAD']) || productDirty(candidatePath)) fail('IMPROVE_SELF_CHANGED', 'Candidate changed during compatibility checks');
    return { schemaVersion: 1, ok: checks.every(check => check.ok), supervisorDigest: descriptor.digest, candidateCommit, candidateTree, checks, limitations: ['Process and filesystem state separation is not an OS security sandbox.', 'Compatibility checks do not replace independent Checker or product benefit evaluation.'] };
  } catch (error) {
    checks.push({ name: 'self-check-integrity', ok: false, code: error.code, reason: error.message });
    return { schemaVersion: 1, ok: false, supervisorDigest: descriptor.digest, candidateCommit, candidateTree, checks };
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
}

export function verifySelfImprovementEvidence(cwd, session, tasks = []) {
  if (!session || session.target !== 'self') return true;
  const taskIds = (session.current?.taskIds && session.current.taskIds.length)
    ? session.current.taskIds
    : (session.decisions?.filter(d => d.outcome === 'ADOPTED').at(-1)?.taskIds || []);
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    fail('IMPROVE_SELF_EVIDENCE_INCOMPLETE', 'Self-improvement session has no bound task IDs');
  }

  const ledgerFile = path.join(cwd, '.rootagent', 'rounds.jsonl');
  if (!fs.existsSync(ledgerFile)) {
    fail('IMPROVE_SELF_EVIDENCE_INCOMPLETE', 'Self-improvement requires durable .rootagent/rounds.jsonl ledger');
  }
  let events = [];
  try {
    const lines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').filter(Boolean);
    events = lines.map(line => JSON.parse(line));
  } catch (error) {
    fail('IMPROVE_SELF_EVIDENCE_INCOMPLETE', `Corrupted .rootagent/rounds.jsonl ledger: ${error.message}`);
  }

  for (const taskId of taskIds) {
    const task = tasks.find(t => t.id === taskId);
    if (!task) {
      fail('IMPROVE_SELF_EVIDENCE_INCOMPLETE', `Task ${taskId} not found in project state`);
    }
    if (task.improvementSource?.sessionId !== session.sessionId) {
      fail('IMPROVE_SELF_EVIDENCE_INCOMPLETE', `Task ${taskId} is not bound to improvement session ${session.sessionId}`);
    }
    const candidateDigest = task.candidate?.digest;
    if (typeof candidateDigest !== 'string' || !/^[a-f0-9]{64}$/.test(candidateDigest)) {
      fail('IMPROVE_SELF_EVIDENCE_INCOMPLETE', `Task ${taskId} is missing valid candidate digest`);
    }
    if (!task.receipt?.path || !task.receipt?.digest) {
      fail('IMPROVE_SELF_EVIDENCE_INCOMPLETE', `Task ${taskId} is missing receipt metadata`);
    }
    const receiptPath = path.resolve(cwd, task.receipt.path);
    if (!receiptPath.startsWith(path.join(cwd, '.rootagent', 'receipts') + path.sep)) {
      fail('IMPROVE_SELF_EVIDENCE_INCOMPLETE', `Task ${taskId} receipt path escapes store`);
    }
    if (!fs.existsSync(receiptPath)) {
      fail('IMPROVE_SELF_EVIDENCE_INCOMPLETE', `Task ${taskId} receipt file not found: ${task.receipt.path}`);
    }
    let receipt;
    try {
      receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    } catch {
      fail('IMPROVE_SELF_EVIDENCE_INCOMPLETE', `Task ${taskId} receipt file cannot be parsed`);
    }
    const unsigned = { ...receipt };
    delete unsigned.digest;
    if (sha256(unsigned) !== task.receipt.digest) {
      fail('IMPROVE_SELF_EVIDENCE_INCOMPLETE', `Task ${taskId} receipt digest mismatch`);
    }
    if (receipt.candidate?.digest !== candidateDigest) {
      fail('IMPROVE_SELF_EVIDENCE_INCOMPLETE', `Task ${taskId} receipt candidate digest mismatch`);
    }
    const event = events.find(e => e && e.taskId === taskId && e.outcome === 'passed');
    if (!event) {
      fail('IMPROVE_SELF_EVIDENCE_INCOMPLETE', `Task ${taskId} has no passed event record in rounds.jsonl`);
    }
    if (event.commit && task.commit && event.commit !== task.commit) {
      fail('IMPROVE_SELF_EVIDENCE_INCOMPLETE', `Task ${taskId} rounds.jsonl commit mismatch`);
    }
  }
  return true;
}

