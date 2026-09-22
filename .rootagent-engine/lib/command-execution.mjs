import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { sha256 } from './trust-core.mjs';

export const COMMAND_EFFECTS = Object.freeze(['pure', 'workspace-write', 'side-effect']);
export const COMMAND_SCOPES = Object.freeze(['task', 'project']);
export const COMMAND_NETWORK = Object.freeze(['deny', 'allow']);
const SHELL_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'env', 'cmd', 'cmd.exe', 'powershell', 'pwsh']);
const now = () => new Date().toISOString();

function commandError(code, message, data = {}) { const error = new Error(message); error.code = code; error.data = data; return error; }
function cleanPath(value) { return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, ''); }

export function isCommandSpec(value) {
  return !!value && typeof value === 'object' && typeof value.program === 'string' && Array.isArray(value.args);
}

export function validateCommandSpec(value, options = {}) {
  const errors = [];
  if (!isCommandSpec(value)) return { ok: false, errors: ['必须使用 {program,args,...} CommandSpec'] };
  const spec = {
    program: value.program.trim(), args: [...value.args], cwd: value.cwd == null ? '.' : String(value.cwd),
    effect: value.effect || 'pure', scope: value.scope || 'task', readPaths: [...(value.readPaths || [])],
    writePaths: [...(value.writePaths || [])], network: value.network || 'deny', timeoutMs: Number(value.timeoutMs || 300000),
    ...(Number.isInteger(value.level) ? { level: value.level } : {}), ...(value.ladder ? { ladder: value.ladder } : {}),
  };
  if (!spec.program || /[\/]/.test(spec.program) || SHELL_WRAPPERS.has(spec.program.toLowerCase())) errors.push('program 不能是路径、shell 或 env 包装器');
  if (spec.args.some(arg => typeof arg !== 'string')) errors.push('args 必须全部是字符串');
  if ((options.validation || options.setup || options.automated) && spec.args.some(arg => /(^|[\s'"=])\/(?!\/)/.test(arg))) errors.push('自动化命令参数不得引用工作区外绝对路径');
  if ((options.validation || options.setup || options.automated) && spec.args.some(arg => /(^|\s)&($|\s)/.test(arg))) errors.push('自动化命令参数不得请求后台执行');
  if (!COMMAND_EFFECTS.includes(spec.effect)) errors.push(`effect 必须是 ${COMMAND_EFFECTS.join('/')}`);
  if (!COMMAND_SCOPES.includes(spec.scope)) errors.push(`scope 必须是 ${COMMAND_SCOPES.join('/')}`);
  if (!COMMAND_NETWORK.includes(spec.network)) errors.push(`network 必须是 ${COMMAND_NETWORK.join('/')}`);
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0 || spec.timeoutMs > 3600000) errors.push('timeoutMs 必须在 1..3600000');
  for (const field of ['readPaths', 'writePaths']) {
    if (!Array.isArray(value[field] || [])) errors.push(`${field} 必须是数组`);
    else for (const item of spec[field]) if (typeof item !== 'string' || !cleanPath(item) || path.isAbsolute(item) || cleanPath(item).split('/').includes('..')) errors.push(`${field} 只能声明项目内相对路径`);
  }
  if (spec.effect === 'pure' && spec.writePaths.length) errors.push('pure 命令不得声明 writePaths');
  if (options.validation && spec.effect === 'side-effect') errors.push('验证命令禁止 side-effect');
  if (options.setup && spec.effect !== 'workspace-write') errors.push('setup 命令必须是 workspace-write');
  if (options.setup && spec.scope !== 'task') errors.push('setup 命令必须是 task scope');
  return { ok: errors.length === 0, errors, spec };
}

export function normalizeCommand(value, options = {}) {
  if (isCommandSpec(value)) {
    const checked = validateCommandSpec(value, options);
    if (!checked.ok) throw commandError('INVALID_COMMAND_SPEC', checked.errors.join('；'), { errors: checked.errors });
    return { mode: 'structured', spec: checked.spec, level: Number.isInteger(value.level) ? value.level : 1, ladder: value.ladder || 'L' };
  }
  const cmd = typeof value === 'string' ? value : value?.cmd;
  if (!cmd || typeof cmd !== 'string') throw commandError('INVALID_COMMAND', '命令不能为空');
  if (options.automated || process.env.ROOTAGENT_UNATTENDED === '1') throw commandError('STRUCTURED_COMMAND_REQUIRED', 'Proposal、并行或无人值守执行必须使用 CommandSpec');
  return { mode: 'opaque-interactive', cmd, level: Number.isInteger(value?.level) ? value.level : 1, ladder: value?.ladder || 'L', warning: '旧字符串命令仅限交互兼容；未作为安全边界解析' };
}

export function commandIdentity(value) {
  if (isCommandSpec(value)) {
    const checked = validateCommandSpec(value);
    return checked.ok ? `S:${sha256(checked.spec)}` : `INVALID:${sha256(value)}`;
  }
  const cmd = typeof value === 'string' ? value : value?.cmd;
  return `O:${String(cmd || '')}`;
}

export function commandDisplay(value) {
  if (isCommandSpec(value)) return [value.program, ...(value.args || [])].map(part => /\s/.test(part) ? JSON.stringify(part) : part).join(' ');
  return typeof value === 'string' ? value : String(value?.cmd || '');
}

// 展开常见命令包装（env VAR=x cmd、sh -c "…" / bash -c '…' 等），供旧字符串命令警告检出被包装的风险
function unwrapCommandWrappers(command) {
  let current = String(command || '').trim();
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 4) {
    changed = false;
    const envPrefix = current.match(/^(?:env\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/);
    if (envPrefix) { current = current.slice(envPrefix[0].length).trim(); changed = true; continue; }
    const shellWrap = current.match(/^(?:sh|bash|zsh|dash|fish|ksh)\s+-[a-z]*c\s+(?:"([^"]*)"|'([^']*)')/);
    if (shellWrap) { current = (shellWrap[1] || shellWrap[2] || current).trim(); changed = true; }
  }
  return current;
}

export function legacyCommandWarnings(value) {
  const command = commandDisplay(value); if (isCommandSpec(value)) return [];
  const body = unwrapCommandWrappers(command);
  // 解包仅用于补充提示，永远保留原文扫描；简化的引号解析不得制造比旧实现更多的漏报。
  const sources = [...new Set([command, body])];
  const warnings = [];
  if (sources.some(source => /\b(?:pkill|killall)\b/.test(source))) warnings.push('包含跨进程 kill');
  if (sources.some(source => /(?:^|[^&])&(?![&>\d])/.test(source))) warnings.push('可能启动后台进程');
  if (sources.some(source => /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:dev|serve|preview)\b/.test(source))) warnings.push('可能启动长驻服务');
  if (sources.some(source => /(?:^|\s)(?:>|>>|&>)\s*(?:\/tmp\/|\/var\/tmp\/)/.test(source))) warnings.push('可能写入共享临时路径');
  return warnings;
}

export function resolveCommandCwd(rootCwd, declared = '.') {
  const root = fs.realpathSync(rootCwd); const absolute = path.resolve(root, declared || '.');
  const existing = fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute;
  const rel = path.relative(root, existing);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw commandError('COMMAND_CWD_OUTSIDE_WORKSPACE', `命令 cwd 超出工作区：${declared}`);
  return existing;
}

function isolatedEnvironment(tempHome, extra = {}) {
  const env = { PATH: process.env.PATH || '', HOME: tempHome, TMPDIR: path.join(tempHome, 'tmp'), TEMP: path.join(tempHome, 'tmp'), TMP: path.join(tempHome, 'tmp'), ROOTAGENT_VALIDATE: '1' };
  for (const key of ['LANG', 'LC_ALL']) if (process.env[key] != null) env[key] = process.env[key];
  for (const [key, value] of Object.entries(extra)) if (key.startsWith('ROOTAGENT_') || key === 'TRACEPARENT' || key === 'RA_RED') env[key] = String(value);
  return env;
}

export function executeCommand(cwd, value, options = {}) {
  const normalized = normalizeCommand(value, { automated: options.automated, validation: options.validation, setup: options.setup });
  if (normalized.spec?.effect === 'workspace-write' && !options.isolatedWorkspace) throw commandError('WORKTREE_REQUIRED', 'workspace-write 命令只能在显式隔离 worktree 中执行');
  const started = Date.now(); const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rootagent-command-')); fs.mkdirSync(path.join(tempHome, 'tmp'));
  let result;
  try {
    if (normalized.mode === 'structured') {
      const spec = normalized.spec; const executionCwd = resolveCommandCwd(cwd, spec.cwd);
      result = spawnSync(spec.program, spec.args, { cwd: executionCwd, shell: false, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: Math.min(spec.timeoutMs, Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : spec.timeoutMs), env: isolatedEnvironment(tempHome, options.env) });
    } else {
      result = spawnSync('/bin/sh', ['-c', normalized.cmd], { cwd, shell: false, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: Number(options.timeoutMs || 300000), env: isolatedEnvironment(tempHome, options.env) });
    }
    const output = `${result.stdout || ''}${result.stderr || ''}`; const timedOut = result.error?.code === 'ETIMEDOUT';
    const receipt = { schemaVersion: 1, commandIdentity: commandIdentity(value), mode: normalized.mode, sandboxed: false, network: normalized.spec?.network || 'unknown', exitCode: result.status ?? (timedOut ? 124 : 70), signal: result.signal || null, durationMs: Date.now() - started, outputDigest: sha256(output), outputTail: output.slice(-4000), timedOut, executedAt: now() };
    receipt.digest = sha256(receipt);
    return { ok: receipt.exitCode === 0, code: receipt.exitCode, out: output, receipt, normalized };
  } finally { try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* OS 会回收临时目录 */ } }
}
