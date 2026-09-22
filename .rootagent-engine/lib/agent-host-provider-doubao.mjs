// agent-host-provider-doubao.mjs — 外部 SubAgent 宿主桥（Doubao、Codex、Claude Code、Kimi 等通用桥接）
//
// 设计：
// - RootAgent 内核不绑定任何特定模型 SDK；
//   它只要求宿主 runtime 暴露 nativeSubagents 的生命周期或桥接传输：
//   createSubagent / sendInput / wait / resume / close。
// - 本 provider 把这些方法对接到标准文件队列：
//     .rootagent/runtime/host-bridge/inbox/<executionId>.meta.json   （元数据）
//     .rootagent/runtime/host-bridge/inbox/<executionId>.input.json  （完整 request，含 prompt/contextPacket/resultSchema）
//     .rootagent/runtime/host-bridge/inbox/<executionId>.close.json  （结束信号）
//     .rootagent/runtime/host-bridge/outbox/<executionId>.result.json（写回：{ output, executionId }）
//     .rootagent/runtime/host-bridge/enabled.json                    （桥启用标记）
// - 支持两种消费模式：
//   1. 外部守护进程（Daemon）：后台轮询 inbox 并在完成后写入 outbox；wait() 同步等待。
//   2. 交互式 Agent（如 Doubao 主 Agent）：host drive 发布任务后安全挂起并返回 HOST_WAITING_SUBAGENT_EXECUTION，
//      由主 Agent 调用 create_agent 派生 SubAgent 开发，完成后通过 host bridge respond 提交响应，
//      再次 host drive 时恢复执行，彻底避免交互式单轮工具调用中的死锁。

import fs from 'fs';
import path from 'path';
import { createBuiltinLocalAgentHostRuntime, registerAgentHostRuntimeProvider } from './agent-host-runtime.mjs';
import { resultMatchesSchema } from './agent-host.mjs';
import { atomicWriteJson } from './trust-core.mjs';

const BRIDGE_RELATIVE_DIR = path.join('.rootagent', 'runtime', 'host-bridge');
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function inboxDir(cwd) { return path.join(cwd, BRIDGE_RELATIVE_DIR, 'inbox'); }
function outboxDir(cwd) { return path.join(cwd, BRIDGE_RELATIVE_DIR, 'outbox'); }

export function inboxFile(cwd, executionId, kind) {
  return path.join(inboxDir(cwd), `${executionId}.${kind}.json`);
}

export function outboxFile(cwd, executionId) {
  return path.join(outboxDir(cwd), `${executionId}.result.json`);
}

function bridgeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function enableDoubaoBridge(cwd, options = {}) {
  const dir = path.join(cwd, BRIDGE_RELATIVE_DIR);
  fs.mkdirSync(inboxDir(cwd), { recursive: true });
  fs.mkdirSync(outboxDir(cwd), { recursive: true });
  const enabledFile = path.join(dir, 'enabled.json');
  if (!fs.existsSync(enabledFile)) {
    atomicWriteJson(enabledFile, {
      schemaVersion: 1,
      enabled: true,
      mode: 'host-bridge',
      enabledAt: new Date().toISOString(),
      hostInstanceId: options.hostInstanceId || process.env.ROOTAGENT_HOST_INSTANCE_ID || process.env.DOUBAO_HOST_INSTANCE_ID || 'doubao-main-agent',
    });
  }
  return { ok: true, cwd, inbox: inboxDir(cwd), outbox: outboxDir(cwd) };
}

export function doubaoBridgeEnabled(cwd) {
  if (fs.existsSync(path.join(cwd, BRIDGE_RELATIVE_DIR, 'enabled.json'))) return true;
  if (process.env.ROOTAGENT_HOST_BRIDGE) return true;
  if (fs.existsSync(inboxDir(cwd))) return true;
  if (process.env.DOUBAO_HOST_INSTANCE_ID || process.env.DOUBAO_SESSION_ID || process.env.DOUBAO_EXECUTION_ID || process.env.ROOTAGENT_HOST_INSTANCE_ID) return true;
  return false;
}

export function listDoubaoBridgeRequests(cwd) {
  const dir = inboxDir(cwd);
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.input.json')).sort();
  for (const name of files) {
    const executionId = name.replace(/\.input\.json$/, '');
    let input = {};
    try { input = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')); } catch {}
    let meta = {};
    const metaPath = path.join(dir, `${executionId}.meta.json`);
    if (fs.existsSync(metaPath)) {
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}
    }
    const outPath = outboxFile(cwd, executionId);
    const responded = fs.existsSync(outPath);
    rows.push({
      executionId,
      role: input.role || meta.role || null,
      taskId: input.taskId || meta.taskId || null,
      status: responded ? 'RESPONDED' : 'PENDING',
      createdAt: meta.createdAt || null,
    });
  }
  return rows;
}

export function inspectDoubaoBridgeRequest(cwd, executionId) {
  const inFile = inboxFile(cwd, executionId, 'input');
  if (!fs.existsSync(inFile)) {
    throw bridgeError('HOST_BRIDGE_REQUEST_NOT_FOUND', `bridge request not found: ${executionId}`);
  }
  let request;
  try { request = JSON.parse(fs.readFileSync(inFile, 'utf-8')); }
  catch (e) { throw bridgeError('HOST_BRIDGE_REQUEST_INVALID', e.message); }
  let meta = null;
  const mFile = inboxFile(cwd, executionId, 'meta');
  if (fs.existsSync(mFile)) {
    try { meta = JSON.parse(fs.readFileSync(mFile, 'utf-8')); } catch {}
  }
  let response = null;
  const oFile = outboxFile(cwd, executionId);
  if (fs.existsSync(oFile)) {
    try { response = JSON.parse(fs.readFileSync(oFile, 'utf-8')); } catch {}
  }
  return { executionId, meta, request, response };
}

export function respondDoubaoBridgeRequest(cwd, executionId, output, options = {}) {
  const inspected = inspectDoubaoBridgeRequest(cwd, executionId);
  const schema = inspected.request?.resultSchema || { type: 'any' };
  if (!resultMatchesSchema(output, schema)) {
    throw bridgeError('HOST_RESULT_SCHEMA_MISMATCH', 'response must match request.resultSchema; inspect the request and resubmit');
  }
  fs.mkdirSync(outboxDir(cwd), { recursive: true });
  const payload = {
    executionId,
    output,
    respondedAt: new Date().toISOString(),
  };
  const outFile = outboxFile(cwd, executionId);
  atomicWriteJson(outFile, payload);
  return { ok: true, executionId, file: outFile, payload };
}

async function waitForOutput(cwd, executionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const file = outboxFile(cwd, executionId);
    if (fs.existsSync(file)) {
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(file, 'utf-8')); }
      catch { /* 宿主正在写入，等待下一次轮询 */ }
      if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'output')) return parsed;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw bridgeError('HOST_BRIDGE_TIMEOUT', `host bridge wait timeout: ${executionId} (${timeoutMs}ms)`);
}

export function createDoubaoBridgeProvider(options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? process.env.ROOTAGENT_HOST_BRIDGE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const activeResponses = new Map();

  return {
    id: options.id || 'doubao-host-bridge',
    priority: Number(options.priority ?? 100),
    async detect({ cwd }) {
      if (!doubaoBridgeEnabled(cwd)) return { matched: false };
      fs.mkdirSync(inboxDir(cwd), { recursive: true });
      fs.mkdirSync(outboxDir(cwd), { recursive: true });

      const base = createBuiltinLocalAgentHostRuntime(cwd);
      return {
        matched: true,
        runtime: {
          ...base,
          bridgeTimeoutMs: timeoutMs,
          hostInstanceId: options.hostInstanceId || process.env.ROOTAGENT_HOST_INSTANCE_ID || process.env.DOUBAO_HOST_INSTANCE_ID || 'doubao-main-agent',
          sessionId: options.sessionId || process.env.ROOTAGENT_SESSION_ID || process.env.DOUBAO_SESSION_ID || 'doubao-session-1',
          executionId: options.executionId || process.env.ROOTAGENT_EXECUTION_ID || process.env.DOUBAO_EXECUTION_ID || 'doubao-exec-1',
          cooperativeBridge: {
            timeoutMs,
            publish(request) {
              fs.mkdirSync(inboxDir(cwd), { recursive: true });
              const meta = {
                executionId: request.executionId,
                role: request.role,
                contextRole: request.contextRole || request.role,
                taskId: request.taskId,
                allowedActions: request.allowedActions || [],
                createdAt: new Date().toISOString(),
              };
              atomicWriteJson(inboxFile(cwd, request.executionId, 'meta'), meta);
              atomicWriteJson(inboxFile(cwd, request.executionId, 'input'), request);
            },
            async readResponse(executionId, { timeoutMs: waitTimeout } = {}) {
              const file = outboxFile(cwd, executionId);
              if (fs.existsSync(file)) {
                try {
                  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
                  if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'output')) return parsed;
                } catch {}
              }
              const ms = Number(waitTimeout ?? 0);
              if (ms <= 0) return null;
              const deadline = Date.now() + ms;
              while (Date.now() < deadline) {
                if (fs.existsSync(file)) {
                  try {
                    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
                    if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'output')) return parsed;
                  } catch {}
                }
                await new Promise(resolve => setTimeout(resolve, 100));
              }
              return null;
            },
            activate(response) {
              activeResponses.set(response.executionId, response);
            },
            clear() {
              activeResponses.clear();
            },
          },
          nativeSubagents: {
            freshContext: true,
            independentContext: true,
            parallel: true,
            maxWorkers: 4,
            async createSubagent({ role, contextRole, taskId, allowedActions }) {
              if (!role || !taskId) {
                throw bridgeError('HOST_INTERRUPT_INVALID', 'bridge createSubagent requires role and taskId');
              }
              // 若已有激活响应匹配该角色/任务，复用其 executionId
              for (const [id, resp] of activeResponses.entries()) {
                if (id.startsWith(`${role}-${taskId}-`)) return { executionId: id };
              }
              const executionId = `${role}-${taskId}-${Date.now()}`;
              atomicWriteJson(inboxFile(cwd, executionId, 'meta'), {
                executionId,
                role,
                contextRole: contextRole || role,
                taskId,
                allowedActions: Array.isArray(allowedActions) ? allowedActions : [],
                createdAt: new Date().toISOString(),
              });
              return { executionId };
            },
            async sendInput(handle, request) {
              if (!handle || !handle.executionId) {
                throw bridgeError('HOST_EXECUTION_ID_REQUIRED', 'bridge subagent handle must expose executionId');
              }
              atomicWriteJson(inboxFile(cwd, handle.executionId, 'input'), request);
            },
            async wait(handle) {
              if (!handle || !handle.executionId) {
                throw bridgeError('HOST_EXECUTION_ID_REQUIRED', 'bridge subagent handle must expose executionId');
              }
              if (activeResponses.has(handle.executionId)) {
                return activeResponses.get(handle.executionId);
              }
              return waitForOutput(cwd, handle.executionId, timeoutMs);
            },
            async resume(handle) {
              if (!handle || !handle.executionId) {
                throw bridgeError('HOST_EXECUTION_ID_REQUIRED', 'bridge subagent handle must expose executionId');
              }
              if (activeResponses.has(handle.executionId)) {
                return activeResponses.get(handle.executionId);
              }
              return waitForOutput(cwd, handle.executionId, timeoutMs);
            },
            async close(handle) {
              if (!handle || !handle.executionId) return;
              atomicWriteJson(inboxFile(cwd, handle.executionId, 'close'), {
                executionId: handle.executionId,
                closedAt: new Date().toISOString(),
              });
            },
          },
        },
      };
    },
  };
}

export function registerDoubaoBridgeProvider(options) {
  return registerAgentHostRuntimeProvider(createDoubaoBridgeProvider(options));
}
