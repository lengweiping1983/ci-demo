/**
 * User Journey Quality V1
 *
 * Detect high-confidence journey stagnation/regression from real runtime traces.
 * The product owns the journey semantics and exposes them read-only through:
 *
 * window.__ROOTAGENT_PLAYTEST__.observe().journey = {
 *   id: string,
 *   status: 'not_started' | 'in_progress' | 'succeeded' | 'failed',
 *   progress: number 0..1,
 *   milestone?: string
 * }
 *
 * V1 deliberately does not guess "fun", ideal completion time, or whether a
 * legitimate player failure means product failure.
 */

const EPSILON = 0.01;

function normalizeJourney(state) {
  const raw = state?.custom?.journey;
  if (!raw || typeof raw !== 'object') return null;

  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
  const status = typeof raw.status === 'string' ? raw.status : null;
  const progress = Number(raw.progress);
  const validStatuses = new Set(['not_started', 'in_progress', 'succeeded', 'failed']);

  if (!id || !validStatuses.has(status) || !Number.isFinite(progress) || progress < 0 || progress > 1) {
    return null;
  }

  return {
    id,
    status,
    progress,
    milestone: typeof raw.milestone === 'string' ? raw.milestone.slice(0, 160) : null,
  };
}

export function validateJourneyObservation(state) {
  return normalizeJourney(state);
}

export function buildUserJourneyFindings(playtest) {
  const steps = Array.isArray(playtest?.steps) ? playtest.steps : [];
  const observations = [];

  for (const step of steps) {
    if (!step || step.actionId === 'WAIT') continue;
    const before = normalizeJourney(step.observedBefore);
    const after = normalizeJourney(step.observedAfter);
    if (!before || !after || before.id !== after.id) continue;

    observations.push({
      step: step.step,
      actionId: step.actionId,
      before,
      after,
      delta: after.progress - before.progress,
    });
  }

  if (!observations.length) return [];

  const findings = [];
  const regressions = observations.filter(item =>
    item.before.status !== 'failed'
    && item.after.status !== 'failed'
    && item.delta < -EPSILON
  );

  if (regressions.length) {
    findings.push({
      id: 'JOURNEY_PROGRESS_REGRESSION',
      label: 'Core user journey progress regressed after a normal user action',
      severity: 'high',
      confidence: 1,
      evidence: regressions.slice(0, 4),
    });
  }

  const active = observations.filter(item =>
    ['not_started', 'in_progress'].includes(item.before.status)
    && ['not_started', 'in_progress'].includes(item.after.status)
  );
  const stagnant = active.filter(item => item.delta <= EPSILON);

  if (active.length >= 2 && stagnant.length === active.length) {
    findings.push({
      id: 'JOURNEY_NO_PROGRESS',
      label: 'Core user journey made no observable progress across multiple valid user actions',
      severity: 'high',
      confidence: 1,
      evidence: stagnant.slice(0, 4),
    });
  }

  return findings;
}

export function formatJourneyContractExample() {
  return [
    'window.__ROOTAGENT_PLAYTEST__.observe() should include journey:',
    "{ id: 'core-loop', status: 'in_progress', progress: 0.4, milestone: 'first-enemy-hit' }",
  ].join(' ');
}
