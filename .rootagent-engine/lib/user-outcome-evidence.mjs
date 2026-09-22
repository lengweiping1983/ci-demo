/**
 * User Outcome Evidence V1
 *
 * High-confidence consistency checks between a product-defined user journey
 * and the final user-visible outcome promised by the product.
 *
 * Interactive products expose read-only state:
 *
 * window.__ROOTAGENT_PLAYTEST__.observe().outcome = {
 *   id: string,
 *   status: 'pending' | 'satisfied' | 'failed',
 *   criteria: [{ id: string, met: boolean, evidence?: string }]
 * }
 *
 * V1 does not require a short playtest to finish a long journey. It only flags
 * contradictions such as "journey succeeded but outcome not delivered" or
 * "outcome satisfied while required criteria remain unmet".
 */

const VALID_OUTCOME_STATUSES = new Set(['pending', 'satisfied', 'failed']);
const JOURNEY_COMPLETE_EPSILON = 0.001;

function normalizeCriterion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
  if (!id || typeof raw.met !== 'boolean') return null;
  return {
    id,
    met: raw.met,
    evidence: typeof raw.evidence === 'string' ? raw.evidence.slice(0, 240) : null,
  };
}

export function validateOutcomeObservation(state) {
  const raw = state?.custom?.outcome;
  if (!raw || typeof raw !== 'object') return null;

  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
  const status = typeof raw.status === 'string' ? raw.status : null;
  if (!id || !VALID_OUTCOME_STATUSES.has(status) || !Array.isArray(raw.criteria) || raw.criteria.length === 0) {
    return null;
  }

  const criteria = raw.criteria.map(normalizeCriterion);
  if (criteria.some(item => !item)) return null;
  if (new Set(criteria.map(item => item.id)).size !== criteria.length) return null;

  return { id, status, criteria };
}

function journeyFromState(state) {
  const raw = state?.custom?.journey;
  if (!raw || typeof raw !== 'object') return null;
  const progress = Number(raw.progress);
  return {
    id: typeof raw.id === 'string' ? raw.id : null,
    status: typeof raw.status === 'string' ? raw.status : null,
    progress: Number.isFinite(progress) ? progress : null,
  };
}

export function buildUserOutcomeFindings(playtest) {
  const steps = Array.isArray(playtest?.steps) ? playtest.steps : [];
  const states = [];

  for (const step of steps) {
    if (!step) continue;
    for (const side of ['observedBefore', 'observedAfter']) {
      const state = step[side];
      const outcome = validateOutcomeObservation(state);
      if (!outcome) continue;
      const journey = journeyFromState(state);
      states.push({ step: step.step, actionId: step.actionId, side, journey, outcome });
    }
  }

  const findings = [];

  for (const item of states) {
    const unmet = item.outcome.criteria.filter(criterion => !criterion.met);
    if (item.outcome.status === 'satisfied' && unmet.length) {
      findings.push({
        id: 'OUTCOME_FALSE_SUCCESS',
        label: 'Product reports the user outcome as satisfied while required outcome criteria remain unmet',
        severity: 'critical',
        confidence: 1,
        evidence: [{
          step: item.step,
          actionId: item.actionId,
          outcomeId: item.outcome.id,
          unmetCriteria: unmet,
        }],
      });
      break;
    }
  }

  for (const item of states) {
    const journeySucceeded =
      item.journey?.status === 'succeeded'
      || (typeof item.journey?.progress === 'number' && item.journey.progress >= 1 - JOURNEY_COMPLETE_EPSILON);

    if (journeySucceeded && item.outcome.status !== 'satisfied') {
      findings.push({
        id: 'OUTCOME_NOT_DELIVERED_AFTER_JOURNEY_SUCCESS',
        label: 'Core journey reports success but the promised user outcome is not satisfied',
        severity: 'critical',
        confidence: 1,
        evidence: [{
          step: item.step,
          actionId: item.actionId,
          journey: item.journey,
          outcome: item.outcome,
        }],
      });
      break;
    }
  }

  return findings;
}
