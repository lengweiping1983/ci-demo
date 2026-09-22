import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { atomicWriteJson, readJson, sha256 } from './trust-core.mjs';
import { commandDisplay, commandIdentity, normalizeCommand, resolveCommandCwd } from './command-execution.mjs';

export const SECURITY_SCHEMA_VERSION = 1;
export const EVIDENCE_TYPES = Object.freeze(['visual', 'performance', 'scientific', 'supply-chain']);
export const CHECKER_VERDICTS = Object.freeze(['PASS', 'FAIL', 'NOT_TESTED']);
const INFRASTRUCTURE_EXIT_CODES = new Set([70, 124, 126, 127]);

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const safe = value => String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
const securityFile = cwd => path.join(cwd, '.rootagent', 'security.json');
const trustHome = () => path.resolve(process.env.ROOTAGENT_TRUST_HOME || path.join(os.homedir(), '.rootagent', 'trust'));

function securityError(code, message, data = {}) { const error = new Error(message); error.code = code; error.data = data; return error; }
function probeBubblewrap() {
  const args = ['--die-with-parent', '--new-session', '--unshare-all', '--proc', '/proc', '--dev', '/dev'];
  for (const root of ['/bin', '/usr', '/lib', '/lib64', '/sbin', '/etc']) if (fs.existsSync(root)) args.push('--ro-bind', root, root);
  args.push('/bin/true');
  const result = spawnSync('bwrap', args, { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status === 0) return { available: true };
  const detail = String(result.error?.message || result.stderr || result.stdout || `exit ${result.status}`).trim().slice(-500);
  return { available: false, reason: `bubblewrap capability probe failed${detail ? `: ${detail}` : ''}` };
}
function relativeProjectPath(cwd, value) {
  const absolute = path.resolve(cwd, value); const rel = path.relative(cwd, absolute);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw securityError('PATH_OUTSIDE_PROJECT', `路径必须位于项目内：${value}`);
  return rel.split(path.sep).join('/');
}

export function defaultSecurityPolicy() {
  return {
    schemaVersion: SECURITY_SCHEMA_VERSION,
    trustRequired: true,
    sandbox: { mode: 'required', network: 'deny', readPaths: [], writePaths: ['.rootagent/runtime', '.rootagent/evidence', 'dist', 'coverage', '.tmp'] },
    limits: { timeoutMs: 300000, cpuSeconds: 300, maxOutputBytes: 4 * 1024 * 1024 },
    envAllow: ['PATH', 'LANG', 'LC_ALL', 'TRACEPARENT'],
    trustedVerifiers: [],
    checker: { requireStructuredReport: true, requireCalibration: true, maxFalseAcceptRate: 0, maxFalseRejectRate: 0.25 },
    evidence: { requiredForTaggedCriteria: true },
  };
}

export function loadSecurityPolicy(cwd) {
  const file = securityFile(cwd); if (!fs.existsSync(file)) return null;
  const raw = readJson(file); if (raw?.schemaVersion !== SECURITY_SCHEMA_VERSION) throw securityError('SECURITY_SCHEMA_INVALID', 'security.json schemaVersion 无效');
  return { ...defaultSecurityPolicy(), ...raw, sandbox: { ...defaultSecurityPolicy().sandbox, ...(raw.sandbox || {}) }, limits: { ...defaultSecurityPolicy().limits, ...(raw.limits || {}) }, checker: { ...defaultSecurityPolicy().checker, ...(raw.checker || {}) }, evidence: { ...defaultSecurityPolicy().evidence, ...(raw.evidence || {}) } };
}

export function initSecurity(cwd, overrides = {}) {
  const file = securityFile(cwd);
  if (fs.existsSync(file)) throw securityError('SECURITY_ALREADY_INITIALIZED', 'security.json 已存在；请显式编辑后重新 trust grant');
  const policy = defaultSecurityPolicy();
  if (overrides.sandboxMode && !['required', 'auto', 'audit'].includes(overrides.sandboxMode)) throw securityError('SECURITY_POLICY_INVALID', 'sandbox mode 必须是 required/auto/audit');
  if (overrides.network && !['deny', 'allow'].includes(overrides.network)) throw securityError('SECURITY_POLICY_INVALID', 'network 必须是 deny/allow');
  if (overrides.sandboxMode) policy.sandbox.mode = overrides.sandboxMode;
  if (overrides.network) policy.sandbox.network = overrides.network;
  if (overrides.writePaths) policy.sandbox.writePaths = overrides.writePaths.map(value => relativeProjectPath(cwd, value));
  atomicWriteJson(file, policy); return { policy, path: file };
}

function walkFiles(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name; const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(abs, rel)); else if (entry.isFile()) result.push({ rel, digest: sha256(fs.readFileSync(abs)) });
  }
  return result.sort((a, b) => a.rel.localeCompare(b.rel));
}

function configInputs(cwd) {
  const files = ['.rootagent/security.json', '.rootagent/policy.json', '.rootagent/hooks.json', '.rootagent/cron.json'];
  const values = [];
  for (const rel of files) { const abs = path.join(cwd, rel); values.push({ path: rel, digest: fs.existsSync(abs) ? sha256(fs.readFileSync(abs)) : null }); }
  values.push({ path: '.rootagent/workflows', files: walkFiles(path.join(cwd, '.rootagent', 'workflows')) });
  return values;
}
function commandIdentities(commands) { return [...new Set(commands.map(commandIdentity))].sort(); }

export function projectSecurityDigest(cwd, commands = []) {
  const identity = fs.realpathSync(cwd); const policy = loadSecurityPolicy(cwd);
  return sha256({ schemaVersion: 1, project: identity, config: configInputs(cwd), commands: commandIdentities(commands), trustedVerifiers: policy?.trustedVerifiers || [] });
}

function projectTrustFile(cwd) { return path.join(trustHome(), `${sha256(fs.realpathSync(cwd)).slice(0, 40)}.json`); }
function negativeControlContract(verifier) {
  if (verifier?.negativeControl && typeof verifier.negativeControl === 'object') return clone(verifier.negativeControl);
  if (verifier?.negativeCommand) return { command: verifier.negativeCommand, expectedExitCode: null, evidenceMarker: null, legacyIncomplete: true };
  return null;
}
function verifierDigests(cwd, policy) {
  return (policy?.trustedVerifiers || []).map(verifier => {
    const rel = relativeProjectPath(cwd, verifier.path); const file = path.join(cwd, rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw securityError('VERIFIER_MISSING', `受信 Verifier 不存在：${rel}`);
    return { path: rel, digest: sha256(fs.readFileSync(file)), negativeControl: negativeControlContract(verifier) };
  });
}

export function grantProjectTrust(cwd, issuer, commands = [], scopes = ['validation', 'hooks', 'workflow', 'setup', 'integration']) {
  const policy = loadSecurityPolicy(cwd); if (!policy) throw securityError('SECURITY_NOT_INITIALIZED', '先执行 security init');
  if (!issuer) throw securityError('ISSUER_REQUIRED', 'trust grant 必须声明人工 issuer');
  const file = projectTrustFile(cwd); const record = readJson(file, { schemaVersion: 1, project: fs.realpathSync(cwd), approvals: [] });
  const approval = { approvalId: crypto.randomUUID(), issuer, scopes: [...new Set(scopes)].sort(), configDigest: projectSecurityDigest(cwd, commands), commands: commandIdentities(commands), verifiers: verifierDigests(cwd, policy), approvedAt: now() };
  approval.digest = sha256(approval); record.approvals = (record.approvals || []).filter(item => item.configDigest !== approval.configDigest); record.approvals.push(approval); record.updatedAt = now();
  atomicWriteJson(file, record); return { approval, path: file };
}

export function inspectProjectTrust(cwd) { return readJson(projectTrustFile(cwd), { schemaVersion: 1, project: fs.realpathSync(cwd), approvals: [] }); }
export function revokeProjectTrust(cwd) { const file = projectTrustFile(cwd); if (!fs.existsSync(file)) return false; fs.renameSync(file, `${file}.revoked-${Date.now()}`); return true; }

export function assertProjectTrust(cwd, commands = [], scope = 'validation') {
  const policy = loadSecurityPolicy(cwd);
  if (!policy) {
    if (process.env.ROOTAGENT_UNATTENDED === '1') throw securityError('SECURITY_NOT_INITIALIZED', '无人值守执行必须先 security init 并建立项目外信任');
    return { trusted: false, legacy: true, policy: null };
  }
  if (!policy.trustRequired) return { trusted: false, bypassed: true, policy };
  const digest = projectSecurityDigest(cwd, commands); const record = inspectProjectTrust(cwd);
  const approval = (record.approvals || []).find(item => item.configDigest === digest && item.scopes.includes(scope));
  if (!approval) throw securityError('PROJECT_TRUST_REQUIRED', `项目执行配置未获信任或已变化：${digest}`, { configDigest: digest, trustFile: projectTrustFile(cwd) });
  const unsigned = clone(approval); const claimed = unsigned.digest; delete unsigned.digest;
  if (claimed !== sha256(unsigned)) throw securityError('TRUST_RECORD_CORRUPT', '项目外 trust approval 摘要失配');
  const actualVerifiers = verifierDigests(cwd, policy);
  if (sha256(actualVerifiers) !== sha256(approval.verifiers || [])) throw securityError('VERIFIER_TAMPERED', '受信 Verifier 内容与人工批准时不一致', { expected: approval.verifiers, actual: actualVerifiers });
  return { trusted: true, policy, approval, configDigest: digest };
}

export function lockTrustedVerifier(cwd, verifierPath, negativeControl = null) {
  const policy = loadSecurityPolicy(cwd); if (!policy) throw securityError('SECURITY_NOT_INITIALIZED', '先执行 security init');
  const rel = relativeProjectPath(cwd, verifierPath); const file = path.join(cwd, rel);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw securityError('VERIFIER_MISSING', `Verifier 不存在：${rel}`);
  if (!negativeControl?.command || !Number.isInteger(negativeControl.expectedExitCode) || negativeControl.expectedExitCode <= 0 || INFRASTRUCTURE_EXIT_CODES.has(negativeControl.expectedExitCode) || !String(negativeControl.evidenceMarker || '').trim()) {
    throw securityError('NEGATIVE_CONTROL_CONTRACT_INVALID', 'negative control 必须声明 command、非基础设施保留值的正整数 expectedExitCode 和非空 evidenceMarker');
  }
  const frozenControl = { command: negativeControl.command, expectedExitCode: negativeControl.expectedExitCode, evidenceMarker: String(negativeControl.evidenceMarker) };
  policy.trustedVerifiers = (policy.trustedVerifiers || []).filter(item => item.path !== rel);
  policy.trustedVerifiers.push({ path: rel, negativeControl: frozenControl }); policy.trustedVerifiers.sort((a, b) => a.path.localeCompare(b.path));
  atomicWriteJson(securityFile(cwd), policy); return { path: rel, digest: sha256(fs.readFileSync(file)), negativeControl: frozenControl };
}

export function checkTrustedVerifiers(cwd, commands = [], options = {}) {
  const trust = assertProjectTrust(cwd, commands, options.scope || 'validation'); if (!trust.policy) return { ok: true, legacy: true, checks: [] };
  const checks = verifierDigests(cwd, trust.policy).map(verifier => ({ ...verifier, verdict: 'PASS' }));
  for (const command of commands) {
    const text = commandDisplay(command);
    const match = text.match(/^\s*\[?[VL](\d)\]?\s*(.*)$/); const level = typeof command === 'object' && Number.isInteger(command.level) ? command.level : match ? Number(match[1]) : 1; const raw = match ? match[2] : text;
    const verifier = checks.find(item => raw.includes(item.path));
    if (level >= 2 && !verifier) throw securityError('UNTRUSTED_VERIFIER', `V${level} 命令没有引用受信 Verifier：${raw}`);
    if (level >= 2 && verifier && (!verifier.negativeControl?.command || !Number.isInteger(verifier.negativeControl.expectedExitCode) || !verifier.negativeControl.evidenceMarker)) throw securityError('NEGATIVE_CONTROL_MISSING', `V${level} 受信 Verifier 没有完整 negative control 契约：${verifier.path}`);
  }
  return { ok: true, trust, checks };
}

export function detectSandboxBackend() {
  // sandbox-exec 是已弃用接口：只在操作者显式启用 adapter 时使用，不能因二进制“存在”就宣称安全。
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec') && process.env.ROOTAGENT_ENABLE_SEATBELT === '1') return { backend: 'seatbelt', available: true, osEnforced: true, experimental: true };
  if (process.platform === 'linux') {
    const probe = probeBubblewrap();
    if (probe.available) return { backend: 'bubblewrap', available: true, osEnforced: true };
    return { backend: 'none', available: false, osEnforced: false, reason: probe.reason };
  }
  return { backend: 'none', available: false, osEnforced: false, reason: process.platform === 'darwin' ? 'deprecated seatbelt adapter disabled; set ROOTAGENT_ENABLE_SEATBELT=1 only after host validation' : 'no supported OS sandbox backend' };
}

function sandboxEnvironment(policy, tempHome, extra = {}) {
  const env = { HOME: tempHome, TMPDIR: path.join(tempHome, 'tmp'), TEMP: path.join(tempHome, 'tmp'), TMP: path.join(tempHome, 'tmp'), ROOTAGENT_SECURE: '1' };
  for (const key of policy.envAllow || []) if (process.env[key] != null) env[key] = process.env[key];
  for (const [key, value] of Object.entries(extra)) if (key.startsWith('ROOTAGENT_') || (policy.envAllow || []).includes(key)) env[key] = String(value);
  return env;
}
function sandboxPathRoot(value) { return String(value).replace(/\\/g, '/').split(/[*?[]/, 1)[0].replace(/\/$/, '') || '.'; }

export function seatbeltProfile(cwd, policy, tempHome) {
  const q = value => { const absolute = path.resolve(value); return JSON.stringify(fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute); }; const nodeRoot = path.dirname(path.dirname(path.dirname(process.execPath)));
  const reads = [cwd, tempHome, '/System', '/usr', '/bin', '/sbin', '/Library', '/dev', '/private/etc', '/private/var/db', '/private/var/folders', nodeRoot, ...(policy.sandbox.readPaths || []).map(value => path.resolve(cwd, value))];
  const writes = [tempHome, ...(policy.sandbox.writePaths || []).map(value => path.resolve(cwd, value))];
  // Node/V8 依赖 Mach、sysctl、POSIX IPC 与 IOKit 查询；这些不扩大文件或网络权限。
  const lines = ['(version 1)', '(deny default)', '(allow process*)', '(allow signal (target self))', '(allow dynamic-code-generation)', '(allow mach*)', '(allow sysctl*)', '(allow ipc-posix*)', '(allow iokit*)', '(allow file-read-metadata)', `(allow file-read-data ${[...new Set(reads)].map(value => `(subpath ${q(value)})`).join(' ')})`, `(allow file-write* ${[...new Set(writes)].map(value => `(subpath ${q(value)})`).join(' ')})`];
  if (policy.sandbox.network === 'allow') lines.push('(allow network*)');
  return lines.join('\n');
}

export function secureExecute(cwd, command, policy, options = {}) {
  if (!policy) throw securityError('SECURITY_NOT_INITIALIZED', 'secureExecute 需要 security policy');
  const normalized = normalizeCommand(command, { automated: options.automated, validation: options.validation, setup: options.setup });
  if (normalized.spec?.effect === 'workspace-write' && !options.isolatedWorkspace) throw securityError('WORKTREE_REQUIRED', 'workspace-write 命令只能在显式隔离 worktree 中执行');
  if (!['deny', 'allow'].includes(policy.sandbox.network)) throw securityError('NETWORK_POLICY_UNSUPPORTED', '核心不伪装域名 allowlist；需要外部认证代理时只能由 adapter backend 提供');
  const detected = detectSandboxBackend();
  if (policy.sandbox.mode === 'required' && !detected.available) throw securityError('SANDBOX_UNAVAILABLE', '策略要求 OS 沙箱，但当前主机没有受支持 backend');
  if (process.env.ROOTAGENT_UNATTENDED === '1' && !detected.available) throw securityError('SANDBOX_UNAVAILABLE', '无人值守执行没有 OS 沙箱，fail closed');
  const structured = normalized.mode === 'structured';
  const executionCwd = structured ? resolveCommandCwd(cwd, normalized.spec.cwd) : cwd;
  if (structured && normalized.spec.network === 'allow' && policy.sandbox.network !== 'allow') throw securityError('NETWORK_NOT_AUTHORIZED', 'CommandSpec 请求网络，但 security policy 未授权');
  const effectivePolicy = structured ? clone(policy) : policy;
  if (structured) {
    effectivePolicy.sandbox.network = normalized.spec.network;
    effectivePolicy.sandbox.readPaths = [...new Set([...(policy.sandbox.readPaths || []), ...normalized.spec.readPaths.map(sandboxPathRoot)])];
    effectivePolicy.sandbox.writePaths = normalized.spec.effect === 'workspace-write' ? [...new Set(normalized.spec.writePaths.map(sandboxPathRoot))] : [];
  }
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rootagent-secure-')); fs.mkdirSync(path.join(tempHome, 'tmp'));
  const env = sandboxEnvironment(effectivePolicy, tempHome, options.env || {}); const cpu = Math.max(1, Number(effectivePolicy.limits.cpuSeconds || 300));
  // shell 转义：将任意字符串安全包入单引号（内部单引号转义为 '\''）
  const shQuote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
  // CPU 限额包装：宿主执行器统一用 `ulimit -t` 施加 cpuSeconds（覆盖旧字符串命令与结构化命令）
  const cpuWrappedCommand = cmd => `ulimit -t ${cpu}; exec ${cmd}`;
  const structuredCommand = spec => cpuWrappedCommand(`${shQuote(spec.program)} ${spec.args.map(shQuote).join(' ')}`);
  // 结构化命令的完整 spawn argv（供 sandbox-exec/bwrap 追加为被执行命令）；裸执行路径直接用 ['-c', structuredCommand(...)]
  const structuredShellArgs = spec => ['/bin/sh', '-c', structuredCommand(spec)];
  const limitedCommand = structured ? null : cpuWrappedCommand(normalized.cmd);
  let executable = '/bin/sh';
  let args = structured ? ['-c', structuredCommand(normalized.spec)] : ['-c', limitedCommand];
  let sandboxed = false;
  if (detected.backend === 'seatbelt') {
    executable = '/usr/bin/sandbox-exec';
    args = ['-p', seatbeltProfile(cwd, effectivePolicy, tempHome),
      ...(structured ? structuredShellArgs(normalized.spec) : ['/bin/sh', '-c', limitedCommand])];
    sandboxed = true;
  } else if (detected.backend === 'bubblewrap') {
    executable = 'bwrap'; args = ['--die-with-parent', '--new-session', '--unshare-all', '--proc', '/proc', '--dev', '/dev'];
    for (const root of ['/bin', '/usr', '/lib', '/lib64', '/sbin', '/etc']) if (fs.existsSync(root)) args.push('--ro-bind', root, root);
    args.push('--ro-bind', cwd, cwd, '--bind', tempHome, tempHome, '--chdir', executionCwd);
    for (const value of effectivePolicy.sandbox.writePaths || []) { const abs = path.resolve(cwd, value); fs.mkdirSync(abs, { recursive: true }); args.push('--bind', abs, abs); }
    if (effectivePolicy.sandbox.network === 'allow') args.push('--share-net');
    args.push(...(structured ? structuredShellArgs(normalized.spec) : ['/bin/sh', '-c', limitedCommand]));
    sandboxed = true;
  }
  const timeoutMs = Math.min(structured ? Math.min(Number(policy.limits.timeoutMs), normalized.spec.timeoutMs) : Number(policy.limits.timeoutMs), Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : Infinity);
  const started = Date.now(); const result = spawnSync(executable, args, { cwd: executionCwd, env, encoding: 'utf-8', timeout: timeoutMs, maxBuffer: Number(policy.limits.maxOutputBytes) });
  const output = `${result.stdout || ''}${result.stderr || ''}`; const receipt = { schemaVersion: 1, commandIdentity: commandIdentity(command), mode: normalized.mode, backend: detected.backend, sandboxed, network: structured ? normalized.spec.network : effectivePolicy.sandbox.network, exitCode: result.status ?? (result.error?.code === 'ETIMEDOUT' ? 124 : 70), signal: result.signal || null, durationMs: Date.now() - started, outputDigest: sha256(output), outputTail: output.slice(-4000), timedOut: result.error?.code === 'ETIMEDOUT', executedAt: now(), appliedLimits: { wallClockMs: timeoutMs, cpuSeconds: cpu } };
  receipt.digest = sha256(receipt);
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* 临时隔离目录由 OS 清理 */ }
  return { ok: receipt.exitCode === 0, code: receipt.exitCode, out: output, receipt };
}

export function runNegativeControls(cwd, policy, trust) {
  const results = [];
  for (const verifier of trust.approval.verifiers || []) {
    const control = negativeControlContract(verifier);
    if (!control?.command) continue;
    let result;
    try {
      result = secureExecute(cwd, control.command, policy, { env: { ROOTAGENT_NEGATIVE_CONTROL: '1', RA_RED: '1' } });
    } catch (error) {
      results.push({ path: verifier.path, command: control.command, verdict: 'INFRASTRUCTURE', reason: error.code || 'NEGATIVE_CONTROL_EXECUTION_ERROR', exitCode: null, evidenceMatch: false, receipt: error.data?.receipt || null });
      continue;
    }
    const receipt = result.receipt || null;
    const infrastructureReason = !receipt ? 'MISSING_EXECUTION_RECEIPT'
      : receipt.timedOut ? 'TIMED_OUT'
        : receipt.signal ? 'SIGNALLED'
          : INFRASTRUCTURE_EXIT_CODES.has(result.code) ? 'PROCESS_START_FAILED'
            : null;
    const evidenceMatch = !!control.evidenceMarker && String(result.out || '').includes(control.evidenceMarker);
    let verdict = 'FAIL'; let reason = 'NEGATIVE_CONTROL_DID_NOT_MATCH_EXPECTED_ASSERTION';
    if (infrastructureReason) { verdict = 'INFRASTRUCTURE'; reason = infrastructureReason; }
    else if (control.legacyIncomplete || !Number.isInteger(control.expectedExitCode) || !control.evidenceMarker) reason = 'NEGATIVE_CONTROL_CONTRACT_INCOMPLETE';
    else if (result.code === control.expectedExitCode && evidenceMatch) { verdict = 'PASS'; reason = 'EXPECTED_ASSERTION_FAILURE'; }
    results.push({ path: verifier.path, command: control.command, expectedExitCode: control.expectedExitCode, evidenceMarker: control.evidenceMarker, verdict, reason, exitCode: result.code, evidenceMatch, receipt });
  }
  return results;
}

function requireFields(value, fields, errors) { for (const field of fields) if (value?.[field] == null || value[field] === '') errors.push(`缺少字段 ${field}`); }
export function validateTypedEvidence(input, cwd = null) {
  const evidence = clone(input || {}); const errors = [];
  if (!EVIDENCE_TYPES.includes(evidence.type)) errors.push(`type 必须是 ${EVIDENCE_TYPES.join('/')}`);
  requireFields(evidence, ['taskId', 'candidateDigest'], errors);
  if (evidence.type === 'visual') { requireFields(evidence, ['url', 'viewport', 'operations', 'screenshot', 'observation'], errors); if (!Array.isArray(evidence.operations)) errors.push('operations 必须是数组'); }
  if (evidence.type === 'performance') { requireFields(evidence, ['environment', 'samples', 'p50', 'p95', 'baseline'], errors); if (!Array.isArray(evidence.samples) || evidence.samples.length < 2) errors.push('performance samples 至少 2 个'); }
  if (evidence.type === 'scientific') { requireFields(evidence, ['comparisons', 'tolerance'], errors); if (!Array.isArray(evidence.comparisons) || !evidence.comparisons.length) errors.push('scientific comparisons 不能为空'); }
  if (evidence.type === 'supply-chain') requireFields(evidence, ['license', 'author', 'source', 'artifactDigest', 'sbom', 'attribution'], errors);
  if (cwd && evidence.type === 'visual' && evidence.screenshot) {
    const file = path.resolve(cwd, evidence.screenshot); if (!fs.existsSync(file)) errors.push(`截图不存在：${evidence.screenshot}`); else evidence.screenshotDigest = sha256(fs.readFileSync(file));
  }
  if (errors.length) return { ok: false, errors };
  evidence.schemaVersion = 1; evidence.evidenceId ||= crypto.randomUUID(); evidence.createdAt ||= now(); evidence.digest = sha256(evidence); return { ok: true, evidence, errors: [] };
}

export function storeTypedEvidence(cwd, input) {
  const checked = validateTypedEvidence(input, cwd); if (!checked.ok) return checked;
  const file = path.join(cwd, '.rootagent', 'evidence', safe(checked.evidence.taskId), `${checked.evidence.digest}.json`);
  if (!fs.existsSync(file)) atomicWriteJson(file, checked.evidence); return { ...checked, path: file };
}
export function listTypedEvidence(cwd, taskId) {
  const dir = path.join(cwd, '.rootagent', 'evidence', safe(taskId)); return fs.existsSync(dir) ? fs.readdirSync(dir).filter(file => file.endsWith('.json')).map(file => readJson(path.join(dir, file))) : [];
}

export function validateCheckerReport(report, task) {
  const errors = []; const value = clone(report || {}); const total = task.acceptanceCriteria?.length || 0;
  if (value.taskId !== task.id) errors.push(`taskId 必须绑定 ${task.id}`);
  if (value.contractDigest !== task.contractDigest) errors.push('contractDigest 未绑定当前任务契约');
  if (!task.candidate || value.candidateDigest !== task.candidate.digest) errors.push('candidateDigest 未绑定当前候选');
  if (!Array.isArray(value.criteria) || value.criteria.length !== total) errors.push(`criteria 必须逐条覆盖 ${total} 项`);
  const seen = new Set();
  for (const item of value.criteria || []) {
    if (!Number.isInteger(item.index) || item.index < 1 || item.index > total || seen.has(item.index)) errors.push(`criterion index 无效或重复：${item.index}`); else seen.add(item.index);
    if (!CHECKER_VERDICTS.includes(item.verdict)) errors.push(`criterion ${item.index} verdict 无效`);
    if (!Array.isArray(item.evidence) || !item.evidence.length) errors.push(`criterion ${item.index} evidence 不能为空`);
    if (!(typeof item.confidence === 'number' && item.confidence >= 0 && item.confidence <= 1)) errors.push(`criterion ${item.index} confidence 必须为 0..1`);
    if (!Array.isArray(item.limitations)) errors.push(`criterion ${item.index} limitations 必须是数组`);
  }
  if (errors.length) return { ok: false, errors };
  const verdict = value.criteria.every(item => item.verdict === 'PASS') ? 'PASS' : value.criteria.some(item => item.verdict === 'FAIL') ? 'FAIL' : 'NOT_TESTED';
  return { ok: true, report: { ...value, verdict }, errors: [] };
}

export function calibrateChecker(cwd, issuer, dataset, policy = loadSecurityPolicy(cwd)) {
  if (!issuer) throw securityError('ISSUER_REQUIRED', 'Checker 校准需要 issuer');
  if (!Array.isArray(dataset?.cases) || dataset.cases.length < 4) throw securityError('CALIBRATION_DATASET_INVALID', '校准集至少需要 4 个已知标签样本');
  let tp = 0; let tn = 0; let fp = 0; let fn = 0;
  for (const item of dataset.cases) {
    if (!['PASS', 'FAIL'].includes(item.expected) || !['PASS', 'FAIL'].includes(item.verdict)) throw securityError('CALIBRATION_DATASET_INVALID', 'expected/verdict 只能是 PASS/FAIL');
    if (item.expected === 'PASS' && item.verdict === 'PASS') tp++; else if (item.expected === 'FAIL' && item.verdict === 'FAIL') tn++; else if (item.expected === 'FAIL') fp++; else fn++;
  }
  if (tp + fn === 0 || tn + fp === 0) throw securityError('CALIBRATION_DATASET_INVALID', '校准集必须同时包含已知好样本与坏样本');
  const falseAcceptRate = fp / (tn + fp); const falseRejectRate = fn / (tp + fn);
  const thresholds = policy?.checker || defaultSecurityPolicy().checker; const passed = falseAcceptRate <= thresholds.maxFalseAcceptRate && falseRejectRate <= thresholds.maxFalseRejectRate;
  const report = { schemaVersion: 1, calibrationId: crypto.randomUUID(), issuer, datasetDigest: sha256(dataset), confusion: { tp, tn, fp, fn }, falseAcceptRate, falseRejectRate, thresholds: { maxFalseAcceptRate: thresholds.maxFalseAcceptRate, maxFalseRejectRate: thresholds.maxFalseRejectRate }, verdict: passed ? 'PASS' : 'FAIL', calibratedAt: now() }; report.digest = sha256(report);
  const file = checkerCalibrationFile(cwd, issuer); atomicWriteJson(file, report); return { report, path: file };
}

function checkerCalibrationFile(cwd, issuer) { return path.join(trustHome(), 'checker-calibrations', sha256(fs.realpathSync(cwd)).slice(0, 40), `${safe(issuer)}.json`); }
export function loadCheckerCalibration(cwd, issuer) {
  const report = readJson(checkerCalibrationFile(cwd, issuer)); if (!report) return null;
  const copy = clone(report); const digest = copy.digest; delete copy.digest; return digest === sha256(copy) ? report : null;
}
