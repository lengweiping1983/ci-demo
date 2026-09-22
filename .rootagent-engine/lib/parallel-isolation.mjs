import { isCommandSpec, validateCommandSpec } from './command-execution.mjs';

const clean = value => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
const globBase = value => clean(value).split(/[*?[]/, 1)[0].replace(/\/$/, '');
const contains = (a, b) => a === b || b.startsWith(`${a}/`);

export function pathPatternsOverlap(a, b) {
  const x = clean(a); const y = clean(b);
  if (!x || !y) return null;
  const xGlob = /[*?[]/.test(x); const yGlob = /[*?[]/.test(y);
  if (!xGlob && !yGlob) return contains(x, y) || contains(y, x);
  const xb = globBase(x); const yb = globBase(y);
  if (!xb || !yb) return true;
  if (!contains(xb, yb) && !contains(yb, xb)) return false;
  if (x.endsWith('/**') || y.endsWith('/**')) return true;
  if (!xGlob && contains(yb, x)) return true;
  if (!yGlob && contains(xb, y)) return true;
  return null;
}

export function declaredPathAllows(rel, patterns) {
  const value = clean(rel);
  return patterns.some(pattern => {
    const normalized = clean(pattern);
    if (!normalized) return false;
    if (/[*?[]/.test(normalized)) {
      const regex = new RegExp(`^${normalized.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.')}($|/)`);
      return regex.test(value);
    }
    return value === normalized || value.startsWith(`${normalized}/`);
  });
}

function resourceParts(value) {
  const raw = String(value || ''); const at = raw.indexOf(':');
  return at < 0 ? ['file', clean(raw)] : [raw.slice(0, at).toLowerCase(), clean(raw.slice(at + 1))];
}
function resourcesOverlap(a, b) {
  const [at, av] = resourceParts(a); const [bt, bv] = resourceParts(b);
  if (at !== bt) return false;
  return at === 'file' ? pathPatternsOverlap(av, bv) !== false : av === bv;
}

export function classifyParallelIsolation(tasks, options = {}) {
  const reasons = []; const errors = [];
  if (!options.git) return { decision: 'SERIAL_REQUIRED', reasons: ['项目不是 Git 工作树'], errors };
  let worktreeRequired = false;
  for (const task of tasks) {
    if (!(task.writes || []).length) { worktreeRequired = true; reasons.push(`[${task.id}] 写集为空，不能证明轻量安全`); }
    if (!(task.validationCommands || []).length) errors.push(`[${task.id}] 缺少 validationCommands`);
    if ((task.setupCommands || []).length) {
      worktreeRequired = true; reasons.push(`[${task.id}] 存在 setupCommands`);
      for (const command of task.setupCommands) {
        const checked = validateCommandSpec(command, { setup: true });
        if (!checked.ok) errors.push(`[${task.id}] 无效 setup CommandSpec：${checked.errors.join('；')}`);
      }
    }
    for (const command of task.validationCommands || []) {
      if (!isCommandSpec(command)) { errors.push(`[${task.id}] 并行自动化需要结构化 validation CommandSpec`); continue; }
      const checked = validateCommandSpec(command, { validation: true });
      if (!checked.ok) { errors.push(`[${task.id}] 无效 CommandSpec：${checked.errors.join('；')}`); continue; }
      if (checked.spec.scope !== 'task') { worktreeRequired = true; reasons.push(`[${task.id}] 存在 project-scope 验证`); }
      if (checked.spec.effect === 'workspace-write') { worktreeRequired = true; reasons.push(`[${task.id}] 验证命令声明 workspace-write`); }
      if (!checked.spec.readPaths.length) { worktreeRequired = true; reasons.push(`[${task.id}] 验证 readPaths 为空`); }
    }
  }
  if (errors.length) return { decision: null, reasons, errors };
  for (let i = 0; i < tasks.length; i++) for (let j = i + 1; j < tasks.length; j++) {
    const a = tasks[i]; const b = tasks[j];
    for (const aw of a.writes || []) for (const bw of b.writes || []) {
      const overlap = pathPatternsOverlap(aw, bw);
      if (overlap === true) return { decision: 'SERIAL_REQUIRED', reasons: [`[${a.id}] ${aw} 与 [${b.id}] ${bw} 写集包含或重叠`], errors };
      if (overlap == null) { worktreeRequired = true; reasons.push(`[${a.id}]/[${b.id}] glob 关系无法证明独立`); }
    }
    const ar = [...(a.resources || [])];
    const br = [...(b.resources || [])];
    const shared = ar.find(x => br.some(y => resourcesOverlap(x, y)));
    if (shared) return { decision: 'SERIAL_REQUIRED', reasons: [`[${a.id}] 与 [${b.id}] 资源冲突：${shared}`], errors };
    const aReads = a.validationCommands.filter(command => command.scope === 'task').flatMap(command => command.readPaths || []);
    const bReads = b.validationCommands.filter(command => command.scope === 'task').flatMap(command => command.readPaths || []);
    const aReadsB = aReads.some(read => (b.writes || []).some(write => pathPatternsOverlap(read, write) !== false));
    const bReadsA = bReads.some(read => (a.writes || []).some(write => pathPatternsOverlap(read, write) !== false));
    if (aReadsB || bReadsA) {
      return { decision: 'SERIAL_REQUIRED', reasons: [`[${a.id}] 与 [${b.id}] 存在 task-local 验证读取/写入交叉`], errors };
    }
  }
  return { decision: worktreeRequired ? 'WORKTREE_REQUIRED' : 'LIGHTWEIGHT', reasons: reasons.length ? reasons : ['写集、资源、读取范围和 task-local 验证均可证明独立'], errors };
}
