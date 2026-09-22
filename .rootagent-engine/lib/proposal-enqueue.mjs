import { materializePlannerProposal } from './project-orchestration.mjs';
import { sha256 } from './trust-core.mjs';
import { projectAutomatedTask } from './task-md-projection.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }

// The caller holds the project lock. The graph and its idempotency record share
// one transactional tasks snapshot: no independent mapping write can race a crash.
export function enqueueApprovedProposal(cwd, digest, { loadTasks, saveTasks, initializeTaskTrust, source = null }) {
  if (!/^[a-f0-9]{64}$/.test(digest || '')) fail('INVALID_PROPOSAL_DIGEST', '需要完整的提案 SHA-256 摘要');
  if (source !== null && (typeof source !== 'object' || Array.isArray(source))) fail('INVALID_IMPROVEMENT_SOURCE', '优化来源必须是对象');
  const sourceCopy = clone(source);
  const sourceDigest = sha256(sourceCopy);
  const { plan } = materializePlannerProposal(cwd, digest);
  const data = clone(loadTasks(cwd));
  const prior = data.proposalEnqueues?.[digest];
  if (prior) {
    const unsigned = clone(prior); delete unsigned.digest;
    if (prior.digest !== sha256(unsigned)) fail('PROPOSAL_ENQUEUE_CORRUPT', '提案入队映射摘要失配');
    if (prior.sourceDigest !== sourceDigest) fail('PROPOSAL_SOURCE_CONFLICT', '同一提案不能绑定不同优化来源');
    const repair = (data.features || []).find(task => prior.taskIds.includes(task.id) && task.status !== 'completed');
    let projection = null;
    if (repair) {
      try { projection = projectAutomatedTask(cwd, repair, { onlyIfMissing: true }); }
      catch (error) { projection = { projected: false, reason: 'projection-failed', error: error.message }; }
    }
    return { ...clone(prior), duplicate: true, ...(projection ? { projection } : {}) };
  }
  const allTasks = [...(data.features || []), ...(data.archive || []).flatMap(round => round.features || [])];
  const reserved = [...allTasks.map(task => task.id), ...Object.values(data.proposalEnqueues || {}).flatMap(record => record.taskIds || [])];
  let sequence = Math.max(0, ...reserved.map(id => /^t\d+$/.test(id) ? Number(id.slice(1)) : 0));
  if (!Number.isSafeInteger(sequence + plan.tasks.length)) fail('TASK_ID_EXHAUSTED', '任务编号已超出安全整数范围');
  const idMap = Object.fromEntries(plan.tasks.map(task => [task.id, `t${String(++sequence).padStart(3, '0')}`]));
  const parentCriteriaById = new Map((plan.parentCriteria || []).map(item => [item.id, item]));
  const tasks = plan.tasks.map((task, index) => {
    const requirementIds = [...new Set((task.covers || []).flatMap(criterionId => parentCriteriaById.get(criterionId)?.requirements || []))].sort();
    const queued = {
      id: idMap[task.id], name: task.name || task.title || task.id,
      description: task.description || task.name || task.title || task.id,
      priority: (data.features || []).length + index + 1, status: 'pending',
      acceptanceCriteria: clone(task.acceptanceCriteria), validationCommands: clone(task.validationCommands),
      dependsOn: task.dependsOn.map(id => idMap[id]), parallelWith: (task.parallelWith || []).map(id => idMap[id]),
      writes: clone(task.writes), resources: clone(task.resources), artifacts: clone(task.artifacts),
      covers: clone(task.covers), risk: task.risk,
      requiresReview: !!task.requiresReview || ['high', 'critical'].includes(task.risk),
      parentId: null, retryCount: 0, blocked: false, validationHistory: [], attestations: [], commit: '',
      requirementCoverage: {
        requirementSourceDigest: plan.requirementSourceDigest || null,
        requirementIds,
      },
      proposalSource: { proposalDigest: digest, approvalDigest: plan.approvalDigest, proposalTaskId: task.id, approvalRole: 'reviewer' },
      ...(sourceCopy !== null ? { improvementSource: clone(sourceCopy) } : {}),
    };
    for (const field of ['setupCommands', 'referenceChecks', 'parallelRationale', 'hostPolicy']) {
      if (task[field] !== undefined) queued[field] = clone(task[field]);
    }
    initializeTaskTrust(queued);
    return queued;
  });
  const record = {
    schemaVersion: 1, proposalDigest: digest, approvalDigest: plan.approvalDigest,
    idMap, taskIds: tasks.map(task => task.id), source: sourceCopy, sourceDigest,
    enqueuedAt: new Date().toISOString(),
  };
  record.digest = sha256(record);
  data.features = [...(data.features || []), ...tasks];
  data.proposalEnqueues = { ...(data.proposalEnqueues || {}), [digest]: record };
  saveTasks(cwd, data);
  let projection = null;
  if (tasks[0]) {
    try { projection = projectAutomatedTask(cwd, tasks[0], { onlyIfMissing: true }); }
    catch (error) { projection = { projected: false, reason: 'projection-failed', error: error.message }; }
  }
  return { ...clone(record), duplicate: false, ...(projection ? { projection } : {}) };
}
