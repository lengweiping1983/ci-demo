import fs from 'node:fs';
import path from 'node:path';
import { commandDisplay } from './command-execution.mjs';
import { atomicWriteFile, sha256 } from './trust-core.mjs';

const markerFor = task => `<!-- rootagent:auto-task-projection ${JSON.stringify({
  schemaVersion: 1,
  taskId: task.id,
  contractDigest: task.contractDigest || null,
})} -->`;

const projectedTaskId = text => {
  const match = String(text || '').match(/<!-- rootagent:auto-task-projection (\{[^\n]+\}) -->/);
  if (!match) return null;
  try { return JSON.parse(match[1]).taskId || null; } catch { return null; }
};

const linesFor = values => (values?.length ? values : ['(无)']).map(value => `- ${value}`);
const commandLines = commands => (commands?.length ? commands : []).map(command => {
  const level = Number.isInteger(command?.level) ? command.level : 1;
  const ladder = command?.ladder || 'L';
  return `- [${ladder}${level}] ${commandDisplay(command)}`;
});

export function isAutomatedTask(task) {
  return !!task?.proposalSource;
}

export function renderAutomatedTaskMarkdown(task) {
  const structured = {
    taskId: task.id,
    contractDigest: task.contractDigest || null,
    risk: task.risk || null,
    requiresReview: !!task.requiresReview,
    setupCommands: task.setupCommands || [],
    validationCommands: task.validationCommands || [],
    proposalSource: task.proposalSource || null,
    improvementSource: task.improvementSource || null,
  };
  const commands = commandLines(task.validationCommands || []);
  const lines = [
    markerFor(task),
    `# 任务：${task.name}`,
    '',
    '> 此文件由 RootAgent 根据已批准的 Proposal 自动投影；权威结构化状态仍在 .rootagent/tasks.json。',
    `> Task ID: ${task.id} · Status: ${task.status || 'pending'}`,
    '',
    '## 描述',
    '',
    task.description || task.name,
    '',
    '## 验收标准',
    ...linesFor(task.acceptanceCriteria || []),
    '',
    '## 依赖',
    ...linesFor(task.dependsOn || []),
    '',
    '## 写目标',
    ...linesFor(task.writes || []),
    '',
    '## 验证命令',
    ...(commands.length ? commands : ['- (无)']),
    '',
    '## RootAgent 结构化契约',
    '~~~json',
    JSON.stringify(structured, null, 2),
    '~~~',
    '',
  ];
  return lines.join('\n');
}

function preserveManualDraft(cwd, current) {
  if (!current.trim() || projectedTaskId(current)) return null;
  const dir = path.join(cwd, '.rootagent', 'tasks', 'drafts');
  const file = path.join(dir, `TASK-${sha256(current).slice(0, 12)}.md`);
  if (!fs.existsSync(file)) atomicWriteFile(file, current, 'utf-8');
  return path.relative(cwd, file).split(path.sep).join('/');
}

export function projectAutomatedTask(cwd, task, options = {}) {
  if (!isAutomatedTask(task)) return { projected: false, reason: 'manual-task' };
  const file = path.join(cwd, '.rootagent', 'TASK.md');
  if (options.onlyIfMissing && fs.existsSync(file)) return { projected: false, reason: 'existing-task-md' };
  let preservedDraft = null;
  if (fs.existsSync(file)) preservedDraft = preserveManualDraft(cwd, fs.readFileSync(file, 'utf-8'));
  atomicWriteFile(file, renderAutomatedTaskMarkdown(task), 'utf-8');
  return { projected: true, taskId: task.id, path: '.rootagent/TASK.md', preservedDraft };
}

export function archiveAutomatedTaskProjection(cwd, task) {
  if (!isAutomatedTask(task)) return { archived: false, reason: 'manual-task' };
  const currentFile = path.join(cwd, '.rootagent', 'TASK.md');
  const doneFile = path.join(cwd, '.rootagent', 'tasks', 'done', `${task.id}.md`);
  atomicWriteFile(doneFile, renderAutomatedTaskMarkdown(task), 'utf-8');
  if (fs.existsSync(currentFile)) {
    const current = fs.readFileSync(currentFile, 'utf-8');
    if (projectedTaskId(current) === task.id) fs.unlinkSync(currentFile);
  }
  return { archived: true, taskId: task.id, path: path.relative(cwd, doneFile).split(path.sep).join('/') };
}
