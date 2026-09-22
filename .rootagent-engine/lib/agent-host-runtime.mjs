import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { executeCommand } from './command-execution.mjs';
import { discoverAgentHostCapabilities } from './agent-host.mjs';

export const AGENT_HOST_RUNTIME_SYMBOL_NAME = 'rootagent.agentHostRuntime.v1';
export const AGENT_HOST_RUNTIME_SYMBOL = Symbol.for(AGENT_HOST_RUNTIME_SYMBOL_NAME);

const REGISTERED_PROVIDERS = new Map();

function callable(value) {
  return typeof value === 'function';
}

function clonePrimitive(value) {
  if (value == null) return value;
  if (['string', 'number', 'boolean'].includes(typeof value)) return value;
  return undefined;
}

function sanitizeNative(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out = {};
  for (const key of ['createSubagent', 'sendInput', 'wait', 'resume', 'close']) {
    if (callable(input[key])) out[key] = input[key];
  }
  for (const key of ['freshContext', 'independentContext', 'parallel']) {
    if (typeof input[key] === 'boolean') out[key] = input[key];
  }
  if (Number.isInteger(input.maxWorkers) && input.maxWorkers > 0) out.maxWorkers = input.maxWorkers;
  return Object.keys(out).length ? Object.freeze(out) : undefined;
}

function sanitizeRoleIsolation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out = {};
  if (callable(input.executeRole)) out.executeRole = input.executeRole;
  if (typeof input.freshContext === 'boolean') out.freshContext = input.freshContext;
  return Object.keys(out).length ? Object.freeze(out) : undefined;
}

function sanitizeCooperativeChat(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out = {};
  for (const key of ['publish', 'readResponse', 'activate', 'clear']) {
    if (callable(input[key])) out[key] = input[key];
  }
  return ['publish', 'readResponse', 'activate'].every(key => callable(out[key]))
    ? Object.freeze(out)
    : undefined;
}

function sanitizeCooperativeBridge(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out = {};
  for (const key of ['publish', 'readResponse', 'activate', 'clear']) {
    if (callable(input[key])) out[key] = input[key];
  }
  if (input.timeoutMs != null) out.timeoutMs = Number(input.timeoutMs);
  return ['publish', 'readResponse', 'activate'].every(key => callable(out[key]))
    ? Object.freeze(out)
    : undefined;
}

function sanitizeFilesystem(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out = {};
  if (callable(input.read) || input.read === true) out.read = input.read;
  if (callable(input.write) || input.write === true) out.write = input.write;
  return Object.keys(out).length ? Object.freeze(out) : undefined;
}

function sanitizeGit(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out = {};
  if (typeof input.available === 'boolean' || callable(input.available)) out.available = input.available;
  if (typeof input.worktree === 'boolean' || callable(input.worktree)) out.worktree = input.worktree;
  if (callable(input.status)) out.status = input.status;
  if (callable(input.commit)) out.commit = input.commit;
  return Object.keys(out).length ? Object.freeze(out) : undefined;
}

function sanitizePersistence(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out = {};
  for (const key of ['durableSession', 'resumeSession', 'persistentFiles']) {
    if (typeof input[key] === 'boolean' || callable(input[key])) out[key] = input[key];
  }
  return Object.keys(out).length ? Object.freeze(out) : undefined;
}

function sanitizeExternalWorker(input, index) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {
    id: String(input.id || ('worker-' + (index + 1))),
    trusted: input.trusted === true,
  };
  if (callable(input.executeRole)) out.executeRole = input.executeRole;
  if (input.driver && typeof input.driver === 'object' && callable(input.driver.executeRole)) {
    out.driver = Object.freeze({ executeRole: input.driver.executeRole });
  }
  if (input.capabilities && typeof input.capabilities === 'object' && !Array.isArray(input.capabilities)) {
    const caps = {};
    for (const key of ['freshContext', 'independentContext', 'physicalIsolation', 'parallel']) {
      if (typeof input.capabilities[key] === 'boolean') caps[key] = input.capabilities[key];
    }
    if (Number.isInteger(input.capabilities.maxWorkers) && input.capabilities.maxWorkers > 0) {
      caps.maxWorkers = input.capabilities.maxWorkers;
    }
    if (input.capabilities.execution && typeof input.capabilities.execution === 'object' && !Array.isArray(input.capabilities.execution)) {
      const execution = {};
      for (const key of ['commandExecution', 'filesystemRead', 'filesystemWrite', 'git', 'worktree', 'processIsolation', 'network']) {
        if (typeof input.capabilities.execution[key] === 'boolean') execution[key] = input.capabilities.execution[key];
      }
      caps.execution = Object.freeze(execution);
    }
    out.capabilities = Object.freeze(caps);
  }
  return Object.freeze(out);
}

export function normalizeAgentHostRuntimeBindings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'HOST_RUNTIME_INVALID', reason: 'Agent Host runtime bindings must be an object' };
  }

  const runtime = {};
  for (const key of ['hostInstanceId', 'sessionId', 'executionId']) {
    const value = clonePrimitive(input[key]);
    if (value != null) runtime[key] = String(value);
  }

  const nativeSubagents = sanitizeNative(input.nativeSubagents);
  if (nativeSubagents) runtime.nativeSubagents = nativeSubagents;

  const roleIsolation = sanitizeRoleIsolation(input.roleIsolation);
  if (roleIsolation) runtime.roleIsolation = roleIsolation;

  const cooperativeChat = sanitizeCooperativeChat(input.cooperativeChat);
  if (cooperativeChat) runtime.cooperativeChat = cooperativeChat;

  const cooperativeBridge = sanitizeCooperativeBridge(input.cooperativeBridge);
  if (cooperativeBridge) runtime.cooperativeBridge = cooperativeBridge;
  if (input.bridgeTimeoutMs != null) runtime.bridgeTimeoutMs = Number(input.bridgeTimeoutMs);

  if (callable(input.executeRole)) runtime.executeRole = input.executeRole;
  if (callable(input.executeCommand)) runtime.executeCommand = input.executeCommand;

  const filesystem = sanitizeFilesystem(input.filesystem);
  if (filesystem) runtime.filesystem = filesystem;

  const git = sanitizeGit(input.git);
  if (git) runtime.git = git;

  if (typeof input.processIsolation === 'boolean' || callable(input.processIsolation)) runtime.processIsolation = input.processIsolation;
  if (typeof input.network === 'boolean' || callable(input.network)) runtime.network = input.network;

  const persistence = sanitizePersistence(input.persistence);
  if (persistence) runtime.persistence = persistence;

  if (typeof input.humanApproval === 'boolean' || callable(input.humanApproval)) runtime.humanApproval = input.humanApproval;
  if (typeof input.notifications === 'boolean' || callable(input.notifications)) runtime.notifications = input.notifications;

  if (Array.isArray(input.externalWorkers)) {
    runtime.externalWorkers = Object.freeze(input.externalWorkers.map(sanitizeExternalWorker).filter(Boolean));
  }

  return { ok: true, runtime: Object.freeze(runtime) };
}

function profileFor(capabilities) {
  if (capabilities?.agent?.nativeSubagents) return 'NATIVE_MULTI_AGENT';
  if (capabilities?.agent?.sameAgentRoleIsolation) return 'SINGLE_AGENT_ROLE_ISOLATION';
  if ((capabilities?.externalWorkers || []).some(worker => worker.trusted && worker.canExecuteRole)) return 'EXTERNAL_WORKER';
  return 'SUPERVISOR_ONLY';
}

function safeProjectPath(cwd, relative) {
  const root = fs.realpathSync(cwd);
  const absolute = path.resolve(root, String(relative || '.'));
  const parent = fs.existsSync(absolute) ? fs.realpathSync(absolute) : path.dirname(absolute);
  const rel = path.relative(root, parent);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const error = new Error('runtime filesystem path escapes project root');
    error.code = 'HOST_RUNTIME_PATH_ESCAPE';
    throw error;
  }
  return absolute;
}

function gitProbe(cwd, args) {
  try {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function createBuiltinLocalAgentHostRuntime(cwd) {
  const gitAvailable = gitProbe(cwd, ['rev-parse', '--is-inside-work-tree']);
  const worktreeAvailable = gitAvailable && gitProbe(cwd, ['worktree', 'list', '--porcelain']);
  const runtime = {
    hostInstanceId: 'builtin-local-node',
    executeCommand: spec => executeCommand(cwd, spec, { automated: true }),
    filesystem: {
      read(relative, encoding = 'utf-8') {
        return fs.readFileSync(safeProjectPath(cwd, relative), encoding);
      },
      write(relative, value) {
        const target = safeProjectPath(cwd, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, value);
        return target;
      },
    },
    git: {
      available: gitAvailable,
      worktree: worktreeAvailable,
      status() {
        const result = spawnSync('git', ['status', '--porcelain=v1'], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        return { ok: result.status === 0, output: result.stdout || '' };
      },
    },
    processIsolation: false,
    network: false,
    persistence: {
      durableSession: true,
      resumeSession: true,
      persistentFiles: true,
    },
  };
  return normalizeAgentHostRuntimeBindings(runtime).runtime;
}

function validateProvider(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    return { ok: false, code: 'HOST_RUNTIME_PROVIDER_INVALID', reason: 'Provider must be an object' };
  }
  if (!provider.id || typeof provider.id !== 'string' || !callable(provider.detect)) {
    return { ok: false, code: 'HOST_RUNTIME_PROVIDER_INVALID', reason: 'Provider requires string id and detect()' };
  }
  if (provider.priority != null && !Number.isFinite(provider.priority)) {
    return { ok: false, code: 'HOST_RUNTIME_PROVIDER_INVALID', reason: 'Provider priority must be numeric' };
  }
  return { ok: true };
}

export function registerAgentHostRuntimeProvider(provider) {
  const checked = validateProvider(provider);
  if (!checked.ok) {
    const error = new Error(checked.reason);
    error.code = checked.code;
    throw error;
  }
  REGISTERED_PROVIDERS.set(provider.id, provider);
  return () => REGISTERED_PROVIDERS.delete(provider.id);
}

function orderedProviders(extra = []) {
  const merged = [...(Array.isArray(extra) ? extra : []), ...REGISTERED_PROVIDERS.values()];
  const unique = new Map();
  for (const provider of merged) {
    const checked = validateProvider(provider);
    if (!checked.ok) return { ok: false, ...checked };
    if (!unique.has(provider.id)) unique.set(provider.id, provider);
  }
  return {
    ok: true,
    providers: [...unique.values()].sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) || a.id.localeCompare(b.id)),
  };
}

function resolvedRuntime(source, normalized, providerId = null) {
  const capabilities = discoverAgentHostCapabilities(normalized.runtime);
  return {
    ok: true,
    code: 'HOST_RUNTIME_RESOLVED',
    source,
    providerId,
    profile: profileFor(capabilities),
    runtime: normalized.runtime,
    capabilities,
  };
}

export async function resolveAgentHostRuntime(cwd, options = {}) {
  if (options.runtime !== undefined && options.runtime !== null) {
    const normalized = normalizeAgentHostRuntimeBindings(options.runtime);
    if (!normalized.ok) return normalized;
    return resolvedRuntime('explicit', normalized);
  }

  const globalObject = options.globalObject === undefined ? globalThis : options.globalObject;
  const globalBinding = globalObject && globalObject[AGENT_HOST_RUNTIME_SYMBOL];
  if (globalBinding !== undefined && globalBinding !== null) {
    const normalized = normalizeAgentHostRuntimeBindings(globalBinding);
    if (!normalized.ok) return { ...normalized, source: 'standard-global' };
    return resolvedRuntime('standard-global', normalized);
  }

  const providers = orderedProviders(options.providers);
  if (!providers.ok) return providers;

  for (const provider of providers.providers) {
    let detected;
    try {
      detected = await provider.detect({
        cwd,
        symbol: AGENT_HOST_RUNTIME_SYMBOL,
        symbolName: AGENT_HOST_RUNTIME_SYMBOL_NAME,
      });
    } catch (error) {
      return {
        ok: false,
        code: error?.code || 'HOST_RUNTIME_PROVIDER_FAILED',
        reason: error?.message || String(error),
        providerId: provider.id,
      };
    }
    if (detected == null || detected === false || detected?.matched === false) continue;
    const candidate = detected?.runtime ?? detected;
    const normalized = normalizeAgentHostRuntimeBindings(candidate);
    if (!normalized.ok) return { ...normalized, source: 'registered-provider', providerId: provider.id };
    return resolvedRuntime('registered-provider', normalized, provider.id);
  }

  const local = createBuiltinLocalAgentHostRuntime(cwd);
  return resolvedRuntime('builtin-local', { ok: true, runtime: local });
}
