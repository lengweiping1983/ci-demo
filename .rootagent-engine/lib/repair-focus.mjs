/**
 * Convert hard-validation evidence into a bounded repair focus.
 *
 * RootAgent owns classification and the candidate set. Jev may only select one
 * stable repair category from those candidates. This keeps repair planning
 * evidence-driven without allowing a model to invent arbitrary actions.
 */
import { chooseWithJevSync } from './jev-decision-provider.mjs';

const PRIORITY = Object.freeze([
  'RUNTIME_OR_BUILD',
  'CORE_FUNCTIONALITY',
  'EXPERIENCE_QUALITY',
  'TEST_QUALITY',
  'CANDIDATE_INTEGRITY',
  'POLICY_OR_SECURITY',
  'VALIDATION_GENERAL',
]);

const LABELS = Object.freeze({
  RUNTIME_OR_BUILD: 'Fix runtime/build/test execution failure',
  CORE_FUNCTIONALITY: 'Fix required product behavior that does not work',
  EXPERIENCE_QUALITY: 'Fix user-experience or product-quality failure',
  TEST_QUALITY: 'Fix weak or non-falsifiable validation coverage',
  CANDIDATE_INTEGRITY: 'Fix candidate commit/tree stability or write-scope integrity',
  POLICY_OR_SECURITY: 'Fix policy/security constraint violation',
  VALIDATION_GENERAL: 'Fix remaining hard-validation failure',
});

function textOf(item) {
  return [
    item?.reason,
    item?.violation,
    item?.message,
    ...(Array.isArray(item?.outputTail) ? item.outputTail : []),
  ].filter(Boolean).join(' ').toLowerCase();
}

function classify(item) {
  const reason = String(item?.reason || '').toUpperCase();
  const text = textOf(item);

  if (
    reason === 'CANDIDATE_UNSTABLE_AFTER_VALIDATION'
    || reason === 'TASK_COMMIT_REQUIRED'
    || reason === 'COMMIT_SCOPE_VIOLATION'
    || text.includes('product tree')
    || text.includes('candidate')
  ) return 'CANDIDATE_INTEGRITY';

  if (
    reason === 'POLICY_BLOCKED'
    || reason.includes('TRUST')
    || reason.includes('SECURITY')
    || text.includes('sandbox')
    || text.includes('policy')
  ) return 'POLICY_OR_SECURITY';

  if (
    reason === 'NO_ASSERTIONS'
    || reason === 'RED_CONTROL_STAYED_GREEN'
    || text.includes('assertion')
    || text.includes('假绿')
    || text.includes('test cannot')
  ) return 'TEST_QUALITY';

  if (
    reason === 'EXPERIENCE_AUDIT_VIOLATION'
    || reason === 'PRODUCT_QUALITY_FINDING'
    || text.includes('体验')
    || text.includes('playability')
    || text.includes('feedback')
    || text.includes('camera')
    || text.includes('audio')
    || text.includes('webgl')
  ) return 'EXPERIENCE_QUALITY';

  if (
    text.includes('runtime')
    || text.includes('syntax')
    || text.includes('build')
    || text.includes('404')
    || text.includes('module')
    || typeof item?.exitCode === 'number' && item.exitCode !== 0
  ) return 'RUNTIME_OR_BUILD';

  if (
    text.includes('expected')
    || text.includes('actual')
    || text.includes('behavior')
    || text.includes('功能')
    || text.includes('input')
    || text.includes('attack')
    || text.includes('movement')
  ) return 'CORE_FUNCTIONALITY';

  return 'VALIDATION_GENERAL';
}

export function buildRepairCandidates(evidence = []) {
  const grouped = new Map();
  for (const item of evidence.filter(item => item?.verdict === 'FAIL')) {
    const id = classify(item);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(item);
  }

  return PRIORITY
    .filter(id => grouped.has(id))
    .map(id => ({
      id,
      label: LABELS[id],
      evidence: grouped.get(id),
      count: grouped.get(id).length,
    }));
}

export function selectRepairFocusSync(cwd, evidence = [], context = {}, options = {}) {
  const candidates = buildRepairCandidates(evidence);
  if (!candidates.length) return null;

  const fallback = candidates[0];
  if (candidates.length === 1) {
    return {
      category: fallback.id,
      label: fallback.label,
      evidence: fallback.evidence,
      selection: { provider: 'deterministic', reason: 'single_candidate' },
    };
  }

  const result = chooseWithJevSync(cwd, {
    objective: [
      'Select exactly one repair focus for the next Maker iteration.',
      'Prioritize making the product actually work for the user, then user experience and product quality,',
      'while respecting runtime correctness, security, candidate integrity and test validity.',
      'Choose only from the supplied repair categories; do not invent a fix or command.',
    ].join(' '),
    state: {
      taskId: context.taskId || null,
      goal: context.goal || null,
      retryCount: context.retryCount || 0,
    },
    choices: candidates.map(candidate => ({
      id: candidate.id,
      label: candidate.label,
      context: {
        failureCount: candidate.count,
        evidence: candidate.evidence.slice(0, 4).map(item => ({
          reason: item.reason || null,
          violation: item.violation || null,
          outputTail: Array.isArray(item.outputTail) ? item.outputTail.slice(-4) : undefined,
        })),
      },
    })),
  }, options);

  const minRaw = Number(options.minConfidence ?? process.env.ROOTAGENT_JEV_REPAIR_MIN_CONFIDENCE ?? process.env.ROOTAGENT_JEV_MIN_CONFIDENCE ?? 0.55);
  const minConfidence = Number.isFinite(minRaw) && minRaw >= 0 && minRaw <= 1 ? minRaw : 0.55;
  const chosen = result.ok && result.confidence >= minConfidence
    ? candidates.find(candidate => candidate.id === result.choiceId)
    : null;

  const focus = chosen || fallback;
  return {
    category: focus.id,
    label: focus.label,
    evidence: focus.evidence,
    selection: chosen
      ? {
          provider: 'jev',
          confidence: result.confidence,
          model: result.model,
          choiceId: result.choiceId,
          probabilities: result.probabilities,
          keyFingerprint: result.keyFingerprint,
        }
      : {
          provider: 'deterministic',
          reason: result.ok ? 'jev_low_confidence' : (result.code || 'jev_unavailable'),
          ...(result.ok ? { jevConfidence: result.confidence } : {}),
        },
  };
}
