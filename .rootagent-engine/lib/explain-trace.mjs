import fs from 'fs';
import path from 'path';
import { inspectRun } from './control-graph.mjs';
import { listIntegrationQueue, loadCandidate } from './project-orchestration.mjs';
import { readJson, sha256, taskContractDigest } from './trust-core.mjs';

export const TRACE_SCHEMA_VERSION = 1;
export const SPAN_STATUSES = Object.freeze(['OK', 'ERROR', 'UNSET']);

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const safeText = (value, max = 300) => String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, max);
const atMs = value => value ? new Date(value).getTime() : NaN;
const duration = (start, end) => Number.isFinite(atMs(start)) && Number.isFinite(atMs(end)) ? Math.max(0, atMs(end) - atMs(start)) : null;
const traceIdFor = (cwd, kind, id) => sha256(`rootagent:${fs.realpathSync(cwd)}:${kind}:${id}`).slice(0, 32);
const spanIdFor = (traceId, key) => sha256(`${traceId}:${key}`).slice(0, 16);
const rootStatus = status => ['COMPLETED', 'completed', 'INTEGRATED'].includes(status) ? 'OK' : ['FAILED', 'blocked', 'VALIDATION_FAILED', 'CONFLICT', 'CANCELLED'].includes(status) ? 'ERROR' : 'UNSET';

function sealTrace(trace) { const unsigned = clone(trace); delete unsigned.digest; trace.digest = sha256(unsigned); return trace; }
export function createTraceContext(cwd, kind, id, spanKey = 'root', sampled = true) {
  const traceId = traceIdFor(cwd, kind, id); const spanId = spanIdFor(traceId, spanKey);
  return { traceId, spanId, traceparent: `00-${traceId}-${spanId}-${sampled ? '01' : '00'}` };
}
function makeSpan(traceId, key, parentSpanId, name, kind, startTime, endTime, status = 'UNSET', attributes = {}, events = [], links = []) {
  return { spanId: spanIdFor(traceId, key), traceId, parentSpanId, name, kind, startTime: startTime || null, endTime: endTime || null, durationMs: duration(startTime, endTime), status: { code: status }, attributes, events, links };
}
function findNotTested(value, pathName = 'state', out = []) {
  if (!value || typeof value !== 'object') return out;
  if (value.verdict === 'NOT_TESTED') out.push({ path: pathName, index: value.index ?? null, criterion: safeText(value.criterion || value.name || ''), limitations: Array.isArray(value.limitations) ? value.limitations.map(item => safeText(item)) : [] });
  if (Array.isArray(value)) value.forEach((item, index) => findNotTested(item, `${pathName}[${index}]`, out));
  else for (const [key, child] of Object.entries(value)) findNotTested(child, `${pathName}.${key}`, out);
  return out;
}
function collectUsage(value, totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, reported: false }) {
  if (!value || typeof value !== 'object') return totals;
  for (const [key, child] of Object.entries(value)) {
    if (['inputTokens', 'outputTokens', 'totalTokens', 'costUsd'].includes(key) && typeof child === 'number' && Number.isFinite(child)) { totals[key] += child; totals.reported = true; }
    else if (typeof child === 'object') collectUsage(child, totals);
  }
  return totals;
}
function actorsFromEvents(events) {
  const actors = new Set();
  for (const event of events) {
    const value = event.payload?.value || event.payload?.output || {};
    for (const key of ['issuer', 'agentId', 'workerId', 'checkerId', 'reviewerId']) if (value?.[key]) actors.add(`${key}:${safeText(value[key], 128)}`);
  }
  return [...actors].sort();
}
function workflowWhy(run) {
  if (run.status === 'WAITING') return { code: run.pendingInterrupt?.kind || 'WAITING', message: `等待 ${run.pendingInterrupt?.kind || '外部输入'}：node=${run.pendingInterrupt?.nodeId || 'unknown'}`, nodeId: run.pendingInterrupt?.nodeId || null };
  if (run.status === 'WAITING_RETRY') return { code: 'TRANSIENT_RETRY', message: `瞬态失败，计划于 ${run.nextRetryAt} 重试`, nodeId: run.lastFailure?.nodeId || null };
  if (run.status === 'FAILED') return { code: run.lastFailure?.class || 'FAILED', message: safeText(run.lastFailure?.message || '运行失败'), nodeId: run.lastFailure?.nodeId || null };
  if (run.status === 'PAUSED') return { code: 'PAUSED', message: `人工暂停（此前 ${run.pausedFrom || 'RUNNING'}）`, nodeId: run.activeStep?.nodeId || null };
  if (run.status === 'CANCELLED') return { code: 'CANCELLED', message: safeText(run.cancelReason || '运行已取消'), nodeId: null };
  if (run.status === 'COMPLETED') return { code: 'COMPLETED', message: '所有可达节点已完成', nodeId: null };
  return { code: 'RUNNING', message: run.activeStep ? `正在执行 node=${run.activeStep.nodeId}` : `等待调度下一个节点（ready=${run.ready?.length || 0}）`, nodeId: run.activeStep?.nodeId || null };
}

function workflowTrace(cwd, runId) {
  const loaded = inspectRun(cwd, runId); const { run, definition, events } = loaded; const traceId = traceIdFor(cwd, 'workflow', runId);
  const rootId = spanIdFor(traceId, 'root'); const spans = [];
  const starts = events.filter(event => event.type === 'STEP_STARTED');
  for (const started of starts) {
    const executionKey = started.payload.executionKey; const following = events.filter(event => event.seq > started.seq);
    const nextStart = following.find(event => event.type === 'STEP_STARTED' && event.payload.executionKey === executionKey) || null;
    const terminal = following.find(event => {
      if (nextStart && event.seq >= nextStart.seq) return false;
      return (event.type === 'STEP_COMPLETED' && event.payload.executionKey === executionKey)
        || (event.type === 'RUN_INTERRUPTED' && event.payload.interrupt?.executionKey === executionKey)
        || (event.type === 'STEP_FAILED' && event.payload.failure?.nodeId === started.payload.nodeId);
    });
    const node = definition.nodes.find(item => item.id === started.payload.nodeId);
    const status = terminal?.type === 'STEP_COMPLETED' ? 'OK' : terminal?.type === 'STEP_FAILED' ? 'ERROR' : 'UNSET';
    const eventViews = following.filter(event => event.seq > started.seq && (!terminal || event.seq <= terminal.seq) && ['RUN_INTERRUPTED', 'RUN_RESUMED', 'COMPENSATION_COMPLETED', 'STEP_RETRY_SCHEDULED'].includes(event.type)).map(event => ({ name: event.type, time: event.at, attributes: { seq: event.seq, eventDigest: event.digest, kind: event.payload.interrupt?.kind || null, failureClass: event.payload.failure?.class || null } }));
    spans.push(makeSpan(traceId, `step:${executionKey}`, rootId, `rootagent.workflow.${node?.type || 'node'}`, node?.type || 'internal', started.at, terminal?.at || run.updatedAt, status, { 'rootagent.node.id': started.payload.nodeId, 'rootagent.execution.key': executionKey, 'rootagent.attempt': started.payload.attempt, 'rootagent.idempotency_key_digest': started.payload.idempotencyKey ? sha256(started.payload.idempotencyKey) : null, 'rootagent.output.digest': terminal?.payload?.output !== undefined ? sha256(terminal.payload.output) : null, 'rootagent.failure.class': terminal?.payload?.failure?.class || null, 'rootagent.failure.message': terminal?.payload?.failure ? safeText(terminal.payload.failure.message) : null }, eventViews));
  }
  const why = workflowWhy(run); const usage = collectUsage(run.state?.nodes || {}); const untested = findNotTested(run.state?.nodes || {});
  spans.unshift(makeSpan(traceId, 'root', null, 'rootagent.workflow.run', 'orchestrator', run.createdAt, run.updatedAt, rootStatus(run.status), { 'rootagent.run.id': runId, 'rootagent.workflow.id': run.workflowId, 'rootagent.workflow.version': run.workflowVersion, 'rootagent.workflow.digest': run.workflowDigest, 'rootagent.run.status': run.status, 'rootagent.history.digest': run.historyDigest, 'rootagent.recovered_from_events': loaded.recoveredFromEvents }, events.map(event => ({ name: event.type, time: event.at, attributes: { seq: event.seq, eventDigest: event.digest } }))));
  return sealTrace({ schemaVersion: TRACE_SCHEMA_VERSION, traceId, traceparent: `00-${traceId}-${rootId}-01`, subject: { kind: 'workflow', id: runId }, status: run.status, startedAt: run.createdAt, endedAt: ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status) ? run.updatedAt : null, whyStopped: why, actors: actorsFromEvents(events), changed: [], untested, cost: { ...usage, elapsedMs: duration(run.createdAt, run.updatedAt) }, evidence: [{ type: 'event-chain', digest: run.historyDigest, events: events.length }, { type: 'workflow-definition', digest: run.workflowDigest }], spans });
}

function taskTrace(cwd, taskId) {
  const state = readJson(path.join(cwd, '.rootagent', 'tasks.json')); if (!state) throw new Error('tasks.json 不存在');
  const task = [...(state.features || []), ...(state.archive || [])].find(item => item.id === taskId); if (!task) throw new Error(`task not found: ${taskId}`);
  if (task.contractDigest !== taskContractDigest(task)) { const error = new Error(`task ${taskId} contract digest 不匹配`); error.code = 'ROOTAGENT_TRACE_SOURCE_CORRUPT'; throw error; }
  const traceId = traceIdFor(cwd, 'task', taskId); const rootId = spanIdFor(traceId, 'root'); const spans = [];
  if (task.attempt) spans.push(makeSpan(traceId, `attempt:${task.attempt.attemptId}`, rootId, 'rootagent.task.attempt', 'agent', task.attempt.acquiredAt, task.completedAt || state.updatedAt, task.attempt.status === 'ACCEPTED' ? 'OK' : task.attempt.status === 'ACTIVE' ? 'UNSET' : 'ERROR', { 'rootagent.task.id': task.id, 'rootagent.attempt.id': task.attempt.attemptId, 'rootagent.attempt.owner': safeText(task.attempt.owner, 128), 'rootagent.fencing_token': task.attempt.fencingToken }));
  const hard = (task.attestations || []).find(item => item.type === 'hard-check');
  if (hard) {
    const hardId = spanIdFor(traceId, `hard:${hard.attestationId}`);
    spans.push(makeSpan(traceId, `hard:${hard.attestationId}`, rootId, 'rootagent.validation.hard-check', 'verifier', hard.issuedAt, hard.issuedAt, hard.verdict === 'PASS' ? 'OK' : 'ERROR', { 'rootagent.issuer': safeText(hard.issuer, 128), 'rootagent.contract.digest': hard.contractDigest, 'rootagent.candidate.digest': hard.candidateDigest, 'rootagent.security.config_digest': hard.security?.configDigest || null }));
    (hard.evidence || []).forEach((check, index) => spans.push(makeSpan(traceId, `hard:${hard.attestationId}:${index}`, hardId, 'rootagent.validation.command', 'verifier', check.securityReceipt?.executedAt || hard.issuedAt, check.securityReceipt?.executedAt || hard.issuedAt, check.verdict === 'PASS' ? 'OK' : 'ERROR', { 'rootagent.validation.level': check.level ?? null, 'rootagent.command.digest': check.securityReceipt?.commandDigest || (check.cmd ? sha256(check.cmd) : null), 'rootagent.exit_code': check.exitCode ?? null, 'rootagent.assertions': check.assertions ?? null, 'rootagent.reason': check.reason || null, 'rootagent.output.digest': check.outputDigest || check.securityReceipt?.outputDigest || null, 'rootagent.security.receipt_digest': check.securityReceipt?.digest || null })));
  }
  const checker = (task.attestations || []).find(item => item.type === 'checker');
  if (checker) {
    const checkerId = spanIdFor(traceId, `checker:${checker.attestationId}`);
    spans.push(makeSpan(traceId, `checker:${checker.attestationId}`, rootId, 'rootagent.validation.checker', 'checker', checker.issuedAt, checker.issuedAt, checker.verdict === 'PASS' ? 'OK' : 'ERROR', { 'rootagent.issuer': safeText(checker.issuer, 128), 'rootagent.report.digest': checker.reportDigest || null, 'rootagent.calibration.digest': checker.calibrationDigest || null }));
    (checker.criteria || []).forEach(item => spans.push(makeSpan(traceId, `checker:${checker.attestationId}:${item.index}`, checkerId, 'rootagent.validation.criterion', 'checker', checker.issuedAt, checker.issuedAt, item.verdict === 'PASS' ? 'OK' : item.verdict === 'FAIL' ? 'ERROR' : 'UNSET', { 'rootagent.criterion.index': item.index, 'rootagent.criterion.verdict': item.verdict, 'rootagent.confidence': item.confidence ?? null, 'rootagent.evidence.digest': sha256(item.evidence || []), 'rootagent.limitations': (item.limitations || []).map(value => safeText(value)) })));
  }
  if (task.approval) spans.push(makeSpan(traceId, `approval:${task.approval.approvalId}`, rootId, 'rootagent.task.approval', 'human', task.approval.issuedAt, task.approval.issuedAt, 'OK', { 'rootagent.issuer': safeText(task.approval.issuer, 128), 'rootagent.candidate.digest': task.approval.candidateDigest }));
  const receipt = task.receipt?.path ? readJson(path.resolve(cwd, task.receipt.path)) : null;
  if (task.receipt && !receipt) { const error = new Error(`task ${taskId} receipt 缺失`); error.code = 'ROOTAGENT_TRACE_SOURCE_CORRUPT'; throw error; }
  if (receipt) { const unsigned = clone(receipt); const claimed = unsigned.digest; delete unsigned.digest; if (claimed !== sha256(unsigned) || claimed !== task.receipt.digest) { const error = new Error(`task ${taskId} receipt digest 不匹配`); error.code = 'ROOTAGENT_TRACE_SOURCE_CORRUPT'; throw error; } }
  const candidate = task.candidate || receipt?.candidate || null;
  const why = task.status === 'blocked' ? { code: 'BLOCKED', message: safeText(task.blockedReason || '任务阻塞') } : task.status === 'completed' ? { code: 'COMPLETED', message: 'hard-check、Checker 与所需门禁均已通过' } : task.status === 'in_progress' ? { code: candidate ? 'AWAITING_CHECKER_OR_PASS' : 'IN_PROGRESS', message: candidate ? 'Candidate 已冻结，等待 Checker 或完成门' : 'Maker 正在实现或等待硬验证' } : { code: task.status.toUpperCase(), message: `任务状态为 ${task.status}` };
  const untested = checker ? (checker.criteria || []).filter(item => item.verdict === 'NOT_TESTED').map(item => ({ index: item.index, criterion: safeText(item.criterion), limitations: (item.limitations || []).map(value => safeText(value)) })) : (task.acceptanceCriteria || []).map((criterion, index) => ({ index: index + 1, criterion: safeText(criterion), limitations: ['尚无 Checker 证明'] }));
  const actors = [...new Set([task.attempt?.owner, hard?.issuer, checker?.issuer, task.approval?.issuer].filter(Boolean).map(value => safeText(value, 128)))];
  const changed = candidate?.actualWrites || candidate?.changedPaths || [];
  const changeAttribution = changed.map(file => ({ path: file, actor: safeText(task.attempt?.owner || 'unknown', 128), attemptId: task.attempt?.attemptId || null, baseCommit: candidate?.baseCommit || null, candidateDigest: candidate?.digest || null }));
  spans.unshift(makeSpan(traceId, 'root', null, 'rootagent.task', 'orchestrator', task.createdAt || task.attempt?.acquiredAt || state.createdAt, task.completedAt || state.updatedAt, rootStatus(task.status), { 'rootagent.task.id': task.id, 'rootagent.task.name': safeText(task.name), 'rootagent.task.status': task.status, 'rootagent.contract.digest': task.contractDigest, 'rootagent.candidate.digest': candidate?.digest || null, 'rootagent.retry_count': task.retryCount || 0 }));
  return sealTrace({ schemaVersion: TRACE_SCHEMA_VERSION, traceId, traceparent: `00-${traceId}-${rootId}-01`, subject: { kind: 'task', id: taskId }, status: task.status, startedAt: task.startedAt || task.attempt?.acquiredAt || state.createdAt, endedAt: task.completedAt || null, whyStopped: why, actors, changed, changeAttribution, untested, cost: { elapsedMs: duration(task.startedAt || task.attempt?.acquiredAt, task.completedAt || state.updatedAt), retries: task.retryCount || 0, validationRuns: task.validateCount || 0 }, evidence: [{ type: 'contract', digest: task.contractDigest }, ...(candidate ? [{ type: 'candidate', digest: candidate.digest, treeHash: candidate.treeHash || null }] : []), ...(task.receipt ? [{ type: 'receipt', digest: task.receipt.digest, path: task.receipt.path }] : [])], spans });
}

function integrationTrace(cwd, entryId) {
  const queue = listIntegrationQueue(cwd); const entry = queue.entries.find(item => item.entryId === entryId); if (!entry) throw new Error(`integration entry not found: ${entryId}`);
  const candidate = loadCandidate(cwd, entry.candidateDigest); const traceId = traceIdFor(cwd, 'integration', entryId); const rootId = spanIdFor(traceId, 'root');
  let receipt = null;
  if (entry.receiptDigest) {
    const receiptFile = path.join(cwd, '.rootagent', 'runtime', 'orchestration', 'integration', 'receipts', `${entry.receiptDigest}.json`);
    receipt = readJson(receiptFile);
    if (!receipt) { const error = new Error(`integration ${entryId} receipt 缺失`); error.code = 'ROOTAGENT_TRACE_SOURCE_CORRUPT'; throw error; }
    const unsigned = clone(receipt); const claimed = unsigned.digest; delete unsigned.digest;
    if (claimed !== sha256(unsigned) || claimed !== entry.receiptDigest || receipt.entryId !== entryId || receipt.candidateDigest !== entry.candidateDigest) {
      const error = new Error(`integration ${entryId} receipt digest 或 subject 不匹配`); error.code = 'ROOTAGENT_TRACE_SOURCE_CORRUPT'; throw error;
    }
  }
  const checks = (entry.checks || []).map((check, index) => makeSpan(traceId, `check:${index}`, rootId, 'rootagent.integration.validation', 'verifier', entry.startedAt, entry.completedAt, check.verdict === 'PASS' ? 'OK' : 'ERROR', { 'rootagent.command.digest': sha256(check.command), 'rootagent.exit_code': check.exitCode, 'rootagent.output.digest': check.outputDigest, 'rootagent.security.receipt_digest': check.securityReceipt?.digest || null }));
  const why = entry.status === 'INTEGRATED' ? { code: 'INTEGRATED', message: '候选在最新目标基线上复验通过并完成快进' } : entry.status === 'CONFLICT' ? { code: 'CONFLICT', message: safeText(entry.failure?.message || '合并冲突') } : entry.status === 'VALIDATION_FAILED' ? { code: 'VERIFIER', message: safeText(entry.failure?.message || '集成后验证失败') } : { code: entry.status, message: `集成项状态为 ${entry.status}` };
  const root = makeSpan(traceId, 'root', null, 'rootagent.integration', 'integrator', entry.enqueuedAt || candidate.createdAt, entry.completedAt || entry.startedAt, rootStatus(entry.status), { 'rootagent.integration.entry_id': entry.entryId, 'rootagent.candidate.digest': entry.candidateDigest, 'rootagent.target.branch': entry.targetBranch, 'rootagent.pre_head': entry.preHead || null, 'rootagent.target_head': entry.targetHead || null, 'rootagent.attempts': entry.attempts });
  return sealTrace({ schemaVersion: TRACE_SCHEMA_VERSION, traceId, traceparent: `00-${traceId}-${rootId}-01`, subject: { kind: 'integration', id: entryId }, status: entry.status, startedAt: entry.enqueuedAt || candidate.createdAt, endedAt: entry.completedAt || null, whyStopped: why, actors: entry.owner ? [`integrator:${entry.owner.host}:${entry.owner.pid}`] : [], changed: candidate.actualWrites || [], untested: [], cost: { elapsedMs: duration(entry.enqueuedAt || entry.startedAt, entry.completedAt), attempts: entry.attempts || 0 }, evidence: [{ type: 'candidate', digest: entry.candidateDigest }, ...(receipt ? [{ type: 'integration-receipt', digest: receipt.digest }] : [])], spans: [root, ...checks] });
}

export function buildExplainableTrace(cwd, ref) {
  const value = String(ref || '');
  if (value.startsWith('run_')) return workflowTrace(cwd, value);
  if (/^t\d+$/i.test(value)) return taskTrace(cwd, value);
  if (value.startsWith('iq_') || value.startsWith('integration_')) return integrationTrace(cwd, value);
  throw new Error(`无法识别 trace subject：${value}`);
}

export function listExplainableTraces(cwd) {
  const result = []; const state = readJson(path.join(cwd, '.rootagent', 'tasks.json'), { features: [], archive: [] });
  for (const task of [...(state.features || []), ...(state.archive || [])]) result.push({ kind: 'task', id: task.id, status: task.status, updatedAt: task.completedAt || task.startedAt || state.updatedAt || null });
  const runsRoot = path.join(cwd, '.rootagent', 'runtime', 'control', 'runs');
  if (fs.existsSync(runsRoot)) for (const id of fs.readdirSync(runsRoot)) { try { const loaded = inspectRun(cwd, id); result.push({ kind: 'workflow', id, status: loaded.run.status, updatedAt: loaded.run.updatedAt }); } catch (error) { result.push({ kind: 'workflow', id, status: 'CORRUPT', error: safeText(error.message) }); } }
  for (const entry of listIntegrationQueue(cwd).entries || []) result.push({ kind: 'integration', id: entry.entryId, status: entry.status, updatedAt: entry.completedAt || entry.startedAt || entry.queuedAt || null });
  return result.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export function verifyExplainableTrace(trace) {
  const errors = []; if (trace?.schemaVersion !== TRACE_SCHEMA_VERSION) errors.push('trace schemaVersion 无效');
  if (!/^[0-9a-f]{32}$/.test(trace?.traceId || '')) errors.push('traceId 必须是 16-byte hex');
  if (!Array.isArray(trace?.spans) || !trace.spans.length) errors.push('spans 不能为空');
  const ids = new Set(); for (const span of trace?.spans || []) {
    if (!/^[0-9a-f]{16}$/.test(span.spanId || '') || ids.has(span.spanId)) errors.push(`spanId 无效或重复：${span.spanId}`);
    ids.add(span.spanId);
    if (span.traceId !== trace?.traceId) errors.push(`span traceId 不一致：${span.spanId}`);
    if (!SPAN_STATUSES.includes(span.status?.code)) errors.push(`span status 无效：${span.spanId}`);
    const start = atMs(span.startTime); const end = atMs(span.endTime);
    if (span.startTime != null && !Number.isFinite(start)) errors.push(`span startTime 无效：${span.spanId}`);
    if (span.endTime != null && !Number.isFinite(end)) errors.push(`span endTime 无效：${span.spanId}`);
    if (Number.isFinite(start) && Number.isFinite(end) && end < start) errors.push(`span 时间倒序：${span.spanId}`);
    const expectedDuration = Number.isFinite(start) && Number.isFinite(end) ? end - start : null;
    if (span.durationMs !== expectedDuration) errors.push(`span durationMs 不一致：${span.spanId}`);
  }
  const roots = (trace?.spans || []).filter(span => span.parentSpanId == null); if (roots.length !== 1) errors.push('trace 必须恰有一个 root span');
  for (const span of trace?.spans || []) if (span.parentSpanId != null && !ids.has(span.parentSpanId)) errors.push(`parent span 不存在：${span.parentSpanId}`);
  const byId = new Map((trace?.spans || []).map(span => [span.spanId, span]));
  for (const span of trace?.spans || []) {
    const seen = new Set([span.spanId]); let parentId = span.parentSpanId;
    while (parentId != null && byId.has(parentId)) {
      if (seen.has(parentId)) { errors.push(`span parent cycle：${span.spanId}`); break; }
      seen.add(parentId); parentId = byId.get(parentId).parentSpanId;
    }
  }
  if (roots.length === 1 && trace?.traceparent !== `00-${trace.traceId}-${roots[0].spanId}-01`) errors.push('traceparent 未绑定 root span');
  const unsigned = clone(trace || {}); const claimed = unsigned.digest; delete unsigned.digest; if (claimed !== sha256(unsigned)) errors.push('trace digest 不匹配');
  return { ok: errors.length === 0, errors };
}
