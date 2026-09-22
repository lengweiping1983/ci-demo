import { sha256 } from './trust-core.mjs';

export const HOST_PROFILES = Object.freeze([
  'NATIVE_MULTI_AGENT',
  'SINGLE_AGENT_ROLE_ISOLATION',
  'EXTERNAL_WORKER',
  'SUPERVISOR_ONLY',
]);

export const HOST_CAPABILITY_ASSURANCE_LEVELS = Object.freeze([
  'DECLARED',
  'RUNTIME_OBSERVED',
]);

const ISOLATION = new Set(['none', 'preferred', 'required']);
const ROOTAGENT_ISOLATION = new Set(['LIGHTWEIGHT', 'WORKTREE_REQUIRED', 'SERIAL_REQUIRED']);
const CAPABILITY_ASSURANCE = new Set(HOST_CAPABILITY_ASSURANCE_LEVELS);
const ASSURANCE_RANK = Object.freeze({ DECLARED: 0, RUNTIME_OBSERVED: 1 });
export const HOST_EXECUTION_ROLES = Object.freeze(['maker', 'checker', 'reviewer', 'integrator', 'planner']);

function callable(value) { return typeof value === 'function'; }
function capability(value) { return value === true || callable(value); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function positiveInt(value, fallback = 1) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
function normalizeIsolation(value, fallback) {
  return ISOLATION.has(value) ? value : fallback;
}
function normalizeExecutionCaps(source = {}) {
  return {
    commandExecution: !!source.commandExecution,
    filesystemRead: !!source.filesystemRead,
    filesystemWrite: !!source.filesystemWrite,
    git: !!source.git,
    worktree: !!source.worktree,
    processIsolation: !!source.processIsolation,
    network: !!source.network,
  };
}

function discoverExternalWorker(worker, index) {
  const driver = worker?.driver || {};
  const capabilities = worker?.capabilities || {};
  const execution = normalizeExecutionCaps(capabilities.execution || {});
  const canExecuteRole = callable(driver.executeRole) || callable(worker?.executeRole);
  return {
    id: String(worker?.id || ('worker-' + (index + 1))),
    trusted: worker?.trusted === true,
    canExecuteRole,
    freshContext: capabilities.freshContext === true,
    independentContext: capabilities.independentContext !== false,
    physicalIsolation: capabilities.physicalIsolation !== false,
    parallel: capabilities.parallel === true,
    maxWorkers: positiveInt(capabilities.maxWorkers, 1),
    execution,
  };
}

export function discoverAgentHostCapabilities(runtime = {}) {
  const native = runtime.nativeSubagents || {};
  const nativeSubagents = [
    native.createSubagent,
    native.sendInput,
    native.wait,
    native.resume,
    native.close,
  ].every(callable);

  const roleIsolation = runtime.roleIsolation || {};
  const sameAgentRoleIsolation = callable(roleIsolation.executeRole) || callable(runtime.executeRole);

  const filesystem = runtime.filesystem || {};
  const git = runtime.git || {};
  const execution = {
    commandExecution: callable(runtime.executeCommand),
    filesystemRead: capability(filesystem.read),
    filesystemWrite: capability(filesystem.write),
    git: capability(git.available) || callable(git.status) || callable(git.commit),
    worktree: capability(git.worktree),
    processIsolation: capability(runtime.processIsolation),
    network: capability(runtime.network),
  };

  const discovered = {
    schemaVersion: 1,
    discovery: {
      method: 'runtime-binding-inspection',
      observer: 'agent-host',
    },
    agent: {
      nativeSubagents,
      freshSubagentContext: nativeSubagents && native.freshContext !== false,
      independentSubagentContext: nativeSubagents && native.independentContext !== false,
      parallel: nativeSubagents && native.parallel === true,
      maxWorkers: nativeSubagents ? positiveInt(native.maxWorkers, native.parallel === true ? 2 : 1) : 1,
      sameAgentRoleIsolation,
      sameAgentFreshContext: sameAgentRoleIsolation && roleIsolation.freshContext === true,
    },
    execution,
    persistence: {
      durableSession: capability(runtime.persistence?.durableSession),
      resumeSession: capability(runtime.persistence?.resumeSession),
      persistentFiles: capability(runtime.persistence?.persistentFiles),
    },
    interaction: {
      humanApproval: capability(runtime.humanApproval),
      notifications: capability(runtime.notifications),
    },
    externalWorkers: (runtime.externalWorkers || []).map(discoverExternalWorker),
  };
  discovered.digest = sha256(discovered);
  return discovered;
}


function capabilityClaims(snapshot) {
  return {
    agent: clone(snapshot?.agent || {}),
    execution: clone(snapshot?.execution || {}),
    persistence: clone(snapshot?.persistence || {}),
    interaction: clone(snapshot?.interaction || {}),
    externalWorkers: clone(snapshot?.externalWorkers || []),
  };
}

export function verifyAgentHostCapabilities(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { ok: false, errors: [{ code: 'HOST_CAPABILITY_SNAPSHOT_INVALID' }] };
  }
  const claimed = snapshot.digest;
  const unsigned = clone(snapshot);
  delete unsigned.digest;
  const errors = [];
  if (!claimed || claimed !== sha256(unsigned)) errors.push({ code: 'HOST_CAPABILITY_DIGEST_INVALID' });
  return { ok: errors.length === 0, errors, snapshot: clone(snapshot) };
}

export function createHostCapabilityEvidence(hostCapabilities, options = {}) {
  const checked = verifyAgentHostCapabilities(hostCapabilities);
  if (!checked.ok) {
    const error = new Error('host capability snapshot digest invalid');
    error.code = 'HOST_CAPABILITY_SNAPSHOT_INVALID';
    error.data = { errors: checked.errors };
    throw error;
  }
  const assurance = String(options.assurance || 'DECLARED');
  if (!CAPABILITY_ASSURANCE.has(assurance)) {
    const error = new Error('unsupported host capability assurance');
    error.code = 'HOST_CAPABILITY_ASSURANCE_INVALID';
    throw error;
  }
  if (assurance === 'RUNTIME_OBSERVED' && hostCapabilities.discovery?.method !== 'runtime-binding-inspection') {
    const error = new Error('RUNTIME_OBSERVED requires runtime-binding-inspection discovery');
    error.code = 'HOST_CAPABILITY_ASSURANCE_INVALID';
    throw error;
  }
  const subject = options.subject || {};
  const claims = capabilityClaims(hostCapabilities);
  const evidence = {
    schemaVersion: 1,
    capabilityDigest: hostCapabilities.digest,
    claimsDigest: sha256(claims),
    assurance,
    source: {
      kind: options.source?.kind || (assurance === 'RUNTIME_OBSERVED' ? 'runtime-discovery' : 'host-declaration'),
      hostInstanceId: options.source?.hostInstanceId || null,
      sessionId: options.source?.sessionId || null,
    },
    subject: {
      taskId: subject.taskId || null,
      contractDigest: subject.contractDigest || null,
      attemptId: subject.attemptId || null,
      fencingToken: subject.fencingToken ?? null,
    },
    capabilities: clone(hostCapabilities),
    observedAt: options.observedAt || new Date().toISOString(),
    caveat: assurance === 'RUNTIME_OBSERVED'
      ? 'Observed by Agent Host from runtime bindings; not an independent RootAgent or cryptographic proof.'
      : 'Declared by Agent Host; not independently verified.',
  };
  evidence.digest = sha256(evidence);
  return evidence;
}

export function verifyHostCapabilityEvidence(input) {
  const evidence = clone(input || {});
  const errors = [];
  const claimed = evidence.digest;
  delete evidence.digest;
  if (!claimed || claimed !== sha256(evidence)) errors.push({ code: 'HOST_CAPABILITY_EVIDENCE_DIGEST_INVALID' });
  if (!CAPABILITY_ASSURANCE.has(evidence.assurance)) errors.push({ code: 'HOST_CAPABILITY_ASSURANCE_INVALID' });
  const snapshot = verifyAgentHostCapabilities(evidence.capabilities);
  if (!snapshot.ok) errors.push(...snapshot.errors);
  if (snapshot.ok && evidence.capabilityDigest !== evidence.capabilities.digest) errors.push({ code: 'HOST_CAPABILITY_SUBJECT_MISMATCH' });
  if (snapshot.ok && evidence.claimsDigest !== sha256(capabilityClaims(evidence.capabilities))) errors.push({ code: 'HOST_CAPABILITY_CLAIMS_DIGEST_INVALID' });
  if (evidence.assurance === 'RUNTIME_OBSERVED' && evidence.capabilities?.discovery?.method !== 'runtime-binding-inspection') {
    errors.push({ code: 'HOST_CAPABILITY_ASSURANCE_INVALID' });
  }
  return { ok: errors.length === 0, errors, evidence: { ...evidence, digest: claimed } };
}

function assuranceAtLeast(actual, minimum) {
  return Number.isInteger(ASSURANCE_RANK[actual]) && Number.isInteger(ASSURANCE_RANK[minimum])
    && ASSURANCE_RANK[actual] >= ASSURANCE_RANK[minimum];
}

export function normalizeExecutionRequirements(input = {}) {
  const rootAgentIsolation = ROOTAGENT_ISOLATION.has(input.rootAgentIsolation)
    ? input.rootAgentIsolation
    : 'LIGHTWEIGHT';
  const workspaceIsolation = rootAgentIsolation === 'WORKTREE_REQUIRED'
    ? 'required'
    : normalizeIsolation(input.workspaceIsolation, 'none');
  return {
    schemaVersion: 1,
    freshContext: input.freshContext === true,
    independentContext: normalizeIsolation(input.independentContext, 'none'),
    physicalAgentIsolation: normalizeIsolation(input.physicalAgentIsolation, 'none'),
    workspaceIsolation,
    rootAgentIsolation,
    parallelSafe: rootAgentIsolation === 'SERIAL_REQUIRED' ? false : input.parallelSafe === true,
    maxConcurrency: positiveInt(input.maxConcurrency, 1),
    requiredCapabilities: {
      commandExecution: input.requiredCapabilities?.commandExecution === true,
      filesystemRead: input.requiredCapabilities?.filesystemRead === true,
      filesystemWrite: input.requiredCapabilities?.filesystemWrite === true,
      git: input.requiredCapabilities?.git === true,
      worktree: input.requiredCapabilities?.worktree === true || workspaceIsolation === 'required',
      processIsolation: input.requiredCapabilities?.processIsolation === true,
      network: input.requiredCapabilities?.network === true,
      humanApproval: input.requiredCapabilities?.humanApproval === true,
    },
  };
}

export function validateExecutionRequirements(input = {}) {
  const errors = [];
  for (const key of ['independentContext', 'physicalAgentIsolation', 'workspaceIsolation']) {
    if (input[key] != null && !ISOLATION.has(input[key])) errors.push({ code: 'INVALID_ISOLATION_REQUIREMENT', field: key });
  }
  if (input.rootAgentIsolation != null && !ROOTAGENT_ISOLATION.has(input.rootAgentIsolation)) {
    errors.push({ code: 'INVALID_ROOTAGENT_ISOLATION', field: 'rootAgentIsolation' });
  }
  if (input.maxConcurrency != null && (!Number.isInteger(input.maxConcurrency) || input.maxConcurrency < 1)) {
    errors.push({ code: 'INVALID_MAX_CONCURRENCY', field: 'maxConcurrency' });
  }
  for (const key of ['freshContext', 'parallelSafe']) {
    if (input[key] != null && typeof input[key] !== 'boolean') errors.push({ code: 'INVALID_EXECUTION_REQUIREMENT', field: key });
  }
  for (const [key, value] of Object.entries(input.requiredCapabilities || {})) {
    if (typeof value !== 'boolean') errors.push({ code: 'INVALID_REQUIRED_CAPABILITY', field: key });
  }
  return { ok: errors.length === 0, errors, requirements: normalizeExecutionRequirements(input) };
}

function candidateFromHost(strategy, host, worker = null) {
  if (strategy === 'NATIVE_MULTI_AGENT') {
    return {
      strategy,
      workerId: null,
      physicalIsolation: true,
      independentContext: host.agent.independentSubagentContext,
      freshContext: host.agent.freshSubagentContext,
      maxWorkers: host.agent.maxWorkers,
      execution: host.execution,
      humanApproval: host.interaction.humanApproval,
    };
  }
  if (strategy === 'SINGLE_AGENT_ROLE_ISOLATION') {
    return {
      strategy,
      workerId: null,
      physicalIsolation: false,
      independentContext: false,
      freshContext: host.agent.sameAgentFreshContext,
      maxWorkers: 1,
      execution: host.execution,
      humanApproval: host.interaction.humanApproval,
    };
  }
  if (strategy === 'EXTERNAL_WORKER') {
    return {
      strategy,
      workerId: worker.id,
      physicalIsolation: worker.physicalIsolation,
      independentContext: worker.independentContext,
      freshContext: worker.freshContext,
      maxWorkers: worker.maxWorkers,
      execution: worker.execution,
      humanApproval: false,
    };
  }
  return null;
}

function assess(candidate, requirements) {
  const missing = [];
  const degradations = [];
  if (!candidate) return { ok: false, missing: ['roleExecution'], degradations };

  if (requirements.freshContext && !candidate.freshContext) missing.push('freshContext');
  for (const [field, actual] of [
    ['independentContext', candidate.independentContext],
    ['physicalAgentIsolation', candidate.physicalIsolation],
    ['workspaceIsolation', candidate.execution.worktree],
  ]) {
    const required = requirements[field];
    if (required === 'required' && !actual) missing.push(field);
    else if (required === 'preferred' && !actual) degradations.push(field);
  }
  for (const [name, needed] of Object.entries(requirements.requiredCapabilities)) {
    if (!needed) continue;
    if (name === 'humanApproval') {
      if (!candidate.humanApproval) missing.push(name);
    } else if (!candidate.execution[name]) missing.push(name);
  }
  return { ok: missing.length === 0, missing, degradations };
}

function concurrency(candidate, requirements) {
  if (requirements.rootAgentIsolation === 'SERIAL_REQUIRED' || !requirements.parallelSafe) return 1;
  return Math.max(1, Math.min(candidate.maxWorkers || 1, requirements.maxConcurrency || 1));
}


export function validateHostPolicy(input) {
  if (input == null) return { ok: true, errors: [], policy: null };
  const errors = [];
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [{ code: 'INVALID_HOST_POLICY', field: 'policy' }], policy: null };
  }
  if (input.schemaVersion != null && input.schemaVersion !== 1) {
    errors.push({ code: 'INVALID_HOST_POLICY_VERSION', field: 'schemaVersion' });
  }
  const allowed = new Set(HOST_EXECUTION_ROLES);
  const requiredRoles = Array.isArray(input.requiredRoles) ? [...new Set(input.requiredRoles.map(String))] : [];
  if (input.requiredRoles != null && !Array.isArray(input.requiredRoles)) {
    errors.push({ code: 'INVALID_HOST_POLICY_ROLES', field: 'requiredRoles' });
  }
  for (const role of requiredRoles) {
    if (!allowed.has(role)) errors.push({ code: 'INVALID_HOST_POLICY_ROLE', field: 'requiredRoles', role });
  }
  if (input.requireDistinctExecutionIds != null && typeof input.requireDistinctExecutionIds !== 'boolean') {
    errors.push({ code: 'INVALID_HOST_POLICY_DISTINCT_IDS', field: 'requireDistinctExecutionIds' });
  }

  let capabilityEvidence;
  if (input.capabilityEvidence !== undefined) {
    if (!input.capabilityEvidence || typeof input.capabilityEvidence !== 'object' || Array.isArray(input.capabilityEvidence)) {
      errors.push({ code: 'INVALID_HOST_CAPABILITY_EVIDENCE_POLICY', field: 'capabilityEvidence' });
    } else {
      const minimumAssurance = String(input.capabilityEvidence.minimumAssurance || 'DECLARED');
      if (!CAPABILITY_ASSURANCE.has(minimumAssurance)) {
        errors.push({ code: 'INVALID_HOST_CAPABILITY_ASSURANCE', field: 'capabilityEvidence.minimumAssurance' });
      } else {
        capabilityEvidence = {
          required: input.capabilityEvidence.required === true,
          minimumAssurance,
        };
      }
    }
  }

  const roleRequirements = {};
  if (input.roleRequirements != null && (typeof input.roleRequirements !== 'object' || Array.isArray(input.roleRequirements))) {
    errors.push({ code: 'INVALID_HOST_POLICY_REQUIREMENTS', field: 'roleRequirements' });
  } else {
    for (const [role, value] of Object.entries(input.roleRequirements || {})) {
      if (!allowed.has(role)) {
        errors.push({ code: 'INVALID_HOST_POLICY_ROLE', field: 'roleRequirements', role });
        continue;
      }
      const checked = validateExecutionRequirements(value || {});
      if (!checked.ok) {
        for (const problem of checked.errors) errors.push({ ...problem, role });
        continue;
      }
      roleRequirements[role] = checked.requirements;
    }
  }

  for (const role of Object.keys(roleRequirements)) {
    if (!requiredRoles.includes(role)) requiredRoles.push(role);
  }

  const policy = {
    schemaVersion: 1,
    requiredRoles,
    requireDistinctExecutionIds: input.requireDistinctExecutionIds === true,
    roleRequirements,
    ...(capabilityEvidence !== undefined ? { capabilityEvidence } : {}),
  };
  policy.digest = sha256(policy);
  return { ok: errors.length === 0, errors, policy };
}

function isolationSatisfied(required, actual) {
  if (required === 'required') return actual === true;
  return true;
}

function requirementsSatisfied(record, required) {
  const missing = [];
  const declared = record?.executionRequirements || {};
  if (required.freshContext && record?.freshContext !== true) missing.push('freshContext');
  if (!isolationSatisfied(required.independentContext, record?.independentContext)) missing.push('independentContext');
  if (!isolationSatisfied(required.physicalAgentIsolation, record?.physicalIsolation)) missing.push('physicalAgentIsolation');

  if (required.workspaceIsolation === 'required') {
    if (
      declared.workspaceIsolation !== 'required'
      || declared.requiredCapabilities?.worktree !== true
      || !record?.workspaceId
      || !record?.workspaceBindingDigest
    ) missing.push('workspaceIsolation');
  }
  if (required.rootAgentIsolation === 'WORKTREE_REQUIRED') {
    if (declared.rootAgentIsolation !== 'WORKTREE_REQUIRED') missing.push('rootAgentIsolation');
  } else if (required.rootAgentIsolation === 'SERIAL_REQUIRED') {
    if (declared.rootAgentIsolation !== 'SERIAL_REQUIRED' || Number(record?.actualConcurrency || 1) !== 1) missing.push('rootAgentIsolation');
  }

  if (Number.isInteger(required.maxConcurrency) && Number(record?.actualConcurrency || 1) > required.maxConcurrency) {
    missing.push('maxConcurrency');
  }
  for (const [name, needed] of Object.entries(required.requiredCapabilities || {})) {
    if (needed && declared.requiredCapabilities?.[name] !== true) missing.push('requiredCapabilities.' + name);
  }
  return { ok: missing.length === 0, missing };
}

export function verifyHostPolicyProvenance(policyInput, records = [], capabilityEvidence = []) {
  const checked = validateHostPolicy(policyInput);
  if (!checked.ok) return { ok: false, code: 'INVALID_HOST_POLICY', errors: checked.errors, policy: null };
  if (!checked.policy) return { ok: true, code: 'HOST_POLICY_NOT_REQUIRED', errors: [], policy: null, records: [] };

  const base = verifyExecutionProvenance(records);
  const errors = [...base.errors];
  const byRole = new Map(base.records.map(record => [record.role, record]));
  const evidenceByDigest = new Map();
  for (const input of capabilityEvidence || []) {
    const checkedEvidence = verifyHostCapabilityEvidence(input);
    if (!checkedEvidence.ok) {
      errors.push(...checkedEvidence.errors);
      continue;
    }
    evidenceByDigest.set(checkedEvidence.evidence.digest, checkedEvidence.evidence);
  }

  for (const role of checked.policy.requiredRoles) {
    const record = byRole.get(role);
    if (!record) {
      errors.push({ code: 'HOST_REQUIRED_ROLE_MISSING', role });
      continue;
    }
    const required = checked.policy.roleRequirements[role];
    if (required) {
      const assessed = requirementsSatisfied(record, required);
      if (!assessed.ok) errors.push({ code: 'HOST_ROLE_REQUIREMENTS_UNSATISFIED', role, missing: assessed.missing });
    }
    if (checked.policy.capabilityEvidence?.required) {
      if (!record.capabilityEvidenceDigest) {
        errors.push({ code: 'HOST_CAPABILITY_EVIDENCE_MISSING', role });
      } else {
        const evidence = evidenceByDigest.get(record.capabilityEvidenceDigest);
        if (!evidence) {
          errors.push({ code: 'HOST_CAPABILITY_EVIDENCE_UNKNOWN', role, capabilityEvidenceDigest: record.capabilityEvidenceDigest });
        } else {
          if (evidence.capabilityDigest !== record.hostCapabilityDigest) {
            errors.push({ code: 'HOST_CAPABILITY_EVIDENCE_CAPABILITY_MISMATCH', role });
          }
          if (!assuranceAtLeast(evidence.assurance, checked.policy.capabilityEvidence.minimumAssurance)) {
            errors.push({
              code: 'HOST_CAPABILITY_ASSURANCE_INSUFFICIENT',
              role,
              required: checked.policy.capabilityEvidence.minimumAssurance,
              actual: evidence.assurance,
            });
          }
        }
      }
    }
  }

  if (checked.policy.requireDistinctExecutionIds) {
    const ids = new Map();
    for (const role of checked.policy.requiredRoles) {
      const record = byRole.get(role);
      if (!record) continue;
      const previous = ids.get(record.executionId);
      if (previous) errors.push({ code: 'HOST_EXECUTION_ID_REUSED', roles: [previous, role], executionId: record.executionId });
      else ids.set(record.executionId, role);
    }
  }

  return {
    ok: errors.length === 0,
    code: errors.length ? 'HOST_POLICY_UNSATISFIED' : 'HOST_POLICY_SATISFIED',
    errors,
    policy: checked.policy,
    records: base.records,
  };
}

export function resolveAgentHostStrategy(hostCapabilities, requirementInput = {}) {
  const checked = validateExecutionRequirements(requirementInput);
  if (!checked.ok) {
    return {
      ok: false,
      code: 'INVALID_EXECUTION_REQUIREMENTS',
      errors: checked.errors,
      strategy: 'SUPERVISOR_ONLY',
    };
  }
  const host = clone(hostCapabilities);
  const requirements = checked.requirements;
  const tried = [];

  const options = [];
  if (host?.agent?.nativeSubagents) options.push(candidateFromHost('NATIVE_MULTI_AGENT', host));
  if (host?.agent?.sameAgentRoleIsolation) options.push(candidateFromHost('SINGLE_AGENT_ROLE_ISOLATION', host));
  for (const worker of host?.externalWorkers || []) {
    if (worker.trusted && worker.canExecuteRole) options.push(candidateFromHost('EXTERNAL_WORKER', host, worker));
  }

  for (const candidate of options) {
    const assessment = assess(candidate, requirements);
    tried.push({ strategy: candidate.strategy, workerId: candidate.workerId, ...assessment });
    if (!assessment.ok) continue;
    return {
      ok: true,
      code: 'HOST_STRATEGY_SELECTED',
      strategy: candidate.strategy,
      workerId: candidate.workerId,
      physicalIsolation: candidate.physicalIsolation,
      independentContext: candidate.independentContext,
      freshContext: candidate.freshContext,
      degradations: assessment.degradations,
      actualConcurrency: concurrency(candidate, requirements),
      requirements,
      hostCapabilityDigest: host.digest || sha256(host),
    };
  }

  return {
    ok: false,
    code: 'HOST_CAPABILITY_UNSATISFIED',
    strategy: 'SUPERVISOR_ONLY',
    requirements,
    tried,
    hostCapabilityDigest: host?.digest || sha256(host || {}),
  };
}

export function createExecutionProvenance(input) {
  if (!input?.resolution?.ok) {
    const error = new Error('cannot create provenance for unresolved host strategy');
    error.code = 'HOST_CAPABILITY_UNSATISFIED';
    throw error;
  }
  if (!input.executionId || !input.role) {
    const error = new Error('execution provenance requires executionId and role');
    error.code = 'INVALID_EXECUTION_PROVENANCE';
    throw error;
  }
  const subject = input.subject || {};
  const record = {
    schemaVersion: 1,
    strategy: input.resolution.strategy,
    workerId: input.resolution.workerId || null,
    role: String(input.role),
    executionId: String(input.executionId),
    parentExecutionId: input.parentExecutionId ? String(input.parentExecutionId) : null,
    contextPacketDigest: input.contextPacketDigest || null,
    subject: {
      taskId: subject.taskId || null,
      attemptId: subject.attemptId || null,
      fencingToken: subject.fencingToken ?? null,
      candidateDigest: subject.candidateDigest || null,
      contractDigest: subject.contractDigest || null,
    },
    hostCapabilityDigest: input.resolution.hostCapabilityDigest,
    capabilityEvidenceDigest: input.capabilityEvidenceDigest || null,
    workspaceId: input.workspaceId || null,
    workspaceBindingDigest: input.workspaceBindingDigest || null,
    physicalIsolation: !!input.resolution.physicalIsolation,
    independentContext: !!input.resolution.independentContext,
    freshContext: !!input.resolution.freshContext,
    executionRequirements: clone(input.resolution.requirements || normalizeExecutionRequirements({})),
    actualConcurrency: positiveInt(input.resolution.actualConcurrency, 1),
    degradations: clone(input.resolution.degradations || []),
    createdAt: input.createdAt || new Date().toISOString(),
  };
  record.digest = sha256(record);
  return record;
}

export function verifyExecutionProvenance(records = [], options = {}) {
  const errors = [];
  const verified = [];
  for (const record of records) {
    const claimed = record?.digest;
    const unsigned = { ...record };
    delete unsigned.digest;
    if (!claimed || claimed !== sha256(unsigned)) errors.push({ code: 'PROVENANCE_DIGEST_INVALID', role: record?.role || null });
    else verified.push(record);
  }
  const byRole = new Map(verified.map(record => [record.role, record]));
  const maker = byRole.get('maker');
  const checker = byRole.get('checker');
  if (maker && checker && maker.executionId === checker.executionId) {
    if (maker.physicalIsolation || checker.physicalIsolation || maker.independentContext || checker.independentContext) {
      errors.push({ code: 'PROVENANCE_ISOLATION_CONTRADICTION', executionId: maker.executionId });
    }
    if (options.requireMakerCheckerIsolation === true) {
      errors.push({ code: 'MAKER_CHECKER_NOT_ISOLATED', executionId: maker.executionId });
    }
  }
  if (options.requireMakerCheckerIsolation === true && maker && checker) {
    if (!maker.physicalIsolation || !checker.physicalIsolation || !maker.independentContext || !checker.independentContext) {
      errors.push({ code: 'MAKER_CHECKER_NOT_ISOLATED', maker: maker.executionId, checker: checker.executionId });
    }
  }
  return { ok: errors.length === 0, errors, records: verified };
}


const ROOT_AUTHORITY_ACTIONS = new Set([
  'pass',
  'accept',
  'auditseal',
  'trustgrant',
  'createreceipt',
  'approve',
  'approveown',
  'modifyrootagentstate',
]);
const BROKER_SCHEMA_TYPES = new Set(['any', 'object', 'array', 'string', 'number', 'boolean', 'null']);

function normalizedAuthorityAction(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function validBrokerSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  const type = schema.type || 'any';
  if (!BROKER_SCHEMA_TYPES.has(type)) return false;
  if (type === 'object') {
    if (schema.required != null && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string'))) return false;
    if (schema.properties != null && (typeof schema.properties !== 'object' || Array.isArray(schema.properties))) return false;
    return Object.values(schema.properties || {}).every(validBrokerSchema);
  }
  if (type === 'array' && schema.items != null) return validBrokerSchema(schema.items);
  return true;
}

function brokerFailure(code, reason, data = {}) {
  return { ok: false, code, reason, ...data };
}

function resultSchemaType(schema) { return schema?.type || 'any'; }
function resultRuntimeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
export function resultMatchesSchema(value, schema) {
  const type = resultSchemaType(schema);
  if (type === 'any') return true;
  if (resultRuntimeType(value) !== type) return false;
  if (type === 'object') {
    if ((schema.required || []).some(key => !Object.hasOwn(value, key))) return false;
    return Object.entries(schema.properties || {}).every(([key, child]) => !Object.hasOwn(value, key) || resultMatchesSchema(value[key], child));
  }
  if (type === 'array' && schema.items) return value.every(item => resultMatchesSchema(item, schema.items));
  return true;
}

function normalizeBrokerPayload(input) {
  return input?.payload && typeof input.payload === 'object' ? clone(input.payload) : clone(input || {});
}

export function validateAgentHostInterrupt(input) {
  const payload = normalizeBrokerPayload(input);
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, errors: [{ code: 'HOST_INTERRUPT_INVALID' }], payload: null };
  }
  if (payload.hostContractVersion != null && payload.hostContractVersion !== 1) {
    errors.push({ code: 'HOST_CONTRACT_VERSION_UNSUPPORTED' });
  }
  if (payload.role === 'approval' || input?.kind === 'APPROVAL') {
    errors.push({ code: 'HUMAN_APPROVAL_REQUIRED' });
  } else if (!HOST_EXECUTION_ROLES.includes(payload.role)) {
    errors.push({ code: 'HOST_ROLE_UNSUPPORTED', role: payload.role || null });
  }
  if (!payload.taskId || typeof payload.taskId !== 'string') errors.push({ code: 'HOST_TASK_ID_REQUIRED' });
  if (payload.contextRole != null && typeof payload.contextRole !== 'string') errors.push({ code: 'HOST_CONTEXT_ROLE_INVALID' });
  if (!Array.isArray(payload.allowedActions)) errors.push({ code: 'HOST_ALLOWED_ACTIONS_INVALID' });
  else {
    for (const action of payload.allowedActions) {
      if (typeof action !== 'string' || !action) errors.push({ code: 'HOST_ALLOWED_ACTIONS_INVALID' });
      if (ROOT_AUTHORITY_ACTIONS.has(normalizedAuthorityAction(action))) errors.push({ code: 'HOST_AUTHORITY_ACTION_FORBIDDEN', action });
    }
  }
  if (!payload.resultSchema || typeof payload.resultSchema !== 'object' || Array.isArray(payload.resultSchema)) {
    errors.push({ code: 'HOST_RESULT_SCHEMA_REQUIRED' });
  } else if (!validBrokerSchema(payload.resultSchema)) {
    errors.push({ code: 'HOST_RESULT_SCHEMA_INVALID' });
  }
  const requirements = validateExecutionRequirements(payload.executionRequirements || {});
  if (!requirements.ok) errors.push(...requirements.errors);
  return {
    ok: errors.length === 0,
    errors,
    payload: {
      ...payload,
      executionRequirements: requirements.requirements,
      allowedActions: Array.isArray(payload.allowedActions) ? [...payload.allowedActions] : [],
    },
  };
}

export function planAgentHostExecution(interrupt, runtime = {}) {
  const checked = validateAgentHostInterrupt(interrupt);
  if (!checked.ok) {
    const approval = checked.errors.find(error => error.code === 'HUMAN_APPROVAL_REQUIRED');
    return brokerFailure(approval ? 'HUMAN_APPROVAL_REQUIRED' : 'HOST_INTERRUPT_INVALID', 'Agent Host interrupt contract invalid', {
      errors: checked.errors,
    });
  }
  const capabilities = discoverAgentHostCapabilities(runtime);
  const resolution = resolveAgentHostStrategy(capabilities, checked.payload.executionRequirements);
  if (!resolution.ok) {
    return brokerFailure(resolution.code || 'HOST_CAPABILITY_UNSATISFIED', 'Current runtime cannot satisfy RootAgent execution requirements', {
      payload: checked.payload,
      capabilities,
      resolution,
    });
  }
  return {
    ok: true,
    code: 'HOST_EXECUTION_PLANNED',
    payload: checked.payload,
    capabilities,
    resolution,
  };
}

function brokerSubject(payload, subject = {}) {
  return {
    taskId: payload.taskId,
    contractDigest: subject.contractDigest || null,
    attemptId: subject.attemptId || null,
    fencingToken: subject.fencingToken ?? null,
  };
}

export function verifyWorkspaceBinding(input, subject = {}) {
  const binding = clone(input || {});
  const claimed = binding.digest;
  delete binding.digest;
  const errors = [];
  if (!claimed || claimed !== sha256(binding)) errors.push({ code: 'HOST_WORKSPACE_BINDING_DIGEST_INVALID' });
  for (const field of ['workspaceId','taskId','contractDigest','attemptId','path','branch','baseCommit']) {
    if (!binding[field]) errors.push({ code: 'HOST_WORKSPACE_BINDING_FIELD_MISSING', field });
  }
  if (binding.fencingToken == null) errors.push({ code: 'HOST_WORKSPACE_BINDING_FIELD_MISSING', field: 'fencingToken' });
  if (subject.taskId && binding.taskId !== subject.taskId) errors.push({ code: 'HOST_WORKSPACE_BINDING_SUBJECT_MISMATCH', field: 'taskId' });
  if (subject.contractDigest && binding.contractDigest !== subject.contractDigest) errors.push({ code: 'HOST_WORKSPACE_BINDING_SUBJECT_MISMATCH', field: 'contractDigest' });
  if (subject.attemptId && binding.attemptId !== subject.attemptId) errors.push({ code: 'HOST_WORKSPACE_BINDING_SUBJECT_MISMATCH', field: 'attemptId' });
  if (subject.fencingToken != null && binding.fencingToken !== subject.fencingToken) errors.push({ code: 'HOST_WORKSPACE_BINDING_SUBJECT_MISMATCH', field: 'fencingToken' });
  return { ok: errors.length === 0, errors, binding: { ...binding, digest: claimed } };
}

function brokerRequest(payload, options = {}) {
  return {
    schemaVersion: 1,
    role: payload.role,
    contextRole: payload.contextRole || payload.role,
    taskId: payload.taskId,
    workflowId: payload.workflowId || null,
    workflowDigest: payload.workflowDigest || null,
    prompt: payload.prompt || '',
    input: clone(payload.input),
    allowedActions: clone(payload.allowedActions || []),
    resultSchema: clone(payload.resultSchema || { type: 'any' }),
    executionRequirements: clone(payload.executionRequirements || {}),
    contextPacket: clone(options.contextPacket || null),
    contextPacketDigest: options.contextPacketDigest || null,
    workspace: clone(options.workspaceBinding || null),
  };
}

function driverOutput(value) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'output')) return value.output;
  return value;
}

async function executeNative(runtime, request) {
  const native = runtime.nativeSubagents;
  let handle = null;
  try {
    handle = await native.createSubagent({
      role: request.role,
      contextRole: request.contextRole,
      taskId: request.taskId,
      allowedActions: request.allowedActions,
    });
    const executionId = handle?.executionId || handle?.agentId || handle?.id;
    if (!executionId) return brokerFailure('HOST_EXECUTION_ID_REQUIRED', 'Native subagent handle must expose a stable execution identity');
    await native.sendInput(handle, request);
    const response = await native.wait(handle);
    return { ok: true, executionId: String(executionId), response };
  } finally {
    if (handle) {
      try { await native.close(handle); } catch { /* cleanup must not mask execution result */ }
    }
  }
}

async function executeSingle(runtime, request) {
  const executor = runtime.roleIsolation?.executeRole || runtime.executeRole;
  const executionId = runtime.executionId || runtime.sessionId;
  if (!executionId) return brokerFailure('HOST_EXECUTION_ID_REQUIRED', 'Same-agent execution requires runtime.executionId or runtime.sessionId');
  const owner = runtime.roleIsolation?.executeRole ? runtime.roleIsolation : runtime;
  const response = await executor.call(owner, request);
  return { ok: true, executionId: String(executionId), response };
}

async function executeExternal(runtime, resolution, request) {
  const worker = (runtime.externalWorkers || []).find(item => String(item?.id || '') === String(resolution.workerId || ''));
  if (!worker || worker.trusted !== true) return brokerFailure('HOST_EXTERNAL_WORKER_UNAVAILABLE', 'Resolved trusted external worker is no longer available');
  const executor = worker.driver?.executeRole || worker.executeRole;
  if (!callable(executor)) return brokerFailure('HOST_EXTERNAL_WORKER_UNAVAILABLE', 'Resolved external worker has no executeRole binding');
  const owner = worker.driver?.executeRole ? worker.driver : worker;
  const response = await executor.call(owner, request);
  const executionId = response?.executionId || response?.workerExecutionId;
  if (!executionId) return brokerFailure('HOST_EXECUTION_ID_REQUIRED', 'External worker must return a stable executionId');
  return { ok: true, executionId: String(executionId), response };
}

export async function executeAgentHostInterrupt(interrupt, runtime = {}, options = {}) {
  const plan = planAgentHostExecution(interrupt, runtime);
  if (!plan.ok) return plan;

  const subject = brokerSubject(plan.payload, options.subject || {});
  if (!subject.contractDigest || !subject.attemptId || subject.fencingToken == null) {
    return brokerFailure('HOST_ATTEMPT_SUBJECT_REQUIRED', 'Automatic execution requires task contract, Attempt and fencing subject');
  }
  if (options.subject?.taskId && options.subject.taskId !== plan.payload.taskId) {
    return brokerFailure('HOST_ATTEMPT_SUBJECT_MISMATCH', 'Execution subject taskId does not match interrupt taskId');
  }
  if (!options.contextPacketDigest) {
    return brokerFailure('HOST_CONTEXT_PACKET_DIGEST_REQUIRED', 'Automatic execution requires a frozen ContextPacket digest');
  }
  const workspaceRequired = plan.resolution.requirements?.workspaceIsolation === 'required';
  let workspaceBinding = null;
  if (options.workspaceBinding) {
    const checkedWorkspace = verifyWorkspaceBinding(options.workspaceBinding, subject);
    if (!checkedWorkspace.ok) {
      return brokerFailure('HOST_WORKSPACE_BINDING_INVALID', 'RootAgent workspace binding invalid', { errors: checkedWorkspace.errors });
    }
    workspaceBinding = checkedWorkspace.binding;
  }
  if (workspaceRequired && !workspaceBinding) {
    return brokerFailure('HOST_WORKSPACE_BINDING_REQUIRED', 'WORKTREE_REQUIRED execution requires a verified RootAgent workspace binding');
  }

  const capabilityEvidence = createHostCapabilityEvidence(plan.capabilities, {
    assurance: 'RUNTIME_OBSERVED',
    source: {
      kind: 'runtime-discovery',
      hostInstanceId: runtime.hostInstanceId || null,
      sessionId: runtime.sessionId || runtime.executionId || null,
    },
    subject,
    observedAt: options.observedAt,
  });
  const request = brokerRequest(plan.payload, { ...options, workspaceBinding });
  const startedAt = options.startedAt || new Date().toISOString();

  let executed;
  try {
    if (plan.resolution.strategy === 'NATIVE_MULTI_AGENT') executed = await executeNative(runtime, request);
    else if (plan.resolution.strategy === 'SINGLE_AGENT_ROLE_ISOLATION') executed = await executeSingle(runtime, request);
    else if (plan.resolution.strategy === 'EXTERNAL_WORKER') executed = await executeExternal(runtime, plan.resolution, request);
    else return brokerFailure('HOST_CAPABILITY_UNSATISFIED', 'No executable Agent Host strategy selected');
  } catch (error) {
    return brokerFailure(error?.code || 'HOST_EXECUTION_FAILED', error?.message || String(error));
  }
  if (!executed.ok) return executed;

  const output = driverOutput(executed.response);
  if (!resultMatchesSchema(output, plan.payload.resultSchema)) {
    return brokerFailure('HOST_RESULT_SCHEMA_MISMATCH', 'Role executor output does not match RootAgent resultSchema', {
      expected: clone(plan.payload.resultSchema),
      actualType: resultRuntimeType(output),
    });
  }

  const completedAt = options.completedAt || new Date().toISOString();
  const executionRecord = {
    schemaVersion: 1,
    role: plan.payload.role,
    contextRole: plan.payload.contextRole || plan.payload.role,
    taskId: plan.payload.taskId,
    workflowId: plan.payload.workflowId || null,
    workflowDigest: plan.payload.workflowDigest || null,
    strategy: plan.resolution.strategy,
    workerId: plan.resolution.workerId || null,
    executionId: executed.executionId,
    subject,
    contextPacketDigest: options.contextPacketDigest,
    reviewedCandidateDigest: ['checker', 'reviewer'].includes(plan.payload.contextRole || plan.payload.role)
      ? options.contextPacket?.candidate?.digest || null : null,
    workspaceId: workspaceBinding?.workspaceId || null,
    workspaceBindingDigest: workspaceBinding?.digest || null,
    hostCapabilityDigest: plan.resolution.hostCapabilityDigest,
    capabilityEvidenceDigest: capabilityEvidence.digest,
    physicalIsolation: !!plan.resolution.physicalIsolation,
    independentContext: !!plan.resolution.independentContext,
    freshContext: !!plan.resolution.freshContext,
    executionRequirements: clone(plan.resolution.requirements),
    actualConcurrency: positiveInt(plan.resolution.actualConcurrency, 1),
    degradations: clone(plan.resolution.degradations || []),
    allowedActions: clone(plan.payload.allowedActions || []),
    outputDigest: sha256(output),
    startedAt,
    completedAt,
  };
  executionRecord.digest = sha256(executionRecord);

  return {
    ok: true,
    code: 'HOST_EXECUTION_COMPLETED',
    strategy: plan.resolution.strategy,
    output,
    capabilityEvidence,
    executionRecord,
  };
}

export function verifyAgentHostExecutionRecord(input) {
  const record = clone(input || {});
  const claimed = record.digest;
  delete record.digest;
  const errors = [];
  if (!claimed || claimed !== sha256(record)) errors.push({ code: 'HOST_EXECUTION_RECORD_DIGEST_INVALID' });
  if (!HOST_EXECUTION_ROLES.includes(record.role)) errors.push({ code: 'HOST_ROLE_UNSUPPORTED', role: record.role || null });
  if (!record.executionId) errors.push({ code: 'HOST_EXECUTION_ID_REQUIRED' });
  if (!record.hostCapabilityDigest || !record.capabilityEvidenceDigest) errors.push({ code: 'HOST_EXECUTION_EVIDENCE_MISSING' });
  if (!record.subject?.taskId || !record.subject?.contractDigest || !record.subject?.attemptId || record.subject?.fencingToken == null) {
    errors.push({ code: 'HOST_EXECUTION_SUBJECT_INVALID' });
  }
  if (record.executionRequirements?.workspaceIsolation === 'required') {
    if (!record.workspaceId || !record.workspaceBindingDigest) errors.push({ code: 'HOST_WORKSPACE_BINDING_REQUIRED' });
  }
  return { ok: errors.length === 0, errors, record: { ...record, digest: claimed } };
}

export function finalizeAgentHostProvenance(executionRecordInput, candidateSubject = {}) {
  const checked = verifyAgentHostExecutionRecord(executionRecordInput);
  if (!checked.ok) {
    const error = new Error('execution record invalid');
    error.code = 'HOST_EXECUTION_RECORD_INVALID';
    error.data = { errors: checked.errors };
    throw error;
  }
  const record = checked.record;
  const subject = {
    taskId: candidateSubject.taskId || record.subject.taskId,
    contractDigest: candidateSubject.contractDigest || record.subject.contractDigest,
    attemptId: candidateSubject.attemptId || record.subject.attemptId,
    fencingToken: candidateSubject.fencingToken ?? record.subject.fencingToken,
    candidateDigest: candidateSubject.candidateDigest || null,
  };
  if (
    subject.taskId !== record.subject.taskId
    || subject.contractDigest !== record.subject.contractDigest
    || subject.attemptId !== record.subject.attemptId
    || subject.fencingToken !== record.subject.fencingToken
  ) {
    const error = new Error('candidate subject does not match execution record Attempt subject');
    error.code = 'HOST_EXECUTION_SUBJECT_MISMATCH';
    throw error;
  }
  if (!subject.candidateDigest) {
    const error = new Error('candidateDigest required to finalize provenance');
    error.code = 'HOST_CANDIDATE_DIGEST_REQUIRED';
    throw error;
  }
  if (record.reviewedCandidateDigest && record.reviewedCandidateDigest !== subject.candidateDigest) {
    const error = new Error('candidate differs from the Candidate frozen in the review ContextPacket');
    error.code = 'HOST_REVIEW_CANDIDATE_MISMATCH';
    throw error;
  }

  return createExecutionProvenance({
    resolution: {
      ok: true,
      strategy: record.strategy,
      workerId: record.workerId,
      physicalIsolation: record.physicalIsolation,
      independentContext: record.independentContext,
      freshContext: record.freshContext,
      degradations: record.degradations,
      actualConcurrency: record.actualConcurrency,
      requirements: record.executionRequirements,
      hostCapabilityDigest: record.hostCapabilityDigest,
    },
    role: record.role,
    executionId: record.executionId,
    contextPacketDigest: record.contextPacketDigest,
    capabilityEvidenceDigest: record.capabilityEvidenceDigest,
    workspaceId: record.workspaceId,
    workspaceBindingDigest: record.workspaceBindingDigest,
    subject,
    createdAt: record.completedAt,
  });
}
