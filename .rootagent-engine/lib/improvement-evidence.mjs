import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { sha256, atomicWriteJson, readJson, projectTreeHash } from './trust-core.mjs';
import { validateCommandSpec, resolveCommandCwd } from './command-execution.mjs';

export function requireThat(condition, code, message, data = {}) {
  if (!condition) { const error = new Error(message); error.code = code; error.data = data; throw error; }
}
export function safeId(value) {
  requireThat(typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value), 'IMPROVE_INVALID_ID', 'Invalid identifier');
  return value;
}
export function seal(value) { const copy = { ...value }; delete copy.digest; return { ...copy, digest: sha256(copy) }; }
export function verify(value) { requireThat(value && seal(value).digest === value.digest, 'IMPROVE_CORRUPT', 'Record digest mismatch'); return value; }
export const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const head = cwd => git(cwd, ['rev-parse', 'HEAD']);
export function cleanProduct(cwd) {
  const changes = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], { cwd, encoding: 'utf8' });
  const dirty = changes.split('\0').filter(Boolean).map(x => x.slice(3)).filter(x => x !== '.rootagent' && !x.startsWith('.rootagent/'));
  requireThat(!dirty.length, 'IMPROVE_DIRTY_PRODUCT', `Commit product changes first: ${dirty.join(', ')}`);
}
export function root(cwd) { return path.join(cwd, '.rootagent', 'improvement'); }
export function putRecord(cwd, type, value) {
  const record = seal({ ...value, schemaVersion: 1, type });
  const file = path.join(root(cwd), 'records', record.digest + '.json');
  if (fs.existsSync(file)) verify(readJson(file)); else atomicWriteJson(file, record);
  return record;
}
export function getRecord(cwd, digest, type) {
  requireThat(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest), 'IMPROVE_INVALID_DIGEST', 'Invalid record digest');
  const value = verify(readJson(path.join(root(cwd), 'records', digest + '.json')));
  requireThat(value.digest === digest && (!type || value.type === type), 'IMPROVE_RECORD_MISMATCH', 'Record identity/type mismatch');
  return value;
}
const text = value => typeof value === 'string' && value.trim().length > 0;
export function validateResearch(record, now = Date.now()) {
  requireThat(record && ['live', 'imported'].includes(record.mode) && text(record.query) && text(record.applicability), 'IMPROVE_RESEARCH_REQUIRED', 'Research mode/query/applicability required');
  requireThat(Array.isArray(record.sources) && record.sources.length > 0, 'IMPROVE_RESEARCH_REQUIRED', 'At least one primary source required');
  for (const s of record.sources) {
    let url; try { url = new URL(s.url); } catch { /* handled below */ }
    requireThat(url && ['https:', 'http:'].includes(url.protocol) && ['official', 'paper', 'repository'].includes(s.kind) && text(s.version) && text(s.claim), 'IMPROVE_SOURCE_INVALID', 'Primary source URL, kind, version and claim required');
    const accessed = Date.parse(s.accessedAt);
    requireThat(Number.isFinite(accessed) && accessed <= now + 60000 && now - accessed <= 30 * 86400000, 'IMPROVE_SOURCE_STALE', 'Recheck source access within 30 days; future dates are invalid');
  }
  requireThat(Array.isArray(record.counterEvidence) && Array.isArray(record.limitations), 'IMPROVE_RESEARCH_REQUIRED', 'Counter evidence and limitations must be explicit');
  return record;
}
export function validateOpportunity(value, levels) {
  const o = JSON.parse(JSON.stringify(value || {}));
  requireThat(levels.includes(o.level) && [1, 2, 3].includes(o.level), 'IMPROVE_LEVEL_DENIED', 'Opportunity level outside session scope');
  for (const key of ['title', 'problem', 'projectValue', 'expectedBenefit', 'cost', 'rationale', 'statusQuo']) requireThat(text(o[key]), 'IMPROVE_OPPORTUNITY_INVALID', `${key} required`);
  requireThat(['low', 'medium', 'high', 'critical'].includes(o.risk), 'IMPROVE_RISK_INVALID', 'Explicit risk required');
  requireThat(Array.isArray(o.evidence) && o.evidence.length && o.evidence.every(text), 'IMPROVE_EVIDENCE_REQUIRED', 'Project evidence required');
  requireThat(Array.isArray(o.writes) && o.writes.length && o.writes.every(p => text(p) && !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..') && !p.startsWith('.rootagent')), 'IMPROVE_SCOPE_INVALID', 'Project-relative product write scope required');
  if (o.cleanup) requireThat(text(o.referenceAnalysis) && text(o.compatibilityAnalysis), 'IMPROVE_CLEANUP_UNPROVEN', 'Cleanup needs reference and compatibility analysis');
  if (o.level >= 2) {
    validateResearch(o.research);
    requireThat(text(o.migration) && text(o.rollback) && text(o.maintenanceCost), 'IMPROVE_ADOPTION_UNPROVEN', 'Migration, rollback and maintenance cost required');
  }
  if (o.level === 2) for (const k of ['maintenance', 'compatibility', 'license', 'stability']) requireThat(text(o.maturity?.[k]), 'IMPROVE_MATURITY_UNPROVEN', `Maturity ${k} required`);
  if (o.level === 3) {
    for (const k of ['hypothesis', 'control', 'stopCondition']) requireThat(text(o.experiment?.[k]), 'IMPROVE_EXPERIMENT_REQUIRED', `Experiment ${k} required`);
    requireThat(Number.isInteger(o.experiment.maxElapsedMs) && o.experiment.maxElapsedMs > 0 && o.experiment.maxElapsedMs <= 3600000, 'IMPROVE_EXPERIMENT_REQUIRED', 'Experiment time budget must be <= 1 hour');
  }
  validateMeasurement(o.measurement);
  o.risk = effectiveRisk(o);
  return o;
}
export function effectiveRisk(o, changed = []) {
  const sensitive = o.breakingCompatibility || o.importantDeletion || o.irreversibleMigration || o.changesTrust || [...o.writes, ...changed.map(x => x.split('\t')[1] || '')].some(p => /(^|\/)((trust-core|security-core|improvement[^/]*|agent-host[^/]*|control-graph|rootagent|project-orchestration|command-execution|proposal-enqueue|parallel-isolation|audit-seal)\.mjs|controller-protocol\.json)$/.test(p));
  return o.risk === 'critical' ? 'critical' : sensitive || changed.some(x => x.startsWith('D\t')) ? 'high' : o.risk;
}
export function validateMeasurement(m) {
  requireThat(m && Array.isArray(m.checks) && m.checks.length && Array.isArray(m.metrics) && m.metrics.length, 'IMPROVE_MEASUREMENT_REQUIRED', 'Checks and at least one measurable benefit required');
  requireThat(Array.isArray(m.verifierPaths), 'IMPROVE_MEASUREMENT_REQUIRED', 'Explicit verifierPaths required (empty for inline checks)');
  const ids = new Set();
  for (const metric of m.metrics) {
    requireThat(text(metric.id) && !ids.has(metric.id) && ['lower', 'higher'].includes(metric.direction), 'IMPROVE_METRIC_INVALID', 'Unique metric id and direction required'); ids.add(metric.id);
    requireThat(Number.isFinite(metric.minDelta) && metric.minDelta >= 0 && Number.isFinite(metric.maxRegression) && metric.maxRegression >= 0, 'IMPROVE_METRIC_INVALID', 'Finite nonnegative thresholds required');
    requireThat(Number.isInteger(metric.samples) && metric.samples >= 1 && metric.samples <= 20 && (!metric.performance || metric.samples >= 3), 'IMPROVE_METRIC_INVALID', 'Performance metrics require >= 3 samples (max 20)');
  }
  requireThat(m.metrics.some(x => x.minDelta > 0), 'IMPROVE_METRIC_INVALID', 'At least one positive benefit threshold required');
  for (const command of [...m.checks, ...m.metrics.map(x => x.command)]) {
    const checked = validateCommandSpec(command, { automated: true, validation: true });
    requireThat(checked.ok && command.effect === 'pure' && command.network === 'deny', 'IMPROVE_COMMAND_INVALID', 'Measurement commands must be pure structured offline checks');
  }
  return m;
}
// Freeze directly referenced project files even when a host omits them from the
// manifest. Transitive/dynamic verifier dependencies still require explicit paths.
function measurementVerifierPaths(cwd, definition) {
  const paths = new Set(definition.verifierPaths);
  const project = fs.realpathSync(cwd);
  for (const command of [...definition.checks, ...definition.metrics.map(m => m.command)]) {
    const commandCwd = resolveCommandCwd(cwd, command.cwd);
    const inline = /^(node|nodejs)$/.test(command.program) && command.args.some(a => ['-e', '--eval', '-p', '--print'].includes(a));
    requireThat(inline || definition.verifierPaths.length > 0, 'IMPROVE_VERIFIER_REQUIRED', 'Non-inline measurements require an explicit verifier dependency manifest');
    const args = [...command.args];
    if (/^(npm|pnpm|yarn|bun)$/.test(command.program)) args.push('package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock');
    for (const arg of args) {
      if (!text(arg) || arg.startsWith('-')) continue;
      const file = path.resolve(commandCwd, arg);
      // Inline code and ordinary flags are not filenames.
      let stat; try { stat = fs.statSync(file); } catch { continue; }
      if (!stat.isFile()) continue;
      const relative = path.relative(project, file);
      requireThat(relative && !relative.split(path.sep).includes('..') && !path.isAbsolute(relative), 'IMPROVE_VERIFIER_INVALID', 'Verifier argument escapes project');
      paths.add(relative);
    }
  }
  return [...paths].sort();
}
function verifierHashes(cwd, paths) {
  return Object.fromEntries(paths.map(p => {
    requireThat(text(p) && !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..'), 'IMPROVE_VERIFIER_INVALID', 'Verifier must be project-relative');
    const real = fs.realpathSync(path.join(cwd, p));
    requireThat(real.startsWith(fs.realpathSync(cwd) + path.sep), 'IMPROVE_VERIFIER_INVALID', 'Verifier escapes project');
    return [p, sha256(fs.readFileSync(real))];
  }));
}
export function measure(cwd, definition, execute, options = {}) {
  validateMeasurement(definition); cleanProduct(cwd);
  const commit = head(cwd); const treeHash = projectTreeHash(cwd).treeHash; const verifiers = verifierHashes(cwd, measurementVerifierPaths(cwd, definition));
  const run = command => {
    const remaining = options.deadline == null ? (command.timeoutMs || 300000) : options.deadline - Date.now();
    requireThat(remaining > 0, 'IMPROVE_BUDGET_EXHAUSTED', 'Measurement budget exhausted before dispatch');
    const r = execute(command, cwd, false, { timeoutMs: Math.max(1, Math.min(command.timeoutMs || 300000, remaining)) });
    requireThat(options.deadline == null || Date.now() < options.deadline, 'IMPROVE_BUDGET_EXHAUSTED', 'Measurement exhausted remaining budget; no further samples dispatched');
    return { code: r.code ?? r.exitCode, output: r.out ?? r.output ?? '', commandDigest: sha256(command) };
  };
  const checks = definition.checks.map(run); const metrics = {};
  for (const metric of definition.metrics) {
    const samples = []; const runs = [];
    for (let i = 0; i < metric.samples; i++) {
      const r = run(metric.command); runs.push(r);
      let output; try { output = JSON.parse(r.output); } catch { /* fail below */ }
      requireThat(r.code === 0 && Number.isFinite(output?.value), 'IMPROVE_MEASUREMENT_FAILED', `Metric ${metric.id} must output JSON {value:number}`);
      samples.push(output.value);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    metrics[metric.id] = { value: sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2, samples, spread: sorted.at(-1) - sorted[0], runs };
  }
  cleanProduct(cwd);
  requireThat(head(cwd) === commit && projectTreeHash(cwd).treeHash === treeHash && sha256(verifierHashes(cwd, measurementVerifierPaths(cwd, definition))) === sha256(verifiers), 'IMPROVE_UNSTABLE_MEASUREMENT', 'Measurement mutated product or verifier');
  return { commit, treeHash, definitionDigest: sha256(definition), verifiers, environment: { platform: process.platform, arch: process.arch, node: process.version, cpu: os.cpus()[0]?.model || '', host: os.hostname() }, checks, metrics, measuredAt: new Date().toISOString() };
}
export function compareMeasurements(definition, baseline, candidate) {
  validateMeasurement(definition);
  for (const item of [baseline, candidate]) {
    requireThat(Array.isArray(item?.checks) && item.checks.length === definition.checks.length && item.checks.every(c => Number.isInteger(c.code)), 'IMPROVE_MEASUREMENT_INVALID', 'Missing or invalid check results');
    requireThat(definition.metrics.every(m => Number.isFinite(item.metrics?.[m.id]?.value) && Number.isFinite(item.metrics[m.id].spread) && item.metrics[m.id].spread >= 0), 'IMPROVE_MEASUREMENT_INVALID', 'Missing or invalid measured metrics');
  }
  requireThat(baseline.definitionDigest === sha256(definition) && candidate.definitionDigest === baseline.definitionDigest && sha256(candidate.verifiers) === sha256(baseline.verifiers), 'IMPROVE_VERIFIER_CHANGED', 'Frozen measurement definition/verifier changed');
  requireThat(sha256(baseline.environment) === sha256(candidate.environment), 'IMPROVE_ENVIRONMENT_CHANGED', 'Rebaseline required for changed measurement environment');
  const deltas = definition.metrics.map(m => {
    const b = baseline.metrics[m.id], c = candidate.metrics[m.id];
    const delta = (c.value - b.value) * (m.direction === 'higher' ? 1 : -1);
    return { id: m.id, delta, benefit: m.minDelta > 0 && delta >= m.minDelta && (!m.performance || delta > Math.max(b.spread, c.spread)), regression: delta < -m.maxRegression };
  });
  return { passed: candidate.checks.every(c => c.code === 0) && !deltas.some(x => x.regression) && deltas.some(x => x.benefit), deltas };
}
