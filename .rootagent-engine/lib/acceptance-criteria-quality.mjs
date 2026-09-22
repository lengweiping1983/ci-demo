/**
 * Acceptance Criteria Quality Gate V1
 *
 * Shared, deterministic quality checks for TASK.md and Planner Proposal entry
 * points. Hard failures are reserved for criteria that are clearly incapable of
 * proving a user-visible/product outcome. Softer ambiguity is reported as a
 * warning so engineering/regression tasks are not over-rejected.
 */

const TECHNICAL_PREFIXES = ['[工程]','[安全]','[审批]','[验证]','[测试]','[性能]'];

const HARD_VAGUE = [
  /^可以用[。.]?$/i, /^可用[。.]?$/i, /^能用[。.]?$/i, /^正常[。.]?$/i, /^体验好[。.]?$/i, /^好用[。.]?$/i,
  /^功能正常[。.]?$/i, /^游戏可以玩[。.]?$/i, /^works?[。.]?$/i, /^working[。.]?$/i, /^done[。.]?$/i,
  /^looks good[。.]?$/i, /^good[。.]?$/i, /^界面美观[。.]?$/i, /^质量高[。.]?$/i, /^效果好[。.]?$/i,
];

const IMPLEMENTATION_ONLY = [
  /^(?:使用|采用|改用|基于)\s*(?:react|vue|svelte|three(?:\.js)?|babylon(?:\.js)?|godot|unity|node(?:\.js)?|typescript|tailwind|vite|webpack)\b/i,
  /^(?:create|add|use|implement)\s+(?:a\s+)?(?:react|vue|three|babylon|godot|node|typescript|tailwind|vite|webpack)\b/i,
];

const OBSERVABLE_HINTS = [
  /用户|玩家|管理员|访客|调用方|operator|user|player|admin/i,
  /显示|看到|获得|收到|完成|进入|离开|移动|攻击|得分|保存|提交|下载|生成|返回|创建|删除|更新|登录|搜索|筛选|排序|导出|支付|恢复|重试/i,
  /visible|receive|complete|move|attack|score|save|submit|download|generate|return|create|delete|update|login|search|filter|sort|export|retry/i,
  /\d+(?:\.\d+)?(?:ms|s|秒|%|次|个|条|帧|fps|分)/i,
];

function normalize(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }

export function isTechnicalAcceptanceCriterion(text) {
  const value = normalize(text);
  return TECHNICAL_PREFIXES.some(prefix => value.startsWith(prefix));
}

export function analyzeAcceptanceCriterion(text, index = 0) {
  const value = normalize(text);
  const findings = [];
  if (!value) {
    findings.push({ code: 'AC_EMPTY', severity: 'error', criterionIndex: index, message: '验收标准不能为空' });
    return findings;
  }
  if (isTechnicalAcceptanceCriterion(value)) return findings;
  if (HARD_VAGUE.some(pattern => pattern.test(value))) findings.push({
    code: 'AC_VAGUE_UNVERIFIABLE', severity: 'error', criterionIndex: index, criterion: value,
    message: '验收标准过于空泛，无法证明具体用户结果；请描述谁在什么操作后能观察到什么结果',
  });
  if (IMPLEMENTATION_ONLY.some(pattern => pattern.test(value)) && !OBSERVABLE_HINTS.some(pattern => pattern.test(value))) findings.push({
    code: 'AC_IMPLEMENTATION_ONLY', severity: 'error', criterionIndex: index, criterion: value,
    message: '验收标准只描述实现手段，没有描述用户/产品可观察结果',
  });
  if (value.length < 10 && !findings.length) findings.push({
    code: 'AC_TOO_BRIEF', severity: 'warning', criterionIndex: index, criterion: value,
    message: '验收标准过短，建议补充操作、可观察结果或边界条件',
  });
  if (!OBSERVABLE_HINTS.some(pattern => pattern.test(value)) && !findings.some(item => item.severity === 'error')) findings.push({
    code: 'AC_WEAK_OBSERVABILITY', severity: 'warning', criterionIndex: index, criterion: value,
    message: '验收标准缺少明显的用户动作/可观察结果；请确认验证命令能够直接证明该标准',
  });
  return findings;
}

export function evaluateAcceptanceCriteria(criteria = []) {
  const findings = (criteria || []).flatMap((text, index) => analyzeAcceptanceCriterion(text, index));
  return {
    ok: !findings.some(item => item.severity === 'error'),
    errors: findings.filter(item => item.severity === 'error'),
    warnings: findings.filter(item => item.severity === 'warning'),
    findings,
  };
}

export function formatAcceptanceFinding(finding) {
  const n = Number.isInteger(finding?.criterionIndex) ? finding.criterionIndex + 1 : '?';
  return '#' + n + ' ' + (finding?.code || 'AC_QUALITY') + ': ' + (finding?.message || '验收标准质量不足');
}
