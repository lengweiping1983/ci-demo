/**
 * High-confidence product quality findings derived from real runtime playtest evidence.
 *
 * V1 intentionally avoids subjective aesthetic scoring. A finding requires
 * observable before/after state supplied by the running product and a bounded,
 * non-WAIT user action whose state remains unchanged.
 *
 * RootAgent owns candidate construction. Jev may only select one finding ID.
 */
import { chooseWithJevSync } from './jev-decision-provider.mjs';

const LABELS = Object.freeze({
  ACTION_NO_OBSERVABLE_EFFECT: 'Core user action produced no observable product-state change',
  REPEATED_NO_OBSERVABLE_EFFECT: 'Multiple bounded user actions produced no observable product-state change',
});

function stableJson(value) {
  try { return JSON.stringify(value); } catch { return ''; }
}

function meaningfulCustom(step, side) {
  const state = side === 'before' ? step?.observedBefore : step?.observedAfter;
  const custom = state?.custom;
  if (custom == null || typeof custom !== 'object') return null;
  if (custom.observeError) return null;
  return custom;
}

const SEVERITY_WEIGHT = Object.freeze({
  critical: 400,
  high: 300,
  medium: 200,
  low: 100,
});

function deterministicPriority(finding) {
  const severity = SEVERITY_WEIGHT[String(finding?.severity || '').toLowerCase()] || 0;
  const confidence = Number.isFinite(Number(finding?.confidence)) ? Math.max(0, Math.min(1, Number(finding.confidence))) : 0;
  const evidenceCount = Array.isArray(finding?.evidence) ? Math.min(finding.evidence.length, 10) : 0;
  // Severity dominates. Confidence then repeated independent runtime evidence break ties.
  return severity + confidence * 50 + evidenceCount;
}

export function rankProductQualityFindings(findings = []) {
  return [...findings].sort((a, b) =>
    deterministicPriority(b) - deterministicPriority(a)
    || String(a?.id || '').localeCompare(String(b?.id || ''))
  );
}

export function buildProductQualityFindings(playtest) {
  const steps = Array.isArray(playtest?.steps) ? playtest.steps : [];
  const noEffectSteps = [];

  for (const step of steps) {
    if (!step || step.actionId === 'WAIT') continue;
    const before = meaningfulCustom(step, 'before');
    const after = meaningfulCustom(step, 'after');
    if (before == null || after == null) continue;

    const changed = typeof step.effectObserved === 'boolean'
      ? step.effectObserved
      : stableJson(before) !== stableJson(after);

    if (!changed) {
      noEffectSteps.push({
        step: step.step,
        actionId: step.actionId,
        before,
        after,
      });
    }
  }

  if (!noEffectSteps.length) return [];

  const findings = [{
    id: 'ACTION_NO_OBSERVABLE_EFFECT',
    label: LABELS.ACTION_NO_OBSERVABLE_EFFECT,
    severity: 'high',
    confidence: 1,
    evidence: noEffectSteps.slice(0, 4),
  }];

  if (noEffectSteps.length >= 2) {
    findings.unshift({
      id: 'REPEATED_NO_OBSERVABLE_EFFECT',
      label: LABELS.REPEATED_NO_OBSERVABLE_EFFECT,
      severity: 'high',
      confidence: 1,
      evidence: noEffectSteps.slice(0, 4),
    });
  }

  return findings;
}

export function selectProductQualityFindingSync(cwd, findings = [], context = {}, options = {}) {
  if (!Array.isArray(findings) || !findings.length) return null;
  const ranked = rankProductQualityFindings(findings);
  if (ranked.length === 1) {
    return {
      ...ranked[0],
      selection: { provider: 'deterministic', reason: 'single_candidate' },
    };
  }

  const result = chooseWithJevSync(cwd, {
    objective: [
      'Select exactly one high-confidence product quality finding for the next Maker iteration.',
      'Prioritize the finding that most directly blocks useful user interaction and product value.',
      'Choose only from the supplied finding IDs. Do not invent fixes, commands, files, or new findings.',
    ].join(' '),
    state: {
      goal: context.goal || null,
      archetype: context.archetype || null,
      findingCount: findings.length,
    },
    choices: ranked.map(finding => ({
      id: finding.id,
      label: finding.label,
      context: {
        severity: finding.severity,
        confidence: finding.confidence,
        evidence: finding.evidence,
      },
    })),
  }, options);

  const minRaw = Number(options.minConfidence ?? process.env.ROOTAGENT_JEV_QUALITY_MIN_CONFIDENCE ?? process.env.ROOTAGENT_JEV_MIN_CONFIDENCE ?? 0.55);
  const minConfidence = Number.isFinite(minRaw) && minRaw >= 0 && minRaw <= 1 ? minRaw : 0.55;

  const chosen = result.ok && result.confidence >= minConfidence
    ? ranked.find(item => item.id === result.choiceId)
    : null;

  const finding = chosen || ranked[0];
  return {
    ...finding,
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
          reason: result.ok ? 'jev_low_confidence_ranked_fallback' : ((result.code || 'jev_unavailable') + '_ranked_fallback'),
          priorityScore: deterministicPriority(finding),
          ...(result.ok ? { jevConfidence: result.confidence } : {}),
        },
  };
}

export function formatProductQualityFinding(finding) {
  if (!finding) return '';
  const actions = (finding.evidence || []).map(item => item.actionId).filter(Boolean).join(', ');
  return '[Product Quality Finding:' + finding.id + '] ' + finding.label + (actions ? ' (actions: ' + actions + ')' : '');
}
