/**
 * Outcome Contract Binding V1
 *
 * Derive stable runtime outcome criterion IDs from the frozen task acceptance
 * criteria. Runtime products may report met/evidence only for these IDs.
 *
 * Technical-only criteria remain enforced by RootAgent's normal validators and
 * are intentionally excluded from runtime outcome reporting.
 */
import crypto from 'node:crypto';

const TECHNICAL_PREFIXES = [
  '[工程]',
  '[质量]',
  '[安全]',
  '[审批]',
  '[验证]',
  '[测试]',
  '[性能]',
];

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function isRuntimeOutcomeCriterion(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return !TECHNICAL_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

export function outcomeCriterionId(text) {
  const normalized = normalizeText(text);
  return 'ac-' + crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

export function deriveOutcomeContract(acceptanceCriteria = [], context = {}) {
  const criteria = (acceptanceCriteria || [])
    .map(normalizeText)
    .filter(isRuntimeOutcomeCriterion)
    .map(text => ({
      id: outcomeCriterionId(text),
      text,
      required: true,
    }));

  return {
    schemaVersion: 1,
    taskId: context.taskId || null,
    contractDigest: context.contractDigest || null,
    criteria,
  };
}

export function validateOutcomeContractBinding(outcome, contract) {
  const expected = Array.isArray(contract?.criteria) ? contract.criteria : [];
  if (!expected.length) return { ok: true, violations: [] };
  if (!outcome || !Array.isArray(outcome.criteria)) {
    return {
      ok: false,
      violations: [{
        id: 'OUTCOME_CONTRACT_MISSING',
        label: 'Runtime outcome is missing criteria required by the frozen acceptance contract',
        expectedIds: expected.map(item => item.id),
      }],
    };
  }

  const actual = new Map(outcome.criteria.map(item => [String(item?.id || ''), item]));
  const expectedIds = new Set(expected.map(item => item.id));
  const missing = expected.filter(item => !actual.has(item.id));
  const unknown = [...actual.keys()].filter(id => id && !expectedIds.has(id));

  const violations = [];
  if (missing.length) {
    violations.push({
      id: 'OUTCOME_CONTRACT_CRITERIA_MISSING',
      label: 'Runtime outcome omitted required acceptance criteria',
      missing: missing.map(item => ({ id: item.id, text: item.text })),
    });
  }
  if (unknown.length) {
    violations.push({
      id: 'OUTCOME_CONTRACT_CRITERIA_UNBOUND',
      label: 'Runtime outcome reported criteria that are not bound to the frozen acceptance contract',
      unknownIds: unknown,
    });
  }

  return { ok: violations.length === 0, violations };
}


export function buildOutcomeContractFindings(outcome, contract) {
  const checked = validateOutcomeContractBinding(outcome, contract);
  return checked.violations.map(item => ({
    id: item.id,
    label: item.label,
    severity: 'critical',
    confidence: 1,
    evidence: [item],
  }));
}
