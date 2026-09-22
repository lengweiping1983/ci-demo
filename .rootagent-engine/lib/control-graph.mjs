import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { atomicWriteFile, atomicWriteJson, durableAppendJsonLine, sha256, withProjectLock } from './trust-core.mjs';
import { isCommandSpec, validateCommandSpec } from './command-execution.mjs';
import { normalizeExecutionRequirements, validateExecutionRequirements } from './agent-host.mjs';

export const WORKFLOW_SCHEMA_VERSION = 1;
export const RUN_SCHEMA_VERSION = 1;
export const NODE_TYPES = Object.freeze(['select', 'agent', 'command', 'checker', 'router', 'approval', 'join', 'integrate', 'stop']);
export const FAILURE_CLASSES = Object.freeze(['TRANSIENT', 'PRODUCT', 'VERIFIER', 'POLICY', 'CONFLICT', 'AMBIGUOUS_CONTRACT', 'INFRASTRUCTURE']);
export const RUN_STATUSES = Object.freeze(['RUNNING', 'WAITING', 'WAITING_RETRY', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED']);

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const EXTERNAL_NODES = new Set(['agent', 'checker', 'approval', 'integrate']);
const EXTERNAL_INTERRUPT_ROLES = new Set(['agent', 'maker', 'checker', 'reviewer', 'planner', 'integrator', 'approval']);
const CONTEXT_PACKET_ROLES = new Set(['maker', 'checker', 'planner', 'integrator', 'reviewer']);
const SUPPORTED_SCHEMA_TYPES = new Set(['any', 'object', 'array', 'string', 'number', 'boolean', 'null']);

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function now() { return new Date().toISOString(); }
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function safeId(value) { return String(value).replace(/[^a-zA-Z0-9._-]/g, '_'); }
function controlRoot(cwd) { return path.join(cwd, '.rootagent', 'runtime', 'control'); }
function workflowsRoot(cwd) { return path.join(cwd, '.rootagent', 'workflows'); }
function runDir(cwd, runId) { return path.join(controlRoot(cwd), 'runs', safeId(runId)); }
function runFiles(cwd, runId) {
  const dir = runDir(cwd, runId);
  return { dir, snapshot: path.join(dir, 'snapshot.json'), events: path.join(dir, 'events.jsonl'), definition: path.join(dir, 'definition.json'), checkpoints: path.join(dir, 'checkpoints') };
}

function err(code, message, nodeId = null, edgeId = null) {
  return { code, message, ...(nodeId ? { nodeId } : {}), ...(edgeId ? { edgeId } : {}) };
}
function schemaType(schema) { return schema?.type || 'any'; }
function schemaCompatible(output, input) {
  const a = schemaType(output); const b = schemaType(input);
  if (a === 'any' || b === 'any') return true;
  if (a !== b) return false;
  if (a === 'object' && Array.isArray(input?.required)) {
    return input.required.every(key => output?.properties?.[key] && schemaCompatible(output.properties[key], input.properties?.[key]));
  }
  if (a === 'array' && output?.items && input?.items) return schemaCompatible(output.items, input.items);
  return true;
}
function validSchema(schema) {
  if (schema == null) return true;
  if (typeof schema !== 'object' || !SUPPORTED_SCHEMA_TYPES.has(schemaType(schema))) return false;
  if (schema.type === 'object') {
    if (schema.required && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string'))) return false;
    if (schema.properties && (typeof schema.properties !== 'object' || Object.values(schema.properties).some(child => !validSchema(child)))) return false;
  }
  return schema.type !== 'array' || !schema.items || validSchema(schema.items);
}
function pathExists(adjacency, from, target, seen = new Set()) {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return (adjacency.get(from) || []).some(next => pathExists(adjacency, next, target, new Set(seen)));
}
function reachableFrom(start, adjacency) {
  const seen = new Set(); const stack = [start];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of adjacency.get(id) || []) stack.push(next);
  }
  return seen;
}
function dominators(start, reachable, predecessors) {
  const all = new Set(reachable);
  const dom = new Map([...reachable].map(id => [id, id === start ? new Set([id]) : new Set(all)]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of reachable) {
      if (id === start) continue;
      const preds = (predecessors.get(id) || []).filter(p => reachable.has(p));
      let intersection = preds.length ? new Set(dom.get(preds[0])) : new Set();
      for (const p of preds.slice(1)) intersection = new Set([...intersection].filter(x => dom.get(p).has(x)));
      intersection.add(id);
      const before = dom.get(id);
      if (before.size !== intersection.size || [...before].some(x => !intersection.has(x))) { dom.set(id, intersection); changed = true; }
    }
  }
  return dom;
}
function validCondition(condition) {
  if (!condition || typeof condition.path !== 'string' || !condition.path) return false;
  return ['equals', 'notEquals', 'in', 'exists'].filter(k => Object.hasOwn(condition, k)).length === 1;
}

export function validateWorkflowDefinition(input) {
  const errors = []; const warnings = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: [err('INVALID_DEFINITION', 'WorkflowDefinition 必须是对象')], warnings };
  const definition = clone(input);
  delete definition.digest;
  if (definition.schemaVersion !== WORKFLOW_SCHEMA_VERSION) errors.push(err('SCHEMA_VERSION', `schemaVersion 必须为 ${WORKFLOW_SCHEMA_VERSION}`));
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(definition.workflowId || '')) errors.push(err('INVALID_WORKFLOW_ID', 'workflowId 只能含字母、数字、点、下划线和连字符'));
  if (!(Number.isInteger(definition.version) && definition.version > 0)) errors.push(err('INVALID_VERSION', 'version 必须是正整数'));
  if (!Array.isArray(definition.nodes) || !definition.nodes.length) errors.push(err('NO_NODES', 'nodes 不能为空'));
  if (!Array.isArray(definition.edges)) errors.push(err('INVALID_EDGES', 'edges 必须是数组'));
  if (errors.length) return { ok: false, errors, warnings };

  const nodes = new Map();
  for (const node of definition.nodes) {
    if (!node?.id || typeof node.id !== 'string') { errors.push(err('INVALID_NODE', '节点必须有字符串 id')); continue; }
    if (nodes.has(node.id)) errors.push(err('DUPLICATE_NODE', `节点 id 重复：${node.id}`, node.id));
    nodes.set(node.id, node);
    if (!NODE_TYPES.includes(node.type)) errors.push(err('INVALID_NODE_TYPE', `未知节点类型：${node.type}`, node.id));
    if (EXTERNAL_NODES.has(node.type)) {
      const role = node.config?.role;
      const contextRole = node.config?.contextRole;
      const allowedActions = node.config?.allowedActions;
      const requiresFreshContext = node.config?.requiresFreshContext;
      if (role != null && (typeof role !== 'string' || !EXTERNAL_INTERRUPT_ROLES.has(role))) errors.push(err('INVALID_EXTERNAL_ROLE', `外部节点 role 不受支持：${role}`, node.id));
      if (contextRole != null && (typeof contextRole !== 'string' || !CONTEXT_PACKET_ROLES.has(contextRole))) errors.push(err('INVALID_CONTEXT_ROLE', `ContextPacket role 不受支持：${contextRole}`, node.id));
      if (allowedActions != null && (!Array.isArray(allowedActions) || allowedActions.some(action => typeof action !== 'string' || !action))) errors.push(err('INVALID_ALLOWED_ACTIONS', 'allowedActions 必须是非空字符串数组', node.id));
      if (requiresFreshContext != null && typeof requiresFreshContext !== 'boolean') errors.push(err('INVALID_CONTEXT_POLICY', 'requiresFreshContext 必须是 boolean', node.id));
      const requirementCheck = validateExecutionRequirements(node.config?.executionRequirements || {});
      if (!requirementCheck.ok) {
        for (const problem of requirementCheck.errors) errors.push(err(problem.code, 'executionRequirements 非法：' + problem.field, node.id));
      }
    }
    if (!validSchema(node.inputSchema) || !validSchema(node.outputSchema)) errors.push(err('INVALID_SCHEMA', 'inputSchema/outputSchema 的 type 不受支持', node.id));
    if (node.failureClass && !FAILURE_CLASSES.includes(node.failureClass)) errors.push(err('INVALID_FAILURE_CLASS', `未知失败分类：${node.failureClass}`, node.id));
    if (node.type === 'command') {
      if (!node.config?.command || (typeof node.config.command !== 'string' && !isCommandSpec(node.config.command))) errors.push(err('INVALID_COMMAND', 'command 节点必须声明字符串或 CommandSpec config.command', node.id));
      if (isCommandSpec(node.config?.command)) {
        const checked = validateCommandSpec(node.config.command);
        if (!checked.ok) errors.push(err('INVALID_COMMAND', checked.errors.join('；'), node.id));
      }
      if (!['pure', 'side-effect'].includes(node.config?.effect)) errors.push(err('INVALID_EFFECT', 'command 节点必须显式声明 config.effect=pure|side-effect', node.id));
    }
    const sideEffect = node.type === 'command' && node.config?.effect === 'side-effect';
    if (sideEffect && !node.idempotencyKey && !node.compensation?.command) errors.push(err('UNSAFE_SIDE_EFFECT', '副作用节点必须声明 idempotencyKey 或 compensation.command', node.id));
    if (node.idempotencyKey && (!String(node.idempotencyKey).includes('${runId}') || !String(node.idempotencyKey).includes('${nodeId}'))) errors.push(err('INVALID_IDEMPOTENCY_KEY', 'idempotencyKey 必须至少包含 ${runId} 与 ${nodeId}', node.id));
    if (node.retry) {
      const r = node.retry;
      if (!Number.isInteger(r.maxAttempts) || r.maxAttempts < 1 || Number(r.initialDelayMs ?? 1000) < 0 || Number(r.coefficient ?? 2) < 1 || Number(r.maxDelayMs ?? 100000) < 0) {
        errors.push(err('INVALID_RETRY', 'retry 参数非法', node.id));
      }
    }
  }
  if (!nodes.has(definition.start)) errors.push(err('INVALID_START', `start 节点不存在：${definition.start || '(空)'}`));

  const edges = []; const edgeIds = new Set();
  const adjacency = new Map([...nodes.keys()].map(id => [id, []]));
  const predecessors = new Map([...nodes.keys()].map(id => [id, []]));
  for (let i = 0; i < definition.edges.length; i++) {
    const edge = definition.edges[i]; const edgeId = edge.id || `e${String(i + 1).padStart(3, '0')}`;
    if (edgeIds.has(edgeId)) errors.push(err('DUPLICATE_EDGE', `边 id 重复：${edgeId}`, null, edgeId));
    edgeIds.add(edgeId);
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) { errors.push(err('INVALID_EDGE', `边端点不存在：${edge.from} -> ${edge.to}`, null, edgeId)); continue; }
    const normalized = { ...edge, id: edgeId }; edges.push(normalized);
    adjacency.get(edge.from).push(edge.to); predecessors.get(edge.to).push(edge.from);
    if (!schemaCompatible(nodes.get(edge.from).outputSchema, nodes.get(edge.to).inputSchema)) errors.push(err('SCHEMA_MISMATCH', `${edge.from} 输出与 ${edge.to} 输入不兼容`, edge.to, edgeId));
  }
  definition.edges = edges;
  if (!nodes.has(definition.start)) return { ok: false, errors, warnings };

  const reachable = reachableFrom(definition.start, adjacency);
  for (const id of nodes.keys()) if (!reachable.has(id)) errors.push(err('UNREACHABLE_NODE', `节点不可达：${id}`, id));
  const stops = [...nodes.values()].filter(n => n.type === 'stop' && reachable.has(n.id));
  if (!stops.length) errors.push(err('NO_STOP', '没有可达 stop 节点'));
  const reverse = predecessors;
  const canStop = new Set(); const stack = stops.map(n => n.id);
  while (stack.length) { const id = stack.pop(); if (canStop.has(id)) continue; canStop.add(id); for (const p of reverse.get(id) || []) stack.push(p); }
  for (const id of reachable) if (!canStop.has(id)) errors.push(err('NO_TERMINAL_PATH', `节点不存在通向 stop 的路径：${id}`, id));

  for (const node of nodes.values()) {
    const outgoing = edges.filter(e => e.from === node.id); const incoming = edges.filter(e => e.to === node.id);
    if (node.type === 'stop' && outgoing.length) errors.push(err('STOP_HAS_EDGE', 'stop 节点不能有出边', node.id));
    if (node.type !== 'stop' && !outgoing.length) errors.push(err('DEAD_END', '非 stop 节点不能成为死端', node.id));
    if (node.type === 'router') {
      const defaults = outgoing.filter(e => e.default === true);
      if (defaults.length !== 1 || outgoing.some(e => !e.default && !validCondition(e.when))) errors.push(err('INVALID_ROUTER', 'router 必须有一条 default 边，其余边必须有合法 when', node.id));
    } else if (outgoing.some(e => e.default || e.when)) errors.push(err('CONDITION_ON_NON_ROUTER', '条件边只能从 router 发出', node.id));
    if (node.type === 'join') {
      const waitFor = node.waitFor || incoming.map(e => e.from);
      if (incoming.length < 2 || !Array.isArray(waitFor) || waitFor.length < 2 || waitFor.some(id => !incoming.some(e => e.from === id))) errors.push(err('INVALID_JOIN', 'join 必须等待至少两个直接前驱', node.id));
    }
  }

  for (const edge of edges) {
    if (pathExists(adjacency, edge.to, edge.from) && !(Number.isInteger(edge.maxTraversals) && edge.maxTraversals > 0)) {
      errors.push(err('UNBOUNDED_LOOP', `循环边必须声明正整数 maxTraversals：${edge.from} -> ${edge.to}`, null, edge.id));
    }
  }
  const dom = dominators(definition.start, reachable, predecessors);
  for (const node of nodes.values()) {
    if (!['high', 'critical'].includes(node.risk)) continue;
    const gated = [...(dom.get(node.id) || [])].some(id => id !== node.id && nodes.get(id)?.type === 'approval');
    if (!gated) errors.push(err('MISSING_RISK_GATE', `高风险节点 ${node.id} 的所有路径必须先经过 approval`, node.id));
  }
  const digest = sha256(definition);
  definition.digest = digest;
  return { ok: errors.length === 0, errors, warnings, digest, definition };
}

function readJsonInput(cwd, value) {
  if (value == null || value === '') return {};
  const file = path.resolve(cwd, value);
  const text = fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf-8') : value;
  return JSON.parse(text);
}

export function installWorkflow(cwd, source) {
  const raw = typeof source === 'string' ? readJsonInput(cwd, source) : source;
  const checked = validateWorkflowDefinition(raw);
  if (!checked.ok) return checked;
  const root = path.join(workflowsRoot(cwd), safeId(checked.definition.workflowId));
  const versionFile = path.join(root, `${checked.digest}.json`);
  if (fs.existsSync(root)) {
    for (const file of fs.readdirSync(root).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const previous = JSON.parse(fs.readFileSync(path.join(root, file), 'utf-8'));
      if (previous.version === checked.definition.version && previous.digest !== checked.digest) {
        const error = new Error(`workflow ${checked.definition.workflowId}@${checked.definition.version} 已冻结为 ${previous.digest}`);
        error.code = 'ROOTAGENT_WORKFLOW_VERSION_CONFLICT';
        throw error;
      }
    }
  }
  if (fs.existsSync(versionFile)) {
    const existing = JSON.parse(fs.readFileSync(versionFile, 'utf-8'));
    const verified = validateWorkflowDefinition(existing);
    if (!verified.ok || verified.digest !== checked.digest || existing.digest !== checked.digest) throw new Error(`installed workflow corrupted: ${checked.definition.workflowId}`);
  } else atomicWriteJson(versionFile, checked.definition);
  const latestFile = path.join(root, 'latest.json');
  let latest = null;
  try { latest = JSON.parse(fs.readFileSync(latestFile, 'utf-8')); } catch { /* first install */ }
  if (!latest || checked.definition.version >= latest.version) atomicWriteJson(latestFile, { schemaVersion: 1, workflowId: checked.definition.workflowId, digest: checked.digest, version: checked.definition.version, installedAt: now() });
  return { ...checked, path: path.relative(cwd, versionFile).split(path.sep).join('/') };
}

export function resolveWorkflow(cwd, ref) {
  if (ref && typeof ref === 'object') {
    const root = path.join(workflowsRoot(cwd), safeId(ref.workflowId));
    const file = path.join(root, `${ref.digest}.json`);
    if (!fs.existsSync(file)) throw new Error(`workflow version not found: ${ref.workflowId}@${ref.digest}`);
    const definition = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const checked = validateWorkflowDefinition(definition);
    if (!checked.ok || checked.digest !== ref.digest) throw new Error(`installed workflow corrupted: ${ref.workflowId}@${ref.digest}`);
    return checked.definition;
  }
  const possible = path.resolve(cwd, String(ref || ''));
  if (ref && fs.existsSync(possible) && fs.statSync(possible).isFile()) {
    const checked = validateWorkflowDefinition(JSON.parse(fs.readFileSync(possible, 'utf-8')));
    if (!checked.ok) { const e = new Error('workflow validation failed'); e.validation = checked; throw e; }
    return checked.definition;
  }
  const root = path.join(workflowsRoot(cwd), safeId(ref));
  const latestFile = path.join(root, 'latest.json');
  if (!fs.existsSync(latestFile)) throw new Error(`workflow not found: ${ref}`);
  const latest = JSON.parse(fs.readFileSync(latestFile, 'utf-8'));
  const definition = JSON.parse(fs.readFileSync(path.join(root, `${latest.digest}.json`), 'utf-8'));
  const checked = validateWorkflowDefinition(definition);
  if (!checked.ok || checked.digest !== latest.digest) throw new Error(`installed workflow corrupted: ${ref}`);
  return checked.definition;
}

function snapshotDigest(run) { const copy = clone(run); copy.historyDigest = ''; return sha256(copy); }
function eventCore(event) { const { digest, snapshot, ...core } = event; return core; }
function appendRunEvent(cwd, run, type, payload = {}, checkpoint = false) {
  const files = runFiles(cwd, run.runId); fs.mkdirSync(files.checkpoints, { recursive: true });
  run.revision += 1; run.updatedAt = now(); run.lastEventSeq = run.revision;
  const event = { schemaVersion: 1, eventId: crypto.randomUUID(), runId: run.runId, seq: run.revision, type, at: run.updatedAt, prevDigest: run.historyDigest || '', payload: clone(payload) };
  event.snapshotDigest = snapshotDigest(run);
  event.digest = sha256(eventCore(event));
  run.historyDigest = event.digest;
  event.snapshot = clone(run);
  durableAppendJsonLine(files.events, event);
  if (checkpoint) atomicWriteJson(path.join(files.checkpoints, `${String(event.seq).padStart(8, '0')}-${type}.json`), { schemaVersion: 1, eventId: event.eventId, eventDigest: event.digest, phase: type, run: event.snapshot });
  atomicWriteJson(files.snapshot, run);
  return event;
}

function parseEvents(files) {
  if (!fs.existsSync(files.events)) return { events: [], repairedTail: false };
  const raw = fs.readFileSync(files.events, 'utf-8'); const lines = raw.split('\n'); const valid = []; let repairedTail = false; let prev = '';
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    let event;
    try { event = JSON.parse(lines[i]); }
    catch {
      if (i === lines.length - 1) { repairedTail = true; break; }
      const e = new Error(`run event history corrupted at line ${i + 1}`); e.code = 'ROOTAGENT_RUN_HISTORY_CORRUPT'; throw e;
    }
    if (event.seq !== valid.length + 1 || event.prevDigest !== prev || event.digest !== sha256(eventCore(event)) || event.snapshot?.historyDigest !== event.digest || event.snapshot?.revision !== event.seq || event.snapshot?.runId !== event.runId) {
      const e = new Error(`run event chain invalid at seq ${event.seq}`); e.code = 'ROOTAGENT_RUN_HISTORY_CORRUPT'; throw e;
    }
    if (event.snapshotDigest !== snapshotDigest(event.snapshot)) {
      const e = new Error(`run event snapshot invalid at seq ${event.seq}`); e.code = 'ROOTAGENT_RUN_HISTORY_CORRUPT'; throw e;
    }
    valid.push(event); prev = event.digest;
  }
  if (repairedTail) atomicWriteFile(files.events, valid.map(e => JSON.stringify(e)).join('\n') + (valid.length ? '\n' : ''));
  return { events: valid, repairedTail };
}

export function loadRun(cwd, runId) {
  const files = runFiles(cwd, runId);
  if (!fs.existsSync(files.definition) || !fs.existsSync(files.events)) throw new Error(`run not found: ${runId}`);
  const definition = JSON.parse(fs.readFileSync(files.definition, 'utf-8'));
  const checked = validateWorkflowDefinition(definition);
  if (!checked.ok) throw new Error(`run workflow invalid: ${runId}`);
  const { events, repairedTail } = parseEvents(files);
  if (!events.length) throw new Error(`run has no events: ${runId}`);
  const run = clone(events[events.length - 1].snapshot);
  if (run.workflowDigest !== checked.digest || run.workflowId !== checked.definition.workflowId) throw new Error(`run workflow digest mismatch: ${runId}`);
  let recoveredFromEvents = repairedTail;
  for (const event of events.filter(e => ['STEP_STARTED', 'STEP_COMPLETED', 'STEP_FAILED', 'RUN_INTERRUPTED'].includes(e.type))) {
    const checkpoint = path.join(files.checkpoints, `${String(event.seq).padStart(8, '0')}-${event.type}.json`);
    if (!fs.existsSync(checkpoint)) {
      atomicWriteJson(checkpoint, { schemaVersion: 1, eventId: event.eventId, eventDigest: event.digest, phase: event.type, run: event.snapshot });
      recoveredFromEvents = true;
    }
  }
  try {
    const snapshot = JSON.parse(fs.readFileSync(files.snapshot, 'utf-8'));
    if (snapshot.revision !== run.revision || snapshot.historyDigest !== run.historyDigest || snapshotDigest(snapshot) !== snapshotDigest(run)) recoveredFromEvents = true;
  } catch { recoveredFromEvents = true; }
  if (recoveredFromEvents) atomicWriteJson(files.snapshot, run);
  return { run, definition: checked.definition, events, recoveredFromEvents };
}

export function createRun(cwd, definitionOrRef, input = {}, options = {}) {
  const definition = typeof definitionOrRef === 'string' ? resolveWorkflow(cwd, definitionOrRef) : validateWorkflowDefinition(definitionOrRef).definition;
  if (!definition?.digest) throw new Error('invalid workflow definition');
  const runId = options.runId || `run_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
  const files = runFiles(cwd, runId);
  if (fs.existsSync(files.events)) return { ...loadRun(cwd, runId), duplicate: true };
  fs.mkdirSync(files.dir, { recursive: true }); atomicWriteJson(files.definition, definition);
  const run = {
    schemaVersion: RUN_SCHEMA_VERSION, runId, workflowId: definition.workflowId, workflowVersion: definition.version, workflowDigest: definition.digest,
    status: 'RUNNING', revision: 0, historyDigest: '', lastEventSeq: 0, createdAt: now(), updatedAt: now(),
    input: clone(input || {}), state: { nodes: {}, last: null }, ready: [{ tokenId: crypto.randomUUID(), executionId: crypto.randomUUID(), nodeId: definition.start, from: null, retryAttempt: 0 }],
    activeStep: null, pendingInterrupt: null, resumeValues: {}, completedNodes: {}, nodeAttempts: {}, edgeTraversals: {}, joinArrivals: {}, joinReleased: {},
    lastFailure: null, nextRetryAt: null,
  };
  appendRunEvent(cwd, run, 'RUN_CREATED', { workflowDigest: definition.digest, input: run.input }, true);
  return { run, definition, events: [], recoveredFromEvents: false, duplicate: false };
}

function getPath(root, dotted) {
  return String(dotted || '').split('.').filter(Boolean).reduce((value, key) => value == null ? undefined : value[key], root);
}
function conditionMatches(condition, context) {
  const value = getPath(context, condition.path);
  if (Object.hasOwn(condition, 'equals')) return value === condition.equals;
  if (Object.hasOwn(condition, 'notEquals')) return value !== condition.notEquals;
  if (Object.hasOwn(condition, 'exists')) return condition.exists ? value !== undefined : value === undefined;
  if (Object.hasOwn(condition, 'in')) return Array.isArray(condition.in) && condition.in.includes(value);
  return false;
}
function runtimeType(value) { if (value === null) return 'null'; if (Array.isArray(value)) return 'array'; return typeof value; }
function matchesSchema(value, schema) {
  const type = schemaType(schema);
  if (type === 'any') return true;
  if (runtimeType(value) !== type) return false;
  if (type === 'object') {
    if ((schema.required || []).some(key => !Object.hasOwn(value, key))) return false;
    return Object.entries(schema.properties || {}).every(([key, child]) => !Object.hasOwn(value, key) || matchesSchema(value[key], child));
  }
  if (type === 'array' && schema.items) return value.every(item => matchesSchema(item, schema.items));
  return true;
}
function renderTemplate(text, context) {
  return String(text).replace(/\$\{([^}]+)\}/g, (_, key) => String(getPath(context, key.trim()) ?? ''));
}
function retryPolicy(node) { return { maxAttempts: 3, initialDelayMs: 1000, coefficient: 2, maxDelayMs: 100000, ...(node.retry || {}) }; }
function nodeIsSideEffect(node) { return node.type === 'command' && node.config?.effect === 'side-effect'; }
function makeInterrupt(run, node, active, kind, payload) {
  return { interruptId: crypto.randomUUID(), kind, runId: run.runId, nodeId: node.id, executionKey: active.executionKey, payload: clone(payload || {}), createdAt: now() };
}
function enqueue(run, definition, edge, token) {
  const count = (run.edgeTraversals[edge.id] || 0) + 1;
  if (edge.maxTraversals && count > edge.maxTraversals) return { error: { class: 'PRODUCT', message: `edge ${edge.id} exceeded maxTraversals=${edge.maxTraversals}` } };
  run.edgeTraversals[edge.id] = count;
  const target = definition.nodes.find(n => n.id === edge.to);
  if (target.type === 'join') {
    run.joinArrivals[target.id] ||= {};
    run.joinArrivals[target.id][edge.from] = true;
    const incoming = definition.edges.filter(e => e.to === target.id).map(e => e.from);
    const waitFor = target.waitFor || incoming;
    if (!run.joinReleased[target.id] && waitFor.every(id => run.joinArrivals[target.id][id])) {
      run.joinReleased[target.id] = true;
      run.ready.push({ tokenId: crypto.randomUUID(), executionId: crypto.randomUUID(), nodeId: target.id, from: edge.from, retryAttempt: 0 });
    }
  } else run.ready.push({ tokenId: crypto.randomUUID(), executionId: crypto.randomUUID(), nodeId: edge.to, from: edge.from, parentTokenId: token.tokenId, retryAttempt: 0 });
  return { ok: true };
}
function route(run, definition, node, token, output) {
  let edges = definition.edges.filter(e => e.from === node.id);
  if (node.type === 'router') {
    const context = { input: run.input, state: run.state, nodes: run.state.nodes, output };
    edges = [edges.find(e => !e.default && conditionMatches(e.when, context)) || edges.find(e => e.default)];
  }
  for (const edge of edges.filter(Boolean)) {
    const queued = enqueue(run, definition, edge, token);
    if (queued.error) return queued;
  }
  return { ok: true };
}

function recordFailure(cwd, run, node, active, failure) {
  const normalized = { class: FAILURE_CLASSES.includes(failure.class) ? failure.class : 'INFRASTRUCTURE', message: failure.message || '节点失败', nodeId: node.id, attempt: active.attempt, at: now(), exitCode: failure.exitCode ?? null };
  run.lastFailure = normalized; run.activeStep = null;
  if (normalized.class === 'TRANSIENT' && active.attempt < retryPolicy(node).maxAttempts) {
    const p = retryPolicy(node); const delay = Math.min(p.maxDelayMs, Math.round(p.initialDelayMs * (p.coefficient ** (active.attempt - 1))));
    run.status = 'WAITING_RETRY'; run.nextRetryAt = new Date(Date.now() + delay).toISOString();
    active.token.retryAttempt = active.attempt;
    run.ready.unshift(active.token);
    appendRunEvent(cwd, run, 'STEP_RETRY_SCHEDULED', { failure: normalized, delayMs: delay, nextRetryAt: run.nextRetryAt }, true);
    return { run, status: run.status, failure: normalized };
  }
  run.status = 'FAILED'; run.nextRetryAt = null;
  appendRunEvent(cwd, run, 'STEP_FAILED', { failure: normalized }, true);
  return { run, status: run.status, failure: normalized };
}

function completeStep(cwd, run, definition, node, active, output) {
  if (!matchesSchema(output, node.outputSchema)) return recordFailure(cwd, run, node, active, { class: 'PRODUCT', message: `node ${node.id} output type ${runtimeType(output)} does not match ${schemaType(node.outputSchema)}` });
  run.state.nodes[node.id] = clone(output); run.state.last = clone(output);
  run.completedNodes[node.id] = { count: (run.completedNodes[node.id]?.count || 0) + 1, output: clone(output), completedAt: now() };
  const routed = route(run, definition, node, active.token, output);
  if (routed.error) return recordFailure(cwd, run, node, active, routed.error);
  run.activeStep = null; run.pendingInterrupt = null; run.nextRetryAt = null;
  if (!run.ready.length) run.status = 'COMPLETED'; else run.status = 'RUNNING';
  appendRunEvent(cwd, run, 'STEP_COMPLETED', { nodeId: node.id, executionKey: active.executionKey, output, next: run.ready.map(t => t.nodeId) }, true);
  if (run.status === 'COMPLETED') appendRunEvent(cwd, run, 'RUN_COMPLETED', { output: run.state.last }, true);
  return { run, status: run.status, output };
}

function defaultExternalRole(node) {
  if (node.type === 'checker') return 'checker';
  if (node.type === 'integrate') return 'integrator';
  if (node.type === 'approval') return 'approval';
  return 'agent';
}
function externalInterruptPayload(run, definition, node) {
  const role = node.config?.role || defaultExternalRole(node);
  const explicitContextRole = node.config?.contextRole || null;
  const contextRole = explicitContextRole || (CONTEXT_PACKET_ROLES.has(role) ? role : null);
  return {
    prompt: node.config?.prompt || `Provide ${node.type} result`,
    input: clone(run.state.last),
    role,
    contextRole,
    taskId: run.input?.taskId || null,
    workflowId: run.workflowId || definition.workflowId,
    workflowDigest: run.workflowDigest || definition.digest,
    resultSchema: clone(node.outputSchema || { type: 'any' }),
    requiresFreshContext: contextRole ? node.config?.requiresFreshContext !== false : false,
    executionRequirements: normalizeExecutionRequirements(node.config?.executionRequirements || {
      freshContext: contextRole ? node.config?.requiresFreshContext !== false : false,
    }),
    allowedActions: Array.isArray(node.config?.allowedActions) ? clone(node.config.allowedActions) : [],
    nodeType: node.type,
    hostContractVersion: 1,
  };
}
function externalNode(cwd, run, definition, node, active) {
  const resume = run.resumeValues[active.executionKey];
  if (resume === undefined) {
    const kind = node.type === 'approval' ? 'APPROVAL' : node.type === 'checker' ? 'CHECKER' : node.type === 'integrate' ? 'INTEGRATION' : 'AGENT';
    run.pendingInterrupt = makeInterrupt(run, node, active, kind, externalInterruptPayload(run, definition, node));
    active.phase = 'INTERRUPTED'; run.status = 'WAITING';
    appendRunEvent(cwd, run, 'RUN_INTERRUPTED', { interrupt: run.pendingInterrupt }, true);
    return { run, status: run.status, interrupt: run.pendingInterrupt };
  }
  delete run.resumeValues[active.executionKey];
  if (node.type === 'approval' && resume?.approved !== true && !node.config?.allowReject) return recordFailure(cwd, run, node, active, { class: 'POLICY', message: 'approval rejected' });
  if (node.type === 'checker' && node.config?.requirePass !== false && resume?.verdict !== 'PASS') return recordFailure(cwd, run, node, active, { class: 'VERIFIER', message: `checker verdict=${resume?.verdict || 'missing'}` });
  if (node.type === 'integrate' && resume?.integrated !== true) return recordFailure(cwd, run, node, active, { class: 'CONFLICT', message: 'integration not confirmed' });
  return completeStep(cwd, run, definition, node, active, resume);
}

export function stepRun(cwd, runId, options = {}) {
  const loaded = loadRun(cwd, runId); const { run, definition } = loaded;
  const recoveredActiveExecution = !!run.activeStep && run.activeStep.phase === 'EXECUTING';
  if (TERMINAL.has(run.status) || run.status === 'PAUSED' || run.status === 'WAITING') return { ...loaded, status: run.status, interrupt: run.pendingInterrupt, failure: run.lastFailure };
  if (run.status === 'WAITING_RETRY') {
    if (Date.now() < new Date(run.nextRetryAt).getTime()) return { ...loaded, status: run.status, retryAt: run.nextRetryAt, failure: run.lastFailure };
    run.status = 'RUNNING'; run.nextRetryAt = null; appendRunEvent(cwd, run, 'RETRY_READY', {}, true);
  }
  let completed = 0;
  while (run.status === 'RUNNING') {
    let active = run.activeStep;
    let node; let token;
    if (!active) {
      token = run.ready.shift();
      if (!token) { run.status = 'COMPLETED'; appendRunEvent(cwd, run, 'RUN_COMPLETED', { output: run.state.last }, true); break; }
      node = definition.nodes.find(n => n.id === token.nodeId);
      const attempt = (token.retryAttempt || 0) + 1; run.nodeAttempts[node.id] = (run.nodeAttempts[node.id] || 0) + 1;
      const executionId = token.executionId || crypto.randomUUID(); token.executionId = executionId;
      active = run.activeStep = { nodeId: node.id, token: clone(token), attempt, executionId, executionKey: `${node.id}:${executionId}`, phase: 'EXECUTING', startedAt: now(), idempotencyKey: node.idempotencyKey ? renderTemplate(node.idempotencyKey, { runId: run.runId, nodeId: node.id, executionId, attempt }) : null };
      if (options.deferCommand && node.type === 'command') {
        active.fencingToken = crypto.randomUUID();
        active.executor = { pid: process.pid, host: os.hostname(), startedAt: now() };
      }
      appendRunEvent(cwd, run, 'STEP_STARTED', { nodeId: node.id, attempt, executionKey: active.executionKey, idempotencyKey: active.idempotencyKey, fencingToken: active.fencingToken || null }, true);
      if (options.crashPoint === `after_start:${node.id}`) process.exit(86);
    } else { node = definition.nodes.find(n => n.id === active.nodeId); token = active.token; }

    if (active.phase === 'INTERRUPTED' && run.pendingInterrupt) return { run, definition, status: 'WAITING', interrupt: run.pendingInterrupt, recoveredFromEvents: loaded.recoveredFromEvents };
    if (EXTERNAL_NODES.has(node.type)) {
      const result = externalNode(cwd, run, definition, node, active);
      if (result.status !== 'RUNNING') return { ...result, recoveredFromEvents: loaded.recoveredFromEvents };
      completed++;
    } else if (nodeIsSideEffect(node) && !active.idempotencyKey && active.phase === 'EXECUTING' && recoveredActiveExecution) {
      const resume = run.resumeValues[active.executionKey];
      if (resume === undefined) {
        run.pendingInterrupt = makeInterrupt(run, node, active, 'AMBIGUOUS_SIDE_EFFECT', { message: '副作用可能已发生；选择 compensate/retry/complete/cancel', compensation: node.compensation || null });
        active.phase = 'INTERRUPTED'; run.status = 'WAITING'; appendRunEvent(cwd, run, 'RUN_INTERRUPTED', { interrupt: run.pendingInterrupt }, true);
        return { run, definition, status: run.status, interrupt: run.pendingInterrupt, recoveredFromEvents: true };
      }
    } else {
      let output;
      if (node.type === 'select') output = node.config?.path ? getPath({ input: run.input, state: run.state }, node.config.path) : (node.config?.value ?? run.input);
      else if (node.type === 'router') output = run.state.last ?? {};
      else if (node.type === 'join') output = { joined: node.waitFor || definition.edges.filter(e => e.to === node.id).map(e => e.from) };
      else if (node.type === 'stop') output = run.state.last ?? {};
      else if (node.type === 'command') {
        if (typeof options.executeCommand !== 'function' && !options.deferCommand) return recordFailure(cwd, run, node, active, { class: 'INFRASTRUCTURE', message: 'command executor unavailable' });
        const resume = run.resumeValues[active.executionKey];
        // INTERRUPTED 恢复路径：cancel / complete / compensate / retry — 必须完整走完，不得被 deferCommand 截断
        if (active.phase === 'INTERRUPTED' && resume?.action === 'cancel') { run.status = 'CANCELLED'; run.pendingInterrupt = null; appendRunEvent(cwd, run, 'RUN_CANCELLED', { reason: 'ambiguous side effect cancelled' }, true); return { run, definition, status: run.status }; }
        if (active.phase === 'INTERRUPTED' && resume?.action === 'complete') { delete run.resumeValues[active.executionKey]; return completeStep(cwd, run, definition, node, active, resume.result || { acknowledged: true }); }
        if (active.phase === 'INTERRUPTED' && resume?.action === 'compensate') {
          delete run.resumeValues[active.executionKey];
          if (typeof options.executeCommand !== 'function') return recordFailure(cwd, run, node, active, { class: 'INFRASTRUCTURE', message: 'command executor unavailable for compensation' });
          const compensation = options.executeCommand(node.compensation.command, { run, node, idempotencyKey: `compensate:${run.runId}:${node.id}:${active.attempt}`, compensation: true });
          if (!compensation.ok) return recordFailure(cwd, run, node, active, { class: 'INFRASTRUCTURE', message: `compensation failed: ${compensation.out}`, exitCode: compensation.code });
          appendRunEvent(cwd, run, 'COMPENSATION_COMPLETED', { nodeId: node.id, executionKey: active.executionKey }, true);
          active.phase = 'EXECUTING'; run.pendingInterrupt = null;
        } else if (active.phase === 'INTERRUPTED' && resume?.action === 'retry') { delete run.resumeValues[active.executionKey]; active.phase = 'EXECUTING'; run.pendingInterrupt = null; }
        // 只有新鲜的 EXECUTING 命令节点（非 INTERRUPTED 恢复）才可 defer
        if (options.deferCommand && active.phase === 'EXECUTING') {
          return { run, definition, status: run.status, execution: { runId: run.runId, node: clone(node), active: clone(active), command: clone(node.config.command), context: { run: clone(run), node: clone(node), idempotencyKey: active.idempotencyKey, compensation: false } }, recoveredFromEvents: loaded.recoveredFromEvents };
        }
        if (typeof options.executeCommand !== 'function') return recordFailure(cwd, run, node, active, { class: 'INFRASTRUCTURE', message: 'command executor unavailable' });
        const command = options.executeCommand(node.config.command, { run, node, idempotencyKey: active.idempotencyKey, compensation: false });
        if (options.crashPoint === `after_execute:${node.id}`) process.exit(86);
        if (!command.ok) return recordFailure(cwd, run, node, active, { class: command.failureClass || node.failureClass || 'PRODUCT', message: command.out || `command exit ${command.code}`, exitCode: command.code });
        output = { exitCode: command.code, stdout: command.out || '' };
      }
      const result = completeStep(cwd, run, definition, node, active, output);
      if (result.status !== 'RUNNING') return { ...result, recoveredFromEvents: loaded.recoveredFromEvents };
      completed++;
    }
    if (options.once && completed >= 1) return { run, definition, status: run.status, recoveredFromEvents: loaded.recoveredFromEvents };
  }
  return { run, definition, status: run.status, recoveredFromEvents: loaded.recoveredFromEvents };
}

export function beginRunStep(cwd, runId, options = {}) {
  // 持短锁推进状态机直到遇到需要在锁外执行的命令节点（execution）或到达非 RUNNING 终态。
  // INTERRUPTED 恢复（compensate/cancel/complete/retry）在锁内完整执行，
  // 因为它们本身是短事务；只有新鲜的主命令执行才 defer 到锁外。
  return withProjectLock(cwd, () => stepRun(cwd, runId, { ...options, deferCommand: true }));
}

export function commitRunExecution(cwd, runId, execution, command) {
  return withProjectLock(cwd, () => {
    const loaded = loadRun(cwd, runId); const { run, definition } = loaded;
    const active = run.activeStep;
    if (!active || active.executionKey !== execution.active.executionKey || active.fencingToken !== execution.active.fencingToken) {
      return { ...loaded, status: run.status, stale: true };
    }
    if (run.status === 'CANCELLED' || run.status === 'PAUSED') return { ...loaded, status: run.status, stale: true };
    const node = definition.nodes.find(item => item.id === active.nodeId);
    if (!command.ok) return { ...recordFailure(cwd, run, node, active, { class: command.failureClass || node.failureClass || 'PRODUCT', message: command.out || `command exit ${command.code}`, exitCode: command.code }), recoveredFromEvents: loaded.recoveredFromEvents };
    return { ...completeStep(cwd, run, definition, node, active, { exitCode: command.code, stdout: command.out || '' }), recoveredFromEvents: loaded.recoveredFromEvents };
  });
}

export function executeRunStep(cwd, runId, options = {}) {
  let completed = 0;
  while (true) {
    // beginRunStep 在锁内推进：非命令节点直接完成；INTERRUPTED 恢复（补偿/取消/完成/重试）
    // 也在锁内完成（短事务）；只有新鲜主命令执行返回 execution 供锁外运行。
    const prepared = beginRunStep(cwd, runId, { once: options.once && completed > 0, crashPoint: options.crashPoint, executeCommand: options.executeCommand });
    if (!prepared.execution) return prepared;
    if (typeof options.executeCommand !== 'function') {
      return commitRunExecution(cwd, runId, prepared.execution, { ok: false, code: null, out: 'command executor unavailable', failureClass: 'INFRASTRUCTURE' });
    }
    // 主命令在锁外执行，不阻塞 inspect/pause/cancel
    const command = options.executeCommand(prepared.execution.command, prepared.execution.context);
    if (options.crashPoint === `after_execute:${prepared.execution.node.id}`) process.exit(86);
    // 短锁提交，校验 fencingToken 防止陈旧写入
    const committed = commitRunExecution(cwd, runId, prepared.execution, command);
    if (committed.stale || committed.status !== 'RUNNING') return committed;
    completed++;
    if (options.once && completed >= 1) return committed;
  }
}

export function pauseRun(cwd, runId) {
  return withProjectLock(cwd, () => {
    const loaded = loadRun(cwd, runId); const { run } = loaded;
    if (run.status !== 'RUNNING' && run.status !== 'WAITING_RETRY') throw new Error(`cannot pause run in ${run.status}`);
    run.pausedFrom = run.status; run.status = 'PAUSED'; appendRunEvent(cwd, run, 'RUN_PAUSED', { from: run.pausedFrom }, true); return run;
  });
}
export function resumeRun(cwd, runId, value) {
  return withProjectLock(cwd, () => {
    const loaded = loadRun(cwd, runId); const { run } = loaded;
    if (run.status === 'WAITING') {
      if (!run.pendingInterrupt) throw new Error('waiting run has no interrupt');
      if (value === undefined) throw new Error('resume value required');
      run.resumeValues[run.pendingInterrupt.executionKey] = clone(value); const interruptId = run.pendingInterrupt.interruptId;
      run.pendingInterrupt = null; if (run.activeStep) run.activeStep.phase = 'INTERRUPTED'; run.status = 'RUNNING';
      appendRunEvent(cwd, run, 'RUN_RESUMED', { interruptId, value }, true); return run;
    }
    if (run.status === 'PAUSED') { run.status = run.pausedFrom || 'RUNNING'; delete run.pausedFrom; appendRunEvent(cwd, run, 'RUN_RESUMED', { value: null }, true); return run; }
    throw new Error(`cannot resume run in ${run.status}`);
  });
}
export function cancelRun(cwd, runId, reason = '') {
  return withProjectLock(cwd, () => {
    const loaded = loadRun(cwd, runId); const { run } = loaded;
    if (TERMINAL.has(run.status)) throw new Error(`cannot cancel run in ${run.status}`);
    run.status = 'CANCELLED'; run.cancelReason = reason; run.pendingInterrupt = null; appendRunEvent(cwd, run, 'RUN_CANCELLED', { reason }, true); return run;
  });
}
export function inspectRun(cwd, runId) { return loadRun(cwd, runId); }

export function emitTrigger(cwd, workflowRef, fireKey, payload = {}) {
  if (!fireKey) throw new Error('fire key required');
  const definition = resolveWorkflow(cwd, workflowRef); const root = path.join(controlRoot(cwd), 'triggers'); const dedupeDir = path.join(root, 'dedupe');
  fs.mkdirSync(dedupeDir, { recursive: true });
  const keyDigest = sha256({ workflowDigest: definition.digest, fireKey }); const dedupeFile = path.join(dedupeDir, `${keyDigest}.json`);
  const runId = `run_trigger_${keyDigest.slice(0, 24)}`;
  if (fs.existsSync(dedupeFile)) { const previous = JSON.parse(fs.readFileSync(dedupeFile, 'utf-8')); return { ...previous, duplicate: true }; }
  const prior = listTriggerEvents(cwd).find(event => event.fireKeyDigest === keyDigest);
  if (prior) {
    const recovered = { schemaVersion: 1, workflowId: prior.workflowId, workflowDigest: prior.workflowDigest, fireKey: prior.fireKey, fireKeyDigest: keyDigest, runId: prior.runId, eventId: prior.eventId, createdAt: prior.at };
    atomicWriteJson(dedupeFile, recovered);
    return { ...recovered, duplicate: true, recoveredDedupe: true };
  }
  createRun(cwd, definition, payload, { runId });
  const event = { schemaVersion: 1, eventId: crypto.randomUUID(), type: 'TRIGGER_RECEIVED', at: now(), workflowId: definition.workflowId, workflowDigest: definition.digest, fireKey, fireKeyDigest: keyDigest, runId, payload: clone(payload) };
  durableAppendJsonLine(path.join(root, 'events.jsonl'), event);
  const record = { schemaVersion: 1, workflowId: definition.workflowId, workflowDigest: definition.digest, fireKey, fireKeyDigest: keyDigest, runId, eventId: event.eventId, createdAt: event.at };
  atomicWriteJson(dedupeFile, record); return { ...record, duplicate: false };
}

export function listTriggerEvents(cwd) {
  const file = path.join(controlRoot(cwd), 'triggers', 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf-8'); const lines = raw.split('\n'); const events = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    try { events.push(JSON.parse(lines[i])); }
    catch {
      const later = lines.slice(i + 1).some(Boolean);
      if (later) { const error = new Error(`trigger event history corrupted at line ${i + 1}`); error.code = 'ROOTAGENT_TRIGGER_HISTORY_CORRUPT'; throw error; }
      atomicWriteFile(file, events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''));
      break;
    }
  }
  return events;
}

export function auditControlStore(cwd) {
  const problems = []; const healthy = []; const root = controlRoot(cwd);
  const workflowRoot = workflowsRoot(cwd);
  if (fs.existsSync(workflowRoot)) {
    for (const name of fs.readdirSync(workflowRoot)) {
      try {
        const dir = path.join(workflowRoot, name);
        if (!fs.statSync(dir).isDirectory()) { problems.push(`workflow store 非目录条目：${name}`); continue; }
        for (const file of fs.readdirSync(dir).filter(item => /^[a-f0-9]{64}\.json$/.test(item))) {
          const definition = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
          const checked = validateWorkflowDefinition(definition);
          if (!checked.ok || checked.digest !== file.slice(0, -5) || definition.digest !== checked.digest) problems.push(`workflow ${name}/${file}: digest 或定义无效`);
        }
        const definition = resolveWorkflow(cwd, name); healthy.push(`workflow ${definition.workflowId}@${definition.version} digest 有效`);
      }
      catch (error) { problems.push(`workflow ${name}: ${error.message}`); }
    }
  }
  const runsRoot = path.join(root, 'runs');
  if (fs.existsSync(runsRoot)) {
    for (const runId of fs.readdirSync(runsRoot)) {
      try {
        const loaded = loadRun(cwd, runId); const files = runFiles(cwd, runId);
        for (const event of loaded.events.filter(e => ['STEP_STARTED', 'STEP_COMPLETED', 'STEP_FAILED', 'RUN_INTERRUPTED'].includes(e.type))) {
          const checkpoint = path.join(files.checkpoints, `${String(event.seq).padStart(8, '0')}-${event.type}.json`);
          if (!fs.existsSync(checkpoint)) problems.push(`run ${runId}: checkpoint 缺失 seq=${event.seq} ${event.type}`);
          else {
            const record = JSON.parse(fs.readFileSync(checkpoint, 'utf-8'));
            if (record.eventDigest !== event.digest || record.eventId !== event.eventId || snapshotDigest(record.run) !== event.snapshotDigest) problems.push(`run ${runId}: checkpoint digest 不匹配 seq=${event.seq}`);
          }
        }
        healthy.push(`run ${runId} 事件链有效（${loaded.events.length} events）`);
      } catch (error) { problems.push(`run ${runId}: ${error.message}`); }
    }
  }
  return { problems, healthy };
}

export function parseJsonArgument(cwd, value) { return readJsonInput(cwd, value); }
