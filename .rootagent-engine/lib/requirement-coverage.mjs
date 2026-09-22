/**
 * Requirement Coverage Gate V1
 *
 * Schema v2 planner proposals carry a frozen requirement manifest extracted
 * from the RootAgent-owned project goal. RootAgent proves structural coverage
 * and source-quote binding; Reviewer remains responsible for semantic
 * completeness of the extraction.
 */
import crypto from 'node:crypto';

function sha256Text(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function norm(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }

export function projectGoalDigest(goal) { return sha256Text(norm(goal)); }

export function validateRequirementManifest(proposal, options = {}) {
  const errors = [];
  const warnings = [];
  const requirements = Array.isArray(proposal?.requirements) ? proposal.requirements : [];
  const parentCriteria = Array.isArray(proposal?.parentCriteria) ? proposal.parentCriteria : [];
  const strict = Number(proposal?.schemaVersion) >= 2;
  const projectGoal = norm(options.projectGoal);

  if (!strict) {
    warnings.push({ code: 'LEGACY_REQUIREMENT_COVERAGE', message: 'schemaVersion 1 未启用严格 Requirement Manifest 绑定；建议升级到 schemaVersion 2' });
    return { ok: true, errors, warnings, strict: false, requirementSourceDigest: null };
  }

  if (!requirements.length) errors.push({ code: 'REQUIREMENTS_REQUIRED', message: 'schemaVersion 2 必须提供 requirements' });
  const ids = new Set();
  for (const req of requirements) {
    const id = norm(req?.id);
    const text = norm(req?.text);
    const sourceQuote = norm(req?.sourceQuote);
    if (!id || ids.has(id)) errors.push({ code: 'INVALID_REQUIREMENT_ID', message: 'requirement id 缺失或重复：' + (id || '(空)') });
    else ids.add(id);
    if (!text) errors.push({ code: 'REQUIREMENT_TEXT_REQUIRED', requirementId: id || null, message: 'requirement.text 不能为空' });
    if (!sourceQuote) errors.push({ code: 'REQUIREMENT_SOURCE_QUOTE_REQUIRED', requirementId: id || null, message: 'requirement.sourceQuote 不能为空' });
    if (projectGoal && sourceQuote && !projectGoal.includes(sourceQuote)) errors.push({
      code: 'REQUIREMENT_SOURCE_NOT_IN_GOAL', requirementId: id || null,
      message: 'requirement.sourceQuote 无法在 RootAgent 权威 project goal 中找到：' + sourceQuote,
    });
  }

  const covered = new Set();
  for (const criterion of parentCriteria) {
    const refs = Array.isArray(criterion?.requirements) ? criterion.requirements.map(norm).filter(Boolean) : [];
    if (!refs.length) warnings.push({ code: 'PARENT_CRITERION_WITHOUT_REQUIREMENT', criterionId: criterion?.id || null, message: '父验收标准未声明 requirements 映射' });
    for (const reqId of refs) {
      if (!ids.has(reqId)) errors.push({ code: 'UNKNOWN_REQUIREMENT_REFERENCE', criterionId: criterion?.id || null, requirementId: reqId, message: '父验收标准引用未知 requirement：' + reqId });
      else covered.add(reqId);
    }
  }
  for (const reqId of ids) if (!covered.has(reqId)) errors.push({ code: 'UNCOVERED_REQUIREMENT', requirementId: reqId, message: 'Requirement 未被任何 parentCriteria 覆盖：' + reqId });

  const sourceDigest = projectGoal ? projectGoalDigest(projectGoal) : norm(proposal?.requirementSourceDigest) || null;
  if (projectGoal && proposal?.requirementSourceDigest && proposal.requirementSourceDigest !== sourceDigest) errors.push({
    code: 'REQUIREMENT_SOURCE_DIGEST_MISMATCH',
    message: 'proposal requirementSourceDigest 与 RootAgent 权威 project goal 不一致',
  });
  if (!projectGoal && !proposal?.requirementSourceDigest) warnings.push({ code: 'REQUIREMENT_SOURCE_UNBOUND', message: '未提供 project goal，无法复核 requirement source binding' });

  return { ok: errors.length === 0, errors, warnings, strict: true, requirementSourceDigest: sourceDigest };
}
