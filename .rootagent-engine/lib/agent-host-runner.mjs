import fs from 'fs';
import path from 'path';
import { executeRunStep, inspectRun, resumeRun } from './control-graph.mjs';
import { executeAgentHostInterrupt, planAgentHostExecution, verifyAgentHostExecutionRecord, verifyHostCapabilityEvidence } from './agent-host.mjs';
import { buildContextPacket, verifyContextPacket, listWorkspaces, loadWorkspace } from './project-orchestration.mjs';
import { executeCommand } from './command-execution.mjs';
import { atomicWriteJson, sha256, taskContractDigest } from './trust-core.mjs';
import { resolveAgentHostRuntime } from './agent-host-runtime.mjs';

const AUTO_INTERRUPT_KINDS = new Set(['AGENT', 'CHECKER', 'INTEGRATION']);
const HUMAN_INTERRUPT_KINDS = new Set(['APPROVAL', 'AMBIGUOUS_SIDE_EFFECT']);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function driverFailure(code, reason, data = {}) {
  return { ok: false, code, reason, ...data };
}

function runtimeRoot(cwd) {
  return path.join(cwd, '.rootagent', 'runtime', 'agent-host-driver');
}

function safe(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function checkpointPath(cwd, runId, executionKey) {
  return path.join(runtimeRoot(cwd), safe(runId), safe(executionKey) + '.json');
}

function verifyCheckpoint(record) {
  if (!record || typeof record !== 'object') return { ok: false, code: 'HOST_DRIVER_CHECKPOINT_INVALID' };
  const claimed = record.digest;
  const copy = clone(record);
  delete copy.digest;
  if (!claimed || claimed !== sha256(copy)) return { ok: false, code: 'HOST_DRIVER_CHECKPOINT_DIGEST_INVALID' };
  if (!['PENDING_CHAT', 'PENDING_BRIDGE', 'STARTED', 'COMPLETED', 'FAILED'].includes(record.status)) return { ok: false, code: 'HOST_DRIVER_CHECKPOINT_STATUS_INVALID' };
  return { ok: true, record };
}

function readCheckpoint(cwd, runId, interrupt) {
  const file = checkpointPath(cwd, runId, interrupt.executionKey);
  if (!fs.existsSync(file)) return { file, record: null };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch (error) { return { file, error: driverFailure('HOST_DRIVER_CHECKPOINT_INVALID', error.message) }; }
  const checked = verifyCheckpoint(parsed);
  if (!checked.ok) return { file, error: driverFailure(checked.code, 'Agent Host driver checkpoint invalid') };
  const record = checked.record;
  if (record.runId !== runId || record.interruptId !== interrupt.interruptId || record.executionKey !== interrupt.executionKey || record.nodeId !== interrupt.nodeId) {
    return { file, error: driverFailure('HOST_DRIVER_CHECKPOINT_SUBJECT_MISMATCH', 'Driver checkpoint does not match current interrupt') };
  }
  return { file, record };
}

function writeCheckpoint(file, value) {
  const record = clone(value);
  delete record.digest;
  record.digest = sha256(record);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJson(file, record);
  return record;
}

function taskState(cwd, taskId) {
  const file = path.join(cwd, '.rootagent', 'tasks.json');
  if (!fs.existsSync(file)) return driverFailure('HOST_TASK_STATE_MISSING', '.rootagent/tasks.json is required');
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch (error) { return driverFailure('HOST_TASK_STATE_INVALID', error.message); }
  const task = (data.features || []).find(item => item.id === taskId);
  if (!task) return driverFailure('HOST_TASK_NOT_FOUND', 'Task not found: ' + taskId);
  if (task.status !== 'in_progress' || task.attempt?.status !== 'ACTIVE') {
    return driverFailure('HOST_ACTIVE_ATTEMPT_REQUIRED', 'Task ' + taskId + ' requires an ACTIVE Attempt');
  }
  const digest = taskContractDigest(task);
  if (digest !== task.contractDigest) return driverFailure('CONTRACT_TAMPERED', 'Task contract digest mismatch');
  return { ok: true, task, data };
}

function frozenContract(task) {
  return {
    id: task.id,
    name: task.name,
    description: task.description,
    acceptanceCriteria: clone(task.acceptanceCriteria || []),
    validationCommands: clone(task.validationCommands || []),
    setupCommands: clone(task.setupCommands || []),
    dependsOn: clone(task.dependsOn || []),
    writes: clone(task.writes || []),
    resources: clone(task.resources || []),
    requiresReview: !!task.requiresReview,
    hostPolicy: clone(task.hostPolicy || null),
    contractDigest: task.contractDigest,
  };
}

function defaultExecutionContext(cwd, interrupt, options = {}) {
  const payload = interrupt.payload || {};
  const state = taskState(cwd, payload.taskId);
  if (!state.ok) return state;
  const task = state.task;
  const globalGoal = state.data?.goal || '';
  const contextRole = payload.contextRole || payload.role;
  if (!['maker', 'checker', 'reviewer', 'integrator', 'planner'].includes(contextRole)) {
    return driverFailure('HOST_CONTEXT_ROLE_UNSUPPORTED', 'Context role unsupported: ' + contextRole);
  }
  const packet = buildContextPacket(cwd, contextRole, {
    projectGoal: globalGoal,
    contract: frozenContract(task),
    base: {
      commit: task.attempt?.baseCommit || null,
      attemptId: task.attempt?.attemptId || null,
      fencingToken: task.attempt?.fencingToken ?? null,
    },
    candidate: clone(task.candidate || null),
    recentFailures: clone((task.validationHistory || []).slice(-5)),
    tools: clone(options.tools || []),
    budget: clone(options.budget || null),
    traceContext: clone(options.traceContext || null),
  });
  const packetCheck = verifyContextPacket(packet);
  if (!packetCheck.ok) return driverFailure('HOST_CONTEXT_PACKET_INVALID', packetCheck.reason || 'ContextPacket invalid');
  return {
    ok: true,
    subject: {
      taskId: task.id,
      contractDigest: task.contractDigest,
      attemptId: task.attempt.attemptId,
      fencingToken: task.attempt.fencingToken,
    },
    contextPacket: packet,
    contextPacketDigest: packet.digest,
  };
}

function resolveWorkspaceBinding(cwd, interrupt, subject, options = {}) {
  const required = interrupt.payload?.executionRequirements?.workspaceIsolation === 'required'
    || interrupt.payload?.executionRequirements?.rootAgentIsolation === 'WORKTREE_REQUIRED';
  if (!required) return { ok: true, binding: null };

  if (typeof options.resolveWorkspaceBinding === 'function') {
    const custom = options.resolveWorkspaceBinding({ cwd, interrupt: clone(interrupt), subject: clone(subject) });
    if (custom && typeof custom.then === 'function') {
      return driverFailure('HOST_WORKSPACE_BINDING_ASYNC_UNSUPPORTED', 'Workspace binding resolver must be synchronous');
    }
    if (!custom?.ok) return custom || driverFailure('HOST_WORKSPACE_BINDING_REQUIRED', 'Workspace binding unavailable');
    return custom;
  }

  const matches = (listWorkspaces(cwd) || []).filter(item =>
    item.status === 'ACTIVE'
    && item.taskId === subject.taskId
    && item.contractDigest === subject.contractDigest
    && item.attemptId === subject.attemptId
    && item.fencingToken === subject.fencingToken
  );
  if (!matches.length) return driverFailure('HOST_WORKSPACE_BINDING_REQUIRED', 'WORKTREE_REQUIRED execution has no matching ACTIVE RootAgent workspace');
  if (matches.length > 1) return driverFailure('HOST_WORKSPACE_BINDING_AMBIGUOUS', 'Multiple ACTIVE RootAgent workspaces match this execution subject', {
    workspaceIds: matches.map(item => item.workspaceId),
  });

  let workspace;
  try { workspace = loadWorkspace(cwd, matches[0].workspaceId); }
  catch (error) { return driverFailure(error.code || 'HOST_WORKSPACE_BINDING_INVALID', error.message || String(error)); }

  const binding = {
    schemaVersion: 1,
    workspaceId: workspace.workspaceId,
    taskId: workspace.taskId,
    contractDigest: workspace.contractDigest,
    attemptId: workspace.attemptId,
    fencingToken: workspace.fencingToken,
    path: workspace.path,
    branch: workspace.branch,
    baseCommit: workspace.baseCommit,
    targetBranch: workspace.targetBranch || null,
  };
  binding.digest = sha256(binding);
  return { ok: true, binding };
}

function commandExecutor(cwd, runtime, options) {
  const custom = options.executeCommand || runtime.executeCommand;
  if (typeof custom === 'function') {
    return (spec, context) => {
      const value = custom(spec, context);
      if (value && typeof value.then === 'function') {
        return { ok: false, code: 70, out: 'async command executor is unsupported by Durable Control Graph', failureClass: 'INFRASTRUCTURE' };
      }
      return value;
    };
  }
  return spec => executeCommand(cwd, spec, { automated: true });
}

function checkpointSummary(record) {
  return record ? {
    status: record.status,
    interruptId: record.interruptId,
    executionKey: record.executionKey,
    role: record.role,
    executionId: record.executionRecord?.executionId || null,
    strategy: record.executionRecord?.strategy || null,
    digest: record.digest,
  } : null;
}

export function inspectAgentHostRunDriver(cwd, runId) {
  const dir = path.join(runtimeRoot(cwd), safe(runId));
  if (!fs.existsSync(dir)) return { runId, checkpoints: [] };
  const checkpoints = [];
  for (const name of fs.readdirSync(dir).filter(item => item.endsWith('.json')).sort()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));
      const checked = verifyCheckpoint(parsed);
      checkpoints.push(checked.ok ? checkpointSummary(parsed) : { status: 'CORRUPT', file: name, code: checked.code });
    } catch {
      checkpoints.push({ status: 'CORRUPT', file: name, code: 'HOST_DRIVER_CHECKPOINT_INVALID' });
    }
  }
  return { runId, checkpoints };
}

export function readAgentHostRunDriverEvidence(cwd, runId) {
  const dir = path.join(runtimeRoot(cwd), safe(runId));
  if (!fs.existsSync(dir)) {
    return { ok: false, code: 'HOST_DRIVER_EVIDENCE_NOT_FOUND', runId, errors: [{ code: 'HOST_DRIVER_EVIDENCE_NOT_FOUND' }], checkpoints: [] };
  }

  const errors = [];
  const checkpoints = [];
  for (const name of fs.readdirSync(dir).filter(item => item.endsWith('.json')).sort()) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));
    } catch {
      errors.push({ code: 'HOST_DRIVER_CHECKPOINT_INVALID', file: name });
      continue;
    }

    const checked = verifyCheckpoint(parsed);
    if (!checked.ok) {
      errors.push({ code: checked.code, file: name });
      continue;
    }
    const record = checked.record;
    if (record.runId !== runId) {
      errors.push({ code: 'HOST_DRIVER_CHECKPOINT_SUBJECT_MISMATCH', file: name });
      continue;
    }
    if (record.status !== 'COMPLETED') {
      errors.push({ code: 'HOST_DRIVER_EVIDENCE_INCOMPLETE', file: name, status: record.status });
      continue;
    }

    const capability = verifyHostCapabilityEvidence(record.capabilityEvidence);
    if (!capability.ok) {
      errors.push(...capability.errors.map(error => ({ ...error, file: name })));
      continue;
    }
    const execution = verifyAgentHostExecutionRecord(record.executionRecord);
    if (!execution.ok) {
      errors.push(...execution.errors.map(error => ({ ...error, file: name })));
      continue;
    }

    const evidence = capability.evidence;
    const executionRecord = execution.record;
    const subject = record.subject || {};
    const evidenceSubject = evidence.subject || {};
    const executionSubject = executionRecord.subject || {};
    const subjectMismatch =
      record.taskId !== subject.taskId
      || evidenceSubject.taskId !== subject.taskId
      || evidenceSubject.contractDigest !== subject.contractDigest
      || evidenceSubject.attemptId !== subject.attemptId
      || evidenceSubject.fencingToken !== subject.fencingToken
      || executionSubject.taskId !== subject.taskId
      || executionSubject.contractDigest !== subject.contractDigest
      || executionSubject.attemptId !== subject.attemptId
      || executionSubject.fencingToken !== subject.fencingToken;
    if (subjectMismatch) {
      errors.push({ code: 'HOST_DRIVER_EVIDENCE_SUBJECT_MISMATCH', file: name });
      continue;
    }
    if (
      executionRecord.capabilityEvidenceDigest !== evidence.digest
      || executionRecord.hostCapabilityDigest !== evidence.capabilityDigest
      || executionRecord.contextPacketDigest !== record.contextPacketDigest
    ) {
      errors.push({ code: 'HOST_DRIVER_EVIDENCE_LINK_MISMATCH', file: name });
      continue;
    }

    checkpoints.push({
      file: name,
      checkpointDigest: record.digest,
      runId: record.runId,
      workflowId: record.workflowId,
      workflowDigest: record.workflowDigest,
      executionKey: record.executionKey,
      nodeId: record.nodeId,
      role: record.role,
      taskId: record.taskId,
      subject: clone(subject),
      contextPacketDigest: record.contextPacketDigest,
      capabilityEvidence: clone(evidence),
      executionRecord: clone(executionRecord),
      outputDigest: record.outputDigest || null,
      completedAt: record.completedAt || null,
    });
  }

  return {
    ok: errors.length === 0 && checkpoints.length > 0,
    code: errors.length ? 'HOST_DRIVER_EVIDENCE_INVALID' : checkpoints.length ? 'HOST_DRIVER_EVIDENCE_VERIFIED' : 'HOST_DRIVER_EVIDENCE_NOT_FOUND',
    runId,
    errors,
    checkpoints,
  };
}

export async function driveAgentHostRun(cwd, runId, runtime = undefined, options = {}) {
  const runtimeResolution = await resolveAgentHostRuntime(cwd, {
    runtime,
    globalObject: options.globalObject,
    providers: options.runtimeProviders,
  });
  if (!runtimeResolution.ok) {
    return driverFailure(runtimeResolution.code || 'HOST_RUNTIME_RESOLUTION_FAILED', runtimeResolution.reason || 'Unable to resolve Agent Host runtime', {
      runId,
      runtimeResolution,
    });
  }
  const activeRuntime = runtimeResolution.runtime;
  const runtimeMeta = {
    source: runtimeResolution.source,
    providerId: runtimeResolution.providerId || null,
    profile: runtimeResolution.profile,
    capabilityDigest: runtimeResolution.capabilities?.digest || null,
  };
  const maxCycles = Number.isInteger(options.maxCycles) && options.maxCycles > 0 ? options.maxCycles : 100;
  const execCommand = commandExecutor(cwd, activeRuntime, options);
  let automatedInterrupts = 0;

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    let stepped;
    try {
      stepped = executeRunStep(cwd, runId, { executeCommand: execCommand });
    } catch (error) {
      return driverFailure(error.code || 'HOST_RUN_STEP_FAILED', error.message || String(error), { runId });
    }

    if (['COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED', 'WAITING_RETRY'].includes(stepped.status)) {
      return {
        ok: stepped.status === 'COMPLETED',
        code: stepped.status === 'COMPLETED' ? 'HOST_RUN_COMPLETED' : 'HOST_RUN_' + stepped.status,
        runId,
        status: stepped.status,
        automatedInterrupts,
        run: stepped.run,
        failure: stepped.failure || null,
        runtime: runtimeMeta,
      };
    }

    if (stepped.status !== 'WAITING' || !stepped.interrupt) {
      return driverFailure('HOST_RUN_STATE_UNEXPECTED', 'Unexpected run state: ' + stepped.status, { runId, status: stepped.status });
    }

    const interrupt = stepped.interrupt;
    if (HUMAN_INTERRUPT_KINDS.has(interrupt.kind)) {
      return {
        ok: true,
        code: interrupt.kind === 'APPROVAL' ? 'HOST_WAITING_HUMAN_APPROVAL' : 'HOST_WAITING_AMBIGUOUS_SIDE_EFFECT',
        runId,
        status: 'WAITING',
        interrupt: clone(interrupt),
        automatedInterrupts,
        runtime: runtimeMeta,
      };
    }
    if (!AUTO_INTERRUPT_KINDS.has(interrupt.kind)) {
      return driverFailure('HOST_INTERRUPT_UNSUPPORTED', 'Unsupported interrupt kind: ' + interrupt.kind, { runId, interrupt: clone(interrupt) });
    }

    const existing = readCheckpoint(cwd, runId, interrupt);
    if (existing.error) return existing.error;
    if (existing.record?.status === 'STARTED') {
      return driverFailure('HOST_EXECUTION_AMBIGUOUS', 'Prior Host execution started but no durable completion record exists; automatic replay is forbidden', {
        runId,
        interrupt: clone(interrupt),
        checkpoint: checkpointSummary(existing.record),
      });
    }
    if (existing.record?.status === 'FAILED') {
      return driverFailure('HOST_EXECUTION_PREVIOUSLY_FAILED', existing.record.failure?.reason || 'Prior Host execution failed', {
        runId,
        interrupt: clone(interrupt),
        checkpoint: checkpointSummary(existing.record),
        failure: clone(existing.record.failure || null),
      });
    }
    if (existing.record?.status === 'COMPLETED') {
      try {
        resumeRun(cwd, runId, clone(existing.record.output));
      } catch (error) {
        const current = inspectRun(cwd, runId);
        if (!(current.run.status === 'RUNNING' && current.run.resumeValues?.[interrupt.executionKey] !== undefined)) {
          return driverFailure(error.code || 'HOST_RUN_RESUME_FAILED', error.message || String(error), { runId });
        }
      }
      automatedInterrupts++;
      continue;
    }

    const planned = planAgentHostExecution(interrupt, activeRuntime);
    if (!planned.ok) return { ...planned, runId, status: 'WAITING', interrupt: clone(interrupt), automatedInterrupts, runtime: runtimeMeta };

    let context = typeof options.resolveExecutionContext === 'function'
      ? await options.resolveExecutionContext({ cwd, runId, interrupt: clone(interrupt), plan: clone(planned) })
      : defaultExecutionContext(cwd, interrupt, options);
    if (!context?.ok) return { ...(context || driverFailure('HOST_EXECUTION_CONTEXT_REQUIRED', 'Execution context unavailable')), runId, interrupt: clone(interrupt) };
    if (context.subject?.taskId !== interrupt.payload?.taskId) {
      return driverFailure('HOST_ATTEMPT_SUBJECT_MISMATCH', 'Execution context taskId does not match interrupt taskId', { runId });
    }

    const workspace = resolveWorkspaceBinding(cwd, interrupt, context.subject, options);
    if (!workspace?.ok) return { ...workspace, runId, status: 'WAITING', interrupt: clone(interrupt), automatedInterrupts, runtime: runtimeMeta };

    const cooperative = activeRuntime.cooperativeChat;
    let chatResponse = null;
    if (cooperative) {
      // 稳定 requestId：只依赖冻结的执行 subject，不依赖会随每次重建而变化的
      // ContextPacket 元数据（packetId/createdAt），保证恢复期请求身份幂等。
      const requestId = 'chat_' + sha256({
        runId,
        interruptId: interrupt.interruptId,
        executionKey: interrupt.executionKey,
        subject: context.subject,
      }).slice(0, 32);
      if (existing.record?.status === 'PENDING_CHAT') {
        const frozen = existing.record.subject || {};
        // Attempt/fencing 漂移：冻结 subject 与当前重推导 subject 必须完全一致，否则旧响应绝不消费。
        if (frozen.taskId !== context.subject.taskId || frozen.contractDigest !== context.subject.contractDigest
            || frozen.attemptId !== context.subject.attemptId || frozen.fencingToken !== context.subject.fencingToken) {
          return driverFailure('HOST_CHAT_REQUEST_SUBJECT_MISMATCH', 'PENDING_CHAT checkpoint subject no longer matches current Attempt; stale chat responses must not be consumed', {
            runId,
            interrupt: clone(interrupt),
            checkpointSubject: clone(frozen),
            currentSubject: clone(context.subject),
            checkpoint: checkpointSummary(existing.record),
          });
        }
        if (existing.record.requestId && existing.record.requestId !== requestId) {
          return driverFailure('HOST_CHAT_REQUEST_SUBJECT_MISMATCH', 'PENDING_CHAT checkpoint requestId no longer matches re-derived execution subject; stale chat responses must not be consumed', {
            runId,
            interrupt: clone(interrupt),
            checkpointRequestId: existing.record.requestId,
            rederivedRequestId: requestId,
            checkpoint: checkpointSummary(existing.record),
          });
        }
        // A review is about the frozen Candidate, not merely its Attempt. Maker
        // may change the Candidate while implementing; Checker/Reviewer may not.
        if (['checker', 'reviewer'].includes(interrupt.payload?.contextRole || interrupt.payload?.role)
            && (existing.record.contextPacket?.candidate?.digest || null) !== (context.contextPacket?.candidate?.digest || null)) {
          return driverFailure('HOST_CHAT_CANDIDATE_MISMATCH', 'Review Candidate changed while chat execution was pending; do not consume the old review', {
            runId,
            interrupt: clone(interrupt),
            expectedCandidateDigest: existing.record.contextPacket?.candidate?.digest || null,
            actualCandidateDigest: context.contextPacket?.candidate?.digest || null,
          });
        }
        // 复用 PENDING_CHAT 冻结的 ContextPacket：恢复期 requestId / ContextPacket 绑定保持稳定。
        if (existing.record.contextPacket) {
          context = { ...context, contextPacket: clone(existing.record.contextPacket), contextPacketDigest: existing.record.contextPacketDigest };
        }
      }
      const chatRequest = {
        schemaVersion: 1,
        role: interrupt.payload?.role || null,
        contextRole: interrupt.payload?.contextRole || interrupt.payload?.role || null,
        taskId: interrupt.payload?.taskId || null,
        workflowId: interrupt.payload?.workflowId || stepped.run.workflowId,
        workflowDigest: interrupt.payload?.workflowDigest || stepped.run.workflowDigest,
        prompt: interrupt.payload?.prompt || '',
        input: clone(interrupt.payload?.input),
        allowedActions: clone(interrupt.payload?.allowedActions || []),
        resultSchema: clone(interrupt.payload?.resultSchema || { type: 'any' }),
        executionRequirements: clone(interrupt.payload?.executionRequirements || {}),
        contextPacket: clone(context.contextPacket),
        contextPacketDigest: context.contextPacketDigest,
        workspace: clone(workspace.binding),
      };
      // Persist the frozen packet before publishing: a crash between the two
      // writes must never rebuild a conflicting request on the next drive.
      const pending = writeCheckpoint(existing.file, {
        schemaVersion: 1,
        runId,
        workflowId: stepped.run.workflowId,
        workflowDigest: stepped.run.workflowDigest,
        interruptId: interrupt.interruptId,
        executionKey: interrupt.executionKey,
        nodeId: interrupt.nodeId,
        kind: interrupt.kind,
        role: interrupt.payload?.role || null,
        taskId: interrupt.payload?.taskId || null,
        status: 'PENDING_CHAT',
        requestId,
        subject: clone(context.subject),
        contextPacket: clone(context.contextPacket),
        contextPacketDigest: context.contextPacketDigest,
        workspaceId: workspace.binding?.workspaceId || null,
        workspaceBindingDigest: workspace.binding?.digest || null,
        publishedAt: existing.record?.publishedAt || new Date().toISOString(),
        runtime: runtimeMeta,
      });
      try {
        cooperative.publish({
          requestId,
          runId,
          interruptId: interrupt.interruptId,
          executionKey: interrupt.executionKey,
          nodeId: interrupt.nodeId,
          role: interrupt.payload?.role,
          taskId: interrupt.payload?.taskId,
          subject: context.subject,
          contextPacketDigest: context.contextPacketDigest,
          request: chatRequest,
          publishedAt: pending.publishedAt,
        });
        chatResponse = cooperative.readResponse(requestId, { subject: context.subject });
      } catch (error) {
        return driverFailure(error.code || 'HOST_CHAT_REQUEST_FAILED', error.message || String(error), { runId, requestId });
      }
      if (!chatResponse) {
        return {
          ok: true,
          code: 'HOST_WAITING_CHAT_EXECUTION',
          runId,
          status: 'WAITING',
          interrupt: clone(interrupt),
          requestId,
          checkpoint: checkpointSummary(pending),
          automatedInterrupts,
          runtime: runtimeMeta,
        };
      }
      cooperative.activate(chatResponse);
    }

    const bridge = activeRuntime.cooperativeBridge;
    let bridgeResponse = null;
    if (bridge && !cooperative) {
      const executionId = `${interrupt.payload?.role || 'role'}-${interrupt.payload?.taskId || 'task'}-${sha256({
        runId,
        interruptId: interrupt.interruptId,
        executionKey: interrupt.executionKey,
        subject: context.subject,
      }).slice(0, 16)}`;

      if (existing.record?.status === 'PENDING_BRIDGE') {
        const frozen = existing.record.subject || {};
        if (frozen.taskId !== context.subject.taskId || frozen.contractDigest !== context.subject.contractDigest
            || frozen.attemptId !== context.subject.attemptId || frozen.fencingToken !== context.subject.fencingToken) {
          return driverFailure('HOST_BRIDGE_REQUEST_SUBJECT_MISMATCH', 'PENDING_BRIDGE checkpoint subject no longer matches current Attempt; stale bridge responses must not be consumed', {
            runId,
            interrupt: clone(interrupt),
            checkpointSubject: clone(frozen),
            currentSubject: clone(context.subject),
            checkpoint: checkpointSummary(existing.record),
          });
        }
        if (existing.record.executionId && existing.record.executionId !== executionId) {
          return driverFailure('HOST_BRIDGE_REQUEST_SUBJECT_MISMATCH', 'PENDING_BRIDGE checkpoint executionId no longer matches re-derived execution subject', {
            runId,
            interrupt: clone(interrupt),
            checkpointExecutionId: existing.record.executionId,
            rederivedExecutionId: executionId,
            checkpoint: checkpointSummary(existing.record),
          });
        }
        if (['checker', 'reviewer'].includes(interrupt.payload?.contextRole || interrupt.payload?.role)
            && (existing.record.contextPacket?.candidate?.digest || null) !== (context.contextPacket?.candidate?.digest || null)) {
          return driverFailure('HOST_BRIDGE_CANDIDATE_MISMATCH', 'Review Candidate changed while bridge execution was pending; do not consume the old review', {
            runId,
            interrupt: clone(interrupt),
            expectedCandidateDigest: existing.record.contextPacket?.candidate?.digest || null,
            actualCandidateDigest: context.contextPacket?.candidate?.digest || null,
          });
        }
        if (existing.record.contextPacket) {
          context = { ...context, contextPacket: clone(existing.record.contextPacket), contextPacketDigest: existing.record.contextPacketDigest };
        }
      }

      const bridgeRequest = {
        schemaVersion: 1,
        executionId,
        role: interrupt.payload?.role || null,
        contextRole: interrupt.payload?.contextRole || interrupt.payload?.role || null,
        taskId: interrupt.payload?.taskId || null,
        workflowId: stepped.run.workflowId,
        workflowDigest: stepped.run.workflowDigest,
        prompt: interrupt.payload?.prompt || '',
        input: clone(interrupt.payload?.input),
        allowedActions: clone(interrupt.payload?.allowedActions || []),
        resultSchema: clone(interrupt.payload?.resultSchema || { type: 'any' }),
        executionRequirements: clone(interrupt.payload?.executionRequirements || {}),
        contextPacket: clone(context.contextPacket),
        contextPacketDigest: context.contextPacketDigest,
        workspace: clone(workspace.binding),
      };

      const pending = writeCheckpoint(existing.file, {
        schemaVersion: 1,
        runId,
        workflowId: stepped.run.workflowId,
        workflowDigest: stepped.run.workflowDigest,
        interruptId: interrupt.interruptId,
        executionKey: interrupt.executionKey,
        nodeId: interrupt.nodeId,
        kind: interrupt.kind,
        role: interrupt.payload?.role || null,
        taskId: interrupt.payload?.taskId || null,
        status: 'PENDING_BRIDGE',
        executionId,
        subject: clone(context.subject),
        contextPacket: clone(context.contextPacket),
        contextPacketDigest: context.contextPacketDigest,
        workspaceId: workspace.binding?.workspaceId || null,
        workspaceBindingDigest: workspace.binding?.digest || null,
        publishedAt: existing.record?.publishedAt || new Date().toISOString(),
        runtime: runtimeMeta,
      });

      try {
        bridge.publish(bridgeRequest);
        const waitTimeout = options.waitMs ?? (options.wait === false ? 0 : (activeRuntime.bridgeTimeoutMs ?? 500));
        bridgeResponse = await bridge.readResponse(executionId, { timeoutMs: waitTimeout });
      } catch (error) {
        return driverFailure(error.code || 'HOST_BRIDGE_REQUEST_FAILED', error.message || String(error), { runId, executionId });
      }

      if (!bridgeResponse) {
        return {
          ok: true,
          code: 'HOST_WAITING_SUBAGENT_EXECUTION',
          runId,
          status: 'WAITING',
          interrupt: clone(interrupt),
          executionId,
          role: interrupt.payload?.role,
          taskId: interrupt.payload?.taskId,
          prompt: interrupt.payload?.prompt,
          checkpoint: checkpointSummary(pending),
          automatedInterrupts,
          runtime: runtimeMeta,
        };
      }
      bridge.activate(bridgeResponse);
    }
    const started = writeCheckpoint(existing.file, {
      schemaVersion: 1,
      runId,
      workflowId: stepped.run.workflowId,
      workflowDigest: stepped.run.workflowDigest,
      interruptId: interrupt.interruptId,
      executionKey: interrupt.executionKey,
      nodeId: interrupt.nodeId,
      kind: interrupt.kind,
      role: interrupt.payload?.role || null,
      taskId: interrupt.payload?.taskId || null,
      status: 'STARTED',
      subject: clone(context.subject),
      contextPacketDigest: context.contextPacketDigest,
      workspaceId: workspace.binding?.workspaceId || null,
      workspaceBindingDigest: workspace.binding?.digest || null,
      startedAt: options.startedAt || new Date().toISOString(),
      runtime: runtimeMeta,
    });

    if (options.crashPoint === 'after_host_start:' + interrupt.nodeId) {
      return { ok: false, code: 'HOST_DRIVER_CRASH_SIMULATED', runId, status: 'WAITING', interrupt: clone(interrupt), checkpoint: checkpointSummary(started) };
    }

    let broker;
    try {
      broker = await executeAgentHostInterrupt(interrupt, activeRuntime, {
        subject: context.subject,
        contextPacket: context.contextPacket,
        contextPacketDigest: context.contextPacketDigest,
        workspaceBinding: workspace.binding,
        startedAt: started.startedAt,
        completedAt: options.completedAt,
      });
    } catch (error) {
      broker = driverFailure(error.code || 'HOST_EXECUTION_FAILED', error.message || String(error));
    }

    if (cooperative?.clear) cooperative.clear();
    if (bridge?.clear) bridge.clear();

    if (!broker.ok) {
      const failed = writeCheckpoint(existing.file, {
        ...started,
        status: 'FAILED',
        failedAt: new Date().toISOString(),
        failure: { code: broker.code || 'HOST_EXECUTION_FAILED', reason: broker.reason || 'Host execution failed', data: clone(broker) },
      });
      return { ...broker, runId, status: 'WAITING', interrupt: clone(interrupt), checkpoint: checkpointSummary(failed), automatedInterrupts, runtime: runtimeMeta };
    }

    const recordCheck = verifyAgentHostExecutionRecord(broker.executionRecord);
    if (!recordCheck.ok) {
      const failed = writeCheckpoint(existing.file, {
        ...started,
        status: 'FAILED',
        failedAt: new Date().toISOString(),
        failure: { code: 'HOST_EXECUTION_RECORD_INVALID', reason: 'Broker execution record invalid', data: recordCheck.errors },
      });
      return driverFailure('HOST_EXECUTION_RECORD_INVALID', 'Broker execution record invalid', { runId, checkpoint: checkpointSummary(failed), errors: recordCheck.errors });
    }

    const completed = writeCheckpoint(existing.file, {
      ...started,
      status: 'COMPLETED',
      completedAt: new Date().toISOString(),
      output: clone(broker.output),
      outputDigest: sha256(broker.output),
      capabilityEvidence: clone(broker.capabilityEvidence),
      executionRecord: clone(broker.executionRecord),
    });

    if (options.crashPoint === 'after_host_checkpoint:' + interrupt.nodeId) {
      return { ok: false, code: 'HOST_DRIVER_CRASH_SIMULATED', runId, status: 'WAITING', interrupt: clone(interrupt), checkpoint: checkpointSummary(completed) };
    }

    try {
      resumeRun(cwd, runId, clone(broker.output));
    } catch (error) {
      return driverFailure(error.code || 'HOST_RUN_RESUME_FAILED', error.message || String(error), { runId, checkpoint: checkpointSummary(completed) });
    }
    automatedInterrupts++;
  }

  return driverFailure('HOST_DRIVER_CYCLE_LIMIT', 'Agent Host driver exceeded maxCycles=' + maxCycles, {
    runId,
    state: inspectRun(cwd, runId).run.status,
  });
}
