// agent-host-provider-chat.mjs — cooperative single-chat Agent Host transport.
//
// This provider never claims native SubAgents. It publishes a durable role request,
// lets the current chat session perform the work, and consumes a separately submitted
// raw response. Agent Host Broker remains responsible for schema validation and
// provenance; RootAgent remains responsible for Candidate/pass/Receipt authority.

import fs from 'fs';
import path from 'path';
import { atomicWriteJson, sha256 } from './trust-core.mjs';
import { resultMatchesSchema } from './agent-host.mjs';
import { createBuiltinLocalAgentHostRuntime, registerAgentHostRuntimeProvider } from './agent-host-runtime.mjs';

const CHAT_ROOT = path.join('.rootagent', 'runtime', 'host-chat');
const ENABLED_FILE = 'enabled.json';

function root(cwd) { return path.join(cwd, CHAT_ROOT); }
function requestsDir(cwd) { return path.join(root(cwd), 'requests'); }
function requestFile(cwd, requestId) { return path.join(requestsDir(cwd), `${safeId(requestId)}.request.json`); }
function responseFile(cwd, requestId) { return path.join(requestsDir(cwd), `${safeId(requestId)}.response.json`); }
function safeId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw failure('HOST_CHAT_REQUEST_INVALID', 'requestId must be a non-empty filename-safe identifier');
  }
  return value;
}
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readJson(file, code) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch (error) { throw failure(code, error.message); }
}

function signed(value) {
  const record = clone(value);
  delete record.digest;
  record.digest = sha256(record);
  return record;
}

// 内容身份 = 排除时间戳元数据后的签名子集。时间戳不是内容：崩溃后重新发布、
// 用户重复提交同一响应时，内容身份相同必须幂等返回，而不是误报冲突。
function contentIdentity(record, keys) {
  const subset = {};
  for (const key of keys) subset[key] = clone(record[key]);
  return sha256(subset);
}

function verifySigned(record, code) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw failure(code, 'record must be an object');
  const claimed = record.digest;
  const copy = clone(record);
  delete copy.digest;
  if (!claimed || claimed !== sha256(copy)) throw failure(code, 'record digest invalid');
  return record;
}

export function enableChatHost(cwd, options = {}) {
  fs.mkdirSync(requestsDir(cwd), { recursive: true });
  const file = path.join(root(cwd), ENABLED_FILE);
  if (fs.existsSync(file)) return verifySigned(readJson(file, 'HOST_CHAT_CONFIG_INVALID'), 'HOST_CHAT_CONFIG_INVALID');
  const record = signed({
    schemaVersion: 1,
    enabled: true,
    hostInstanceId: options.hostInstanceId || 'cooperative-chat-host',
    sessionId: options.sessionId || 'cooperative-chat-session',
    enabledAt: new Date().toISOString(),
  });
  atomicWriteJson(file, record);
  return record;
}

export function chatHostEnabled(cwd) {
  const file = path.join(root(cwd), ENABLED_FILE);
  if (!fs.existsSync(file)) return false;
  const config = verifySigned(readJson(file, 'HOST_CHAT_CONFIG_INVALID'), 'HOST_CHAT_CONFIG_INVALID');
  return config.enabled === true;
}

export function publishChatHostRequest(cwd, input) {
  enableChatHost(cwd);
  if (!input?.requestId || !input?.runId || !input?.interruptId || !input?.executionKey) {
    throw failure('HOST_CHAT_REQUEST_INVALID', 'chat request requires requestId/runId/interruptId/executionKey');
  }
  const record = signed({
    schemaVersion: 1,
    requestId: String(input.requestId),
    status: 'PENDING',
    runId: String(input.runId),
    interruptId: String(input.interruptId),
    executionKey: String(input.executionKey),
    nodeId: String(input.nodeId || ''),
    role: String(input.role || ''),
    taskId: String(input.taskId || ''),
    subject: clone(input.subject || {}),
    contextPacketDigest: input.contextPacketDigest || null,
    request: clone(input.request),
    publishedAt: input.publishedAt || new Date().toISOString(),
  });
  const file = requestFile(cwd, record.requestId);
  if (fs.existsSync(file)) {
    const existing = verifySigned(readJson(file, 'HOST_CHAT_REQUEST_INVALID'), 'HOST_CHAT_REQUEST_INVALID');
    const identityKeys = ['schemaVersion', 'requestId', 'status', 'runId', 'interruptId', 'executionKey', 'nodeId', 'role', 'taskId', 'subject', 'contextPacketDigest', 'request'];
    if (contentIdentity(existing, identityKeys) !== contentIdentity(record, identityKeys)) {
      throw failure('HOST_CHAT_REQUEST_CONFLICT', 'requestId already exists with different content');
    }
    return existing;
  }
  atomicWriteJson(file, record);
  return record;
}

export function listChatHostRequests(cwd) {
  const dir = requestsDir(cwd);
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.request.json')).sort()) {
    const request = verifySigned(readJson(path.join(dir, name), 'HOST_CHAT_REQUEST_INVALID'), 'HOST_CHAT_REQUEST_INVALID');
    rows.push({
      requestId: request.requestId,
      status: fs.existsSync(responseFile(cwd, request.requestId)) ? 'RESPONDED' : 'PENDING',
      runId: request.runId,
      role: request.role,
      taskId: request.taskId,
      publishedAt: request.publishedAt,
      digest: request.digest,
    });
  }
  return rows;
}

export function inspectChatHostRequest(cwd, requestId) {
  const file = requestFile(cwd, requestId);
  if (!fs.existsSync(file)) throw failure('HOST_CHAT_REQUEST_NOT_FOUND', `chat request not found: ${requestId}`);
  const request = verifySigned(readJson(file, 'HOST_CHAT_REQUEST_INVALID'), 'HOST_CHAT_REQUEST_INVALID');
  let response = null;
  const responsePath = responseFile(cwd, requestId);
  if (fs.existsSync(responsePath)) response = verifySigned(readJson(responsePath, 'HOST_CHAT_RESPONSE_INVALID'), 'HOST_CHAT_RESPONSE_INVALID');
  return { request, response };
}

export function respondChatHostRequest(cwd, requestId, output, options = {}) {
  const { request } = inspectChatHostRequest(cwd, requestId);
  // Reject correctable input mistakes before the immutable response is written.
  // The Broker still validates again when consuming the response.
  if (!resultMatchesSchema(output, request.request?.resultSchema || { type: 'any' })) {
    throw failure('HOST_RESULT_SCHEMA_MISMATCH', 'response must match request.resultSchema; inspect the request and resubmit');
  }
  const record = signed({
    schemaVersion: 1,
    requestId: request.requestId,
    requestDigest: request.digest,
    subject: clone(request.subject),
    contextPacketDigest: request.contextPacketDigest,
    executionId: options.executionId || `${request.role}-${request.requestId}`,
    output: clone(output),
    respondedAt: options.respondedAt || new Date().toISOString(),
  });
  const file = responseFile(cwd, requestId);
  if (fs.existsSync(file)) {
    const existing = verifySigned(readJson(file, 'HOST_CHAT_RESPONSE_INVALID'), 'HOST_CHAT_RESPONSE_INVALID');
    const identityKeys = ['schemaVersion', 'requestId', 'requestDigest', 'subject', 'contextPacketDigest', 'executionId', 'output'];
    if (contentIdentity(existing, identityKeys) !== contentIdentity(record, identityKeys)) {
      throw failure('HOST_CHAT_RESPONSE_CONFLICT', 'chat request already has a different response');
    }
    return existing;
  }
  atomicWriteJson(file, record);
  return record;
}

export function readChatHostResponse(cwd, requestId, expected = {}) {
  const file = responseFile(cwd, requestId);
  if (!fs.existsSync(file)) return null;
  const response = verifySigned(readJson(file, 'HOST_CHAT_RESPONSE_INVALID'), 'HOST_CHAT_RESPONSE_INVALID');
  const { request } = inspectChatHostRequest(cwd, requestId);
  if (response.requestId !== request.requestId) throw failure('HOST_CHAT_RESPONSE_REQUEST_MISMATCH', 'response requestId mismatch');
  if (response.requestDigest !== request.digest) throw failure('HOST_CHAT_RESPONSE_REQUEST_MISMATCH', 'response is not bound to the current request');
  if (response.contextPacketDigest !== request.contextPacketDigest) throw failure('HOST_CHAT_RESPONSE_CONTEXT_MISMATCH', 'response ContextPacket digest mismatch');
  for (const field of ['taskId', 'contractDigest', 'attemptId', 'fencingToken']) {
    if (response.subject?.[field] !== request.subject?.[field]
        || (expected.subject && response.subject?.[field] !== expected.subject[field])) {
      throw failure('HOST_CHAT_RESPONSE_SUBJECT_MISMATCH', `response subject mismatch: ${field}`);
    }
  }
  return response;
}

export function createChatHostProvider(options = {}) {
  return {
    id: options.id || 'cooperative-chat-host',
    // Explicit chat opt-in takes precedence over a leftover file bridge.
    priority: Number(options.priority ?? 110),
    async detect({ cwd }) {
      if (!chatHostEnabled(cwd)) return { matched: false };
      const config = enableChatHost(cwd, options);
      const base = createBuiltinLocalAgentHostRuntime(cwd);
      let activeResponse = null;
      return {
        matched: true,
        runtime: {
          ...base,
          hostInstanceId: config.hostInstanceId,
          sessionId: config.sessionId,
          executionId: config.sessionId,
          roleIsolation: {
            freshContext: true,
            async executeRole() {
              if (!activeResponse) throw failure('HOST_CHAT_RESPONSE_REQUIRED', 'cooperative chat response has not been activated');
              return { executionId: activeResponse.executionId, output: clone(activeResponse.output) };
            },
          },
          cooperativeChat: {
            publish(request) { return publishChatHostRequest(cwd, request); },
            readResponse(requestId, expected) { return readChatHostResponse(cwd, requestId, expected); },
            activate(response) { activeResponse = clone(response); },
            clear() { activeResponse = null; },
          },
        },
      };
    },
  };
}

export function registerChatHostProvider(options) {
  return registerAgentHostRuntimeProvider(createChatHostProvider(options));
}
