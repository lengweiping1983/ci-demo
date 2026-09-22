import fs from 'fs';
import path from 'path';
import { withProjectLock, atomicWriteJson, readJson } from './trust-core.mjs';
import { createRun, inspectRun } from './control-graph.mjs';
import { driveAgentHostRun } from './agent-host-runner.mjs';
import { listWorkspaces, createWorkspace, prepareWorkspaceRuntime, snapshotWorkspaceCandidate, buildContextPacket, listIntegrationQueue, loadCandidate } from './project-orchestration.mjs';
import { verifyImprovementCandidate } from './improvement.mjs';
import { requireThat, head, cleanProduct } from './improvement-evidence.mjs';
import { validateCheckerReport } from './security-core.mjs';

// Keep execution in the existing Attempt/Host/Candidate/Receipt pipeline.
export async function driveImprovementTasks(cwd, session, services) {
  let tasks = services.loadTasks(cwd).features;
  let task = tasks.find(t => session.current.taskIds.includes(t.id) && t.status === 'in_progress');
  if (!task) {
    const ready = tasks.find(t => session.current.taskIds.includes(t.id) && t.status === 'pending' && t.dependsOn.every(id => tasks.find(x => x.id === id)?.status === 'completed'));
    if (!ready) return { status: 'WAITING_TASKS' };
    const other = tasks.find(t => t.status === 'in_progress');
    if (other) return { status: 'WAITING_EXISTING_TASK', taskId: other.id };
    services.invoke('start', ['--task', ready.id]); task = services.loadTasks(cwd).features.find(t => t.id === ready.id);
  }
  let workspace = listWorkspaces(cwd).find(w => w.taskId === task.id && w.attemptId === task.attempt.attemptId && ['ACTIVE', 'INTEGRATED'].includes(w.status));
  if (!workspace) workspace = withProjectLock(cwd, () => createWorkspace(cwd, task, { workspaceId: `improve_${task.id}_${task.attempt.fencingToken}` }));
  if (workspace.runtimeStatus === 'REQUIRED') workspace = withProjectLock(cwd, () => prepareWorkspaceRuntime(cwd, workspace.workspaceId, { executeSetup: (cmd, dir) => services.execute(cmd, dir, true) })).workspace;
  const definition = JSON.parse(fs.readFileSync(path.join(services.engineRoot, 'assets/workflows/chat-development.json'), 'utf8'));
  definition.workflowId = 'improvement-development';
  definition.nodes[0].config.prompt = 'Implement this task ONLY in the supplied workspace. Run validation commands there and commit product files. Return {done:true,productCommit:<full hash>}. Do not change the target branch or control state. The fixed supervisor freezes and integrates the Candidate.';
  definition.nodes[0].config.executionRequirements.workspaceIsolation = 'required';
  definition.nodes[0].config.executionRequirements.rootAgentIsolation = 'WORKTREE_REQUIRED';
  definition.nodes[1].outputSchema.required = ['verdict', 'report'];
  definition.nodes[1].config.prompt = 'Independently verify every acceptance criterion against the frozen integrated Candidate. Do not edit code. Return {verdict:"PASS"|"FAIL",report:{taskId,contractDigest,candidateDigest,criteria:[{index,verdict,evidence:[string],confidence,limitations:[]}]}}. Record actual commands and outputs; same-chat execution MUST declare no physical/independent context isolation. RootAgent will attest and issue the Receipt. Never approve your own work.';
  for (const n of definition.nodes) if (n.config?.executionRequirements) n.config.executionRequirements.physicalAgentIsolation = session.authorization.requirePhysicalIsolation ? 'required' : 'preferred';
  const runId = `improve_dev_${task.id}_${task.attempt.attemptId}`;
  withProjectLock(cwd, () => createRun(cwd, definition, { taskId: task.id }, { runId }));
  const result = await driveAgentHostRun(cwd, runId, services.runtime, { wait: false,
    resolveExecutionContext({ interrupt }) {
      let current = services.loadTasks(cwd).features.find(t => t.id === task.id);
      if (interrupt.payload.contextRole === 'checker') {
        try {
          const maker = inspectRun(cwd, runId).run.state.nodes.maker;
          requireThat(maker?.done === true, 'IMPROVE_MAKER_INCOMPLETE', 'Maker did not complete');
          const active = listWorkspaces(cwd).find(w => w.workspaceId === workspace.workspaceId);
          if (active.status !== 'INTEGRATED') {
            const candidate = withProjectLock(cwd, () => {
              cleanProduct(active.path);
              requireThat(head(active.path) === maker.productCommit, 'IMPROVE_MAKER_COMMIT_MISMATCH', 'Workspace changed after Maker response');
              const pointer = path.join(cwd, '.rootagent', 'runtime', 'improvement-development', runId + '.json');
              const previous = readJson(pointer);
              if (previous && previous.headCommit === maker.productCommit) {
                const frozen = loadCandidate(cwd, previous.digest);
                if (frozen.workspaceId === active.workspaceId && frozen.attemptId === current.attempt.attemptId && frozen.fencingToken === current.attempt.fencingToken) return frozen;
              }
              const frozen = snapshotWorkspaceCandidate(cwd, active.workspaceId, current);
              atomicWriteJson(pointer, { digest: frozen.digest, headCommit: frozen.headCommit });
              return frozen;
            });
            requireThat(maker.productCommit === candidate.headCommit, 'IMPROVE_MAKER_COMMIT_MISMATCH', 'Maker output commit differs from workspace');
            services.invoke('integrate', ['enqueue', candidate.digest]);
            const entry = listIntegrationQueue(cwd).entries.find(e => e.candidateDigest === candidate.digest);
            services.invoke('integrate', ['apply', entry.entryId]);
          }
          if (!current.candidate) { services.invoke('validate', [task.id]); current = services.loadTasks(cwd).features.find(t => t.id === task.id); }
          if (task.id === session.current.finalTaskId) withProjectLock(cwd, () => verifyImprovementCandidate(cwd, session.sessionId, current, services));
        } catch (error) { return { ok: false, code: error.code || 'IMPROVE_PRECHECK_FAILED', reason: error.message, taskId: task.id, ...(error.data || {}) }; }
      }
      const subject = { taskId: current.id, contractDigest: current.contractDigest, attemptId: current.attempt.attemptId, fencingToken: current.attempt.fencingToken };
      const packet = buildContextPacket(cwd, interrupt.payload.contextRole, { contract: current, candidate: current.candidate || null, base: { ...subject, commit: current.attempt.baseCommit }, budget: { maxElapsedMs: session.maxElapsedMs } });
      return { ok: true, subject, contextPacket: packet, contextPacketDigest: packet.digest };
    },
  });
  if (result.code !== 'HOST_RUN_COMPLETED') return result;
  const checkerOutput = inspectRun(cwd, runId).run.state.nodes.checker;
  const currentTask = services.loadTasks(cwd).features.find(t => t.id === task.id);
  requireThat(currentTask, 'IMPROVE_TASK_MISSING', 'Checker task disappeared before local precheck');
  const checkedReport = validateCheckerReport(checkerOutput?.report, currentTask);
  const reportErrors = [...checkedReport.errors];
  if (checkedReport.ok && checkerOutput?.verdict !== checkedReport.report.verdict) reportErrors.push(`checker verdict ${checkerOutput?.verdict || '(missing)'} does not match report verdict ${checkedReport.report.verdict}`);
  requireThat(checkedReport.ok && !reportErrors.length && checkedReport.report.verdict === 'PASS', 'IMPROVE_CHECKER_REPORT_INVALID', `Checker report local precheck failed: ${reportErrors.join('; ') || `report verdict=${checkedReport.report?.verdict || '(missing)'}`}`, { errors: reportErrors.length ? reportErrors : [`report verdict=${checkedReport.report?.verdict || '(missing)'}`] });
  const report = checkedReport.report;
  services.invoke('host', ['reconcile', 'run', runId, task.id]);
  services.invoke('host', ['verify', task.id]);
  const reportFile = path.join(cwd, '.rootagent', 'runtime', 'improvement-checker-' + task.id + '.json');
  atomicWriteJson(reportFile, report);
  services.invoke('attest', ['checker', task.id, '--report', reportFile]);
  {
    const current = services.loadTasks(cwd).features.find(t => t.id === task.id);
    if (current.requiresReview && !current.approval) return { status: 'WAITING_APPROVAL', taskId: task.id, candidateDigest: current.candidate?.digest };
  }
  services.invoke('pass', [task.id]);
  return { status: 'TASK_COMPLETED', taskId: task.id, runId };
}
