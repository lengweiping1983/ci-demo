#!/usr/bin/env node
/**
 * rootagent.mjs — RootAgent 引擎内核（Skill 层 · Node CLI）
 *
 * 定位：任务队列驱动的开发循环中"机器该做的部分"：
 *   队列状态机 / 可信完成门 / Durable Control Graph / checkpoint 与事件重放 / 持久中断与触发。
 *   Maker/Checker 的语义工作由 AI 完成 —— 引擎不感知 AI。
 *
 * 关键设计：
 *   - start 锁任务：validate/pass/fail 只作用于 in_progress（修掉"误伤队列下一个任务"的坑）
 *   - plan：规划清单批量入队
 *   - goal：持续目标钩子，goal check 判定达成（机器可读 GOAL: MET/NOT）
 *   - progress / report：进度统计与复盘（读台账）
 *   - clear：人工解除阻塞
 *   - --project：多项目（projects.json 别名）
 *   - workflow/run/trigger：声明式控制图、at-least-once 执行与去重触发
 *
 * 用法（在项目根目录）：
 *   node rootagent.mjs init "<目标>"
 *   node rootagent.mjs add "<任务名>"            # 从 .rootagent/TASK.md 读取契约入队
 *   node rootagent.mjs next                      # 下一个可执行任务（依赖就绪、未阻塞）
 *   node rootagent.mjs start                     # 锁定为 in_progress（一次只能一个）
 *   node rootagent.mjs validate                  # 硬验证：引擎亲自跑验证命令
 *   node rootagent.mjs pass                      # 归档 + git commit 证据 + 台账
 *   node rootagent.mjs fail "<原因>"             # 失败计数；连续2次相同或满5次 → blocked
 *   node rootagent.mjs clear <id>                # 人工解除 blocked，回 pending
 *   node rootagent.mjs status                    # 队列总览
 *   node rootagent.mjs progress                  # 进度统计（含台账节奏）
 *   node rootagent.mjs ledger                    # 最近轮次台账
 *   node rootagent.mjs report [--save <path>]    # 复盘报告
 *   node rootagent.mjs plan [--apply]            # 生成规划模板 / 批量解析入队
 *   node rootagent.mjs goal "<目标>" [--count N] # 设置目标；goal check 判定达成
 *   node rootagent.mjs project <名> <路径>       # 注册项目别名；project list
 *   所有命令支持 --project <名> 切换到指定项目
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pathToFileURL, fileURLToPath } from 'url';
import { realpathSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import {
  EXIT, result, atomicWriteFile, atomicWriteJson, durableAppendJsonLine,
  withProjectLock, LockTimeoutError, taskContractDigest, createAttempt,
  assertAttempt, createCandidate, projectTreeHash, sha256, workerIdentity,
  commitRootAgentControlPaths, canTransition,
} from '../lib/trust-core.mjs';
import {
  validateWorkflowDefinition, installWorkflow, resolveWorkflow, createRun,
  executeRunStep, pauseRun, resumeRun, cancelRun, inspectRun, emitTrigger,
  listTriggerEvents, parseJsonArgument, auditControlStore,
} from '../lib/control-graph.mjs';
import {
  createWorkspace, loadWorkspace, listWorkspaces, prepareWorkspaceRuntime, preflightWorkspaceBatch, rollbackWorkspaceBatch, isGitProject, snapshotWorkspaceCandidate, loadCandidate, releaseWorkspace,
  enqueueCandidate, listIntegrationQueue, integrateNext,
  validatePlannerProposal, submitPlannerProposal, approvePlannerProposal, materializePlannerProposal,
  buildContextPacket, verifyContextPacket, validateAdapterManifest, installAdapter, listAdapters,
  requestAdapterOperation, respondAdapterOperation, inspectAdapterRequest, orchestrationHealth,
} from '../lib/project-orchestration.mjs';
import {
  loadSecurityPolicy, initSecurity, grantProjectTrust, inspectProjectTrust, revokeProjectTrust,
  assertProjectTrust, lockTrustedVerifier, checkTrustedVerifiers, detectSandboxBackend, secureExecute, runNegativeControls,
  storeTypedEvidence, listTypedEvidence, validateCheckerReport, calibrateChecker, loadCheckerCalibration,
} from '../lib/security-core.mjs';
import { commandDisplay, executeCommand, isCommandSpec, legacyCommandWarnings } from '../lib/command-execution.mjs';
import { classifyParallelIsolation, declaredPathAllows } from '../lib/parallel-isolation.mjs';
import { buildExplainableTrace, createTraceContext, listExplainableTraces, verifyExplainableTrace } from '../lib/explain-trace.mjs';
import { auditSealState, createAuditSeal, verifyAuditSeal } from '../lib/audit-seal.mjs';
import { finalizeAgentHostProvenance, validateHostPolicy, verifyExecutionProvenance, verifyHostCapabilityEvidence, verifyHostPolicyProvenance } from '../lib/agent-host.mjs';
import { driveAgentHostRun, readAgentHostRunDriverEvidence } from '../lib/agent-host-runner.mjs';
import { registerAgentHostRuntimeProvider } from '../lib/agent-host-runtime.mjs';
import { createDoubaoBridgeProvider, doubaoBridgeEnabled, enableDoubaoBridge, inspectDoubaoBridgeRequest, listDoubaoBridgeRequests, registerDoubaoBridgeProvider, respondDoubaoBridgeRequest } from '../lib/agent-host-provider-doubao.mjs';
import { createChatHostProvider, chatHostEnabled, enableChatHost, inspectChatHostRequest, listChatHostRequests, registerChatHostProvider, respondChatHostRequest } from '../lib/agent-host-provider-chat.mjs';

import { enqueueApprovedProposal } from '../lib/proposal-enqueue.mjs';
import { archiveAutomatedTaskProjection, projectAutomatedTask } from '../lib/task-md-projection.mjs';
import { startImprovement, listImprovementSessions, loadSession, changeSession, driveImprovement, improvementReport, verifyImprovementCandidate, assertImprovementAcceptance, verifyImprovementIntegration } from '../lib/improvement.mjs';
import { driveImprovementTasks } from '../lib/improvement-development.mjs';
import { grantImprovementApproval } from '../lib/improvement-approval.mjs';
import { verifySupervisor, verifySelfImprovementEvidence } from '../lib/improvement-self.mjs';
import { detectArchetypes, generateExperienceContract, auditProjectExperience } from '../lib/archetype-radar.mjs';
import { runPlayabilityProbe, formatProbeReport } from '../lib/playability-probe.mjs';
import { selectRepairFocusSync } from '../lib/repair-focus.mjs';
import { deriveOutcomeContract } from '../lib/outcome-contract.mjs';
import { evaluateAcceptanceCriteria, formatAcceptanceFinding } from '../lib/acceptance-criteria-quality.mjs';

const HOME = os.homedir();
const AGENT_HOME = path.join(HOME, '.rootagent');
const PROJECTS_FILE = path.join(AGENT_HOME, 'projects.json');
const MAX_RETRY = 5;
const STATE_SCHEMA_VERSION = 4;

let commandResult = null;
function failResult(status, reason, code = EXIT.STATE, data = {}) {
  commandResult = result(false, status, reason, data, code);
  return false;
}
function successResult(status = 'OK', data = {}) {
  const r = result(true, status, '', data, EXIT.OK);
  commandResult = r;
  return r;
}

// ── 参数解析（--project 可出现在任意位置）─────────────────
function parseArgs(argv) {
  let project = null;
  let json = false;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') { project = argv[++i]; }
    else if (argv[i] === '--json') { json = true; }
    else if (argv[i] === '--apply') { rest.push('--apply'); }
    else if (argv[i] === '--save') { rest.push('--save', argv[++i]); }
    else if (argv[i] === '--count') { rest.push('--count', argv[++i]); }
    else if (argv[i] === '--depends') { rest.push('--depends', argv[++i]); }
    else { rest.push(argv[i]); }
  }
  return { project, json, rest };
}

// ── 全局：项目注册表 ──────────────────────────────────────
function loadProjects() {
  if (!fs.existsSync(PROJECTS_FILE)) return {};
  return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8'));
}
function saveProjects(map) {
  fs.mkdirSync(AGENT_HOME, { recursive: true });
  atomicWriteJson(PROJECTS_FILE, map);
}
function cmdProject(args) {
  if (args[0] === 'list') {
    const map = loadProjects();
    const keys = Object.keys(map);
    if (!keys.length) { console.log('未注册任何项目。用法：rootagent project <名> <路径>'); return; }
    keys.forEach(k => console.log(`  ${k} → ${map[k]}`));
    return;
  }
  const [name, p] = args;
  if (!name || !p) { console.log('用法：rootagent project <名> <路径> | project list'); return failResult('INVALID_ARGUMENT', 'project 需要名称和路径', EXIT.USAGE); }
  const map = loadProjects();
  map[name] = path.resolve(p);
  saveProjects(map);
  console.log(`✓ 已注册项目 ${name} → ${map[name]}`);
}

// ── 预算与停滞（P0-1：循环刹车）────────────────────────────
const BUDGET_DEFAULTS = { maxRounds: null, maxFailed: null, maxElapsedMs: null, maxStall: 3, regressOnPass: true, staleMs: 1800000 };
function budgetFile(cwd) { return path.join(cwd, '.rootagent', 'budget.json'); }
function loadBudget(cwd) {
  const f = budgetFile(cwd);
  if (!fs.existsSync(f)) return { ...BUDGET_DEFAULTS };
  try { return { ...BUDGET_DEFAULTS, ...JSON.parse(fs.readFileSync(f, 'utf-8')) }; }
  catch { return { ...BUDGET_DEFAULTS }; }
}
function saveBudget(cwd, b) {
  fs.mkdirSync(path.join(cwd, '.rootagent'), { recursive: true });
  atomicWriteJson(budgetFile(cwd), b);
}
function readLedger(cwd) {
  const tf = taskFiles(cwd);
  const entries = [];
  if (fs.existsSync(tf.ledger)) {
    for (const l of fs.readFileSync(tf.ledger, 'utf-8').trim().split('\n').filter(Boolean)) {
      try { entries.push(JSON.parse(l)); } catch { /* 损坏行跳过 */ }
    }
  }
  return entries;
}
// 结果轮口径：started 是"开始标记"，不算一轮；一轮 = 一次结果（passed/validation_failed/blocked/resumed/cleared）
// 修复：原口径把 started+passed 各计一条，导致 maxRounds=2 第一轮完整开发就触发 exhausted（违反直觉）
function resultRounds(entries) { return entries.filter(e => e.outcome !== 'started').length; }
// 队列终态：running | stalled | exhausted（exhausted 优先；错误/耗尽永不计为成功）
function queueState(cwd, data) {
  const b = loadBudget(cwd);
  const entries = readLedger(cwd);
  const rounds = resultRounds(entries);
  const failed = entries.filter(e => e.outcome === 'validation_failed' || e.outcome === 'blocked').length;
  let reason = null;
  if (b.maxRounds != null && rounds >= b.maxRounds) reason = `轮次上限（${rounds}/${b.maxRounds}）`;
  else if (b.maxFailed != null && failed >= b.maxFailed) reason = `失败上限（${failed}/${b.maxFailed}）`;
  else if (b.maxElapsedMs != null && entries.length) {
    const first = new Date(entries[0].at).getTime();
    if (Date.now() - first >= b.maxElapsedMs) reason = `时长上限（${Math.round((Date.now() - first) / 60000)} 分钟）`;
  }
  if (reason) return { status: 'exhausted', reason, rounds, failed };
  if (b.maxStall && b.maxStall > 0) {
    let streak = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.outcome === 'validation_failed' || e.outcome === 'blocked') { streak += 1; continue; }
      if (e.outcome === 'started') continue; // started 不打断失败连击（重试轮）
      break; // passed / cleared / resumed 打断
    }
    if (streak >= b.maxStall) return { status: 'stalled', reason: `连续 ${streak} 轮无通过（maxStall=${b.maxStall}）`, rounds, failed };
  }
  return { status: 'running', reason: null, rounds, failed };
}
function cmdBudget(cwd, args) {
  const b = loadBudget(cwd);
  if (!args.length) {
    const st = queueState(cwd, loadTasks(cwd));
    console.log(`预算配置（${path.basename(cwd)}）：`);
    console.log(`  maxRounds=${b.maxRounds ?? '∞'}  maxFailed=${b.maxFailed ?? '∞'}  maxElapsedMs=${b.maxElapsedMs ?? '∞'}  maxStall=${b.maxStall}  regressOnPass=${b.regressOnPass}  staleMs=${b.staleMs}`);
    console.log(`队列状态：${st.status}${st.reason ? `（${st.reason}）` : ''}  ${st.rounds} 轮 / ${st.failed} 失败`);
    return;
  }
  const [key, val] = args;
  if (!(key in BUDGET_DEFAULTS)) { console.log(`未知预算项：${key}。可选：${Object.keys(BUDGET_DEFAULTS).join(', ')}`); return failResult('INVALID_ARGUMENT', `未知预算项：${key}`, EXIT.USAGE); }
  let v;
  if (key === 'regressOnPass') v = val === 'true' || val === '1' || val === 'on';
  else if (key === 'staleMs') { v = (val === 'none' || val === '∞') ? null : parseInt(val, 10); if (v !== null && (!Number.isInteger(v) || v < 0)) { console.log(`预算值必须是非负整数、none 或 ∞：${val}`); return failResult('INVALID_ARGUMENT', `非法预算值：${val}`, EXIT.USAGE); } }
  else { v = (val === 'none' || val === '∞' || val === 'null') ? null : parseInt(val, 10); if (v !== null && (!Number.isInteger(v) || v < 0)) { console.log(`预算值必须是非负整数、none 或 ∞：${val}`); return failResult('INVALID_ARGUMENT', `非法预算值：${val}`, EXIT.USAGE); } }
  b[key] = v;
  saveBudget(cwd, b);
  console.log(`✓ 预算已设置：${key}=${v ?? '∞'}`);
  console.log('  命令：budget 查看；budget <key> <value> 设置；数值项用 none/∞ 清除');
}

// ── 健康检查与恢复重入（P0-3）────────────────────────────
function gitDirty(cwd) {
  try {
    const out = execSync('git status --porcelain', { cwd, encoding: 'utf-8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    return out.split('\n').map(x => x.trim()).filter(Boolean);
  } catch { return null; } // 非 git 仓库：无法判断
}

function checkUnenqueuedChanges(cwd, data, notes, dirtyLines) {
  try {
    if (!data || !dirtyLines || !dirtyLines.length) return;
    const hasProductChanges = dirtyLines.some(l => !l.includes('.rootagent/'));
    const inProgress = data.features.filter(f => f.status === 'in_progress');
    if (hasProductChanges && inProgress.length === 0) {
      notes.push('检测到工作区存在产品代码修改，但当前无 in_progress 任务。若在迭代本项目，建议通过 TASK.md -> rootagent add -> start 建立生命周期，避免 rounds.jsonl 漏记。');
    }
  } catch {}
}
function lastLedgerAt(cwd) {
  const tf = taskFiles(cwd);
  if (!fs.existsSync(tf.ledger)) return null;
  const lines = fs.readFileSync(tf.ledger, 'utf-8').trim().split('\n').filter(Boolean);
  if (!lines.length) return null;
  try { return JSON.parse(lines[lines.length - 1]).at; } catch { return null; }
}
function cmdDoctor(cwd) {
  const tf = taskFiles(cwd);
  const problems = [];
  const notes = [];
  const healthy = [];
  let data = null;
  if (!fs.existsSync(tf.tasks)) problems.push('缺少 tasks.json（未 init？）');
  else {
    try {
      data = loadTasks(cwd);
      healthy.push(`tasks.json 可解析（${data.features.length} 个任务）`);
      if (data.schemaVersion !== STATE_SCHEMA_VERSION) problems.push(`tasks.json schemaVersion=${data.schemaVersion}，期望 ${STATE_SCHEMA_VERSION}`);
      else healthy.push(`schemaVersion=${STATE_SCHEMA_VERSION}`);
      if (!Number.isInteger(data.revision) || data.revision < 0) problems.push('tasks.json revision 非法');
      else healthy.push(`revision=${data.revision}`);
      const ids = (data.features || []).map(t => t.id);
      if (new Set(ids).size !== ids.length) problems.push('存在重复 task id');
      for (const task of data.features || []) {
        if (task.status === 'in_progress') {
          const lease = assertAttempt(task);
          if (!lease.ok) problems.push(`[${task.id}] ${lease.reason}`);
        }
        if (task.status === 'completed' && task.receipt?.path) {
          const receiptFile = path.join(cwd, task.receipt.path);
          if (!fs.existsSync(receiptFile)) problems.push(`[${task.id}] completed 但 receipt 缺失：${task.receipt.path}`);
          else {
            try {
              const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf-8'));
              const claimed = receipt.digest;
              delete receipt.digest;
              const actual = sha256(receipt);
              if (claimed !== actual || task.receipt.digest !== claimed) problems.push(`[${task.id}] receipt digest 不匹配`);
            } catch (error) { problems.push(`[${task.id}] receipt 无法验证：${error.message}`); }
          }
        }
      }
      const cur = getInProgress(data);
      if (cur) healthy.push(`in_progress：${cur.id} ${cur.name}`);
      else notes.push('当前无 in_progress 任务');
      const st = queueState(cwd, data);
      if (st.status !== 'running') problems.push(`队列状态 ${st.status}（${st.reason}）`);
      if (cur) {
        const last = lastLedgerAt(cwd);
        const b = loadBudget(cwd);
        if (last && b.staleMs) {
          const mins = Math.round((Date.now() - new Date(last).getTime()) / 60000);
          if (mins > b.staleMs / 60000) problems.push(`任务 ${cur.id} 已停滞 ${mins} 分钟（超过 staleMs=${b.staleMs / 60000} 分钟），建议 resume 或 fail`);
        }
      }
    } catch (e) { problems.push(`tasks.json 无法解析：${e.message}`); }
  }
  if (!fs.existsSync(tf.ledger)) notes.push('台账 rounds.jsonl 尚未建立（尚无轮次）');
  else {
    try {
      const bad = fs.readFileSync(tf.ledger, 'utf-8').trim().split('\n').filter(Boolean).filter(l => { try { JSON.parse(l); return false; } catch { return true; } }).length;
      if (bad) problems.push(`台账有 ${bad} 行无法解析`); else healthy.push('台账 rounds.jsonl 可解析');
    } catch { problems.push('台账读取失败'); }
  }
  if (!fs.existsSync(tf.budget)) notes.push('budget.json 未建立（使用默认预算）');
  else { try { loadBudget(cwd); healthy.push('budget.json 可解析'); } catch { problems.push('budget.json 无法解析'); } }
  const dirty = gitDirty(cwd);
  if (dirty === null) notes.push('非 git 仓库，跳过工作区检查');
  else if (dirty.length) notes.push(`工作区有 ${dirty.length} 处未提交改动（提交后才能 pass）`);
  else healthy.push('工作区干净');
  checkUnenqueuedChanges(cwd, data, notes, dirty);
  if (fs.existsSync(tf.runtimeDir)) {
    const leftovers = [];
    const scan = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) scan(p);
        else if (/\.tmp(?:\.|$)/.test(entry.name)) leftovers.push(path.relative(cwd, p));
      }
    };
    scan(tf.runtimeDir);
    if (leftovers.length) problems.push(`发现 ${leftovers.length} 个原子写临时文件：${leftovers.slice(0, 3).join(', ')}`);
  }
  const control = auditControlStore(cwd);
  healthy.push(...control.healthy);
  problems.push(...control.problems);
  const orchestration = orchestrationHealth(cwd);
  healthy.push(...orchestration.healthy);
  problems.push(...orchestration.problems);
  healthy.forEach(l => console.log(`  ✓ ${l}`));
  notes.forEach(l => console.log(`  ~ ${l}`));
  problems.forEach(l => console.log(`  ✗ ${l}`));
  console.log(problems.length ? `DOCTOR: PROBLEMS - ${problems.length}` : 'DOCTOR: HEALTHY');
  return problems.length
    ? failResult('DOCTOR_PROBLEMS', `${problems.length} 个健康问题`, EXIT.STATE, { problems, notes })
    : successResult('HEALTHY', { notes });
}
function cmdResume(cwd, force) {
  const data = loadTasks(cwd);
  const st = queueState(cwd, data);
  if (st.status !== 'running') {
    // --force：人工确认介入（"卡住→人工接管→继续"）。stalled 可打断失败连击恢复；
    // exhausted 是预算硬上限，不因介入改变（需 budget 调整或 init）。
    if (!force || st.status !== 'stalled') { console.log(`RESUME: REFUSED - 队列状态 ${st.status}（${st.reason}）`); return failResult('RESUME_REFUSED', st.reason, st.status === 'exhausted' ? EXIT.EXHAUSTED : EXIT.BLOCKED); }
    appendLedger(cwd, { taskId: '—', taskName: '人工介入', outcome: 'resumed', durationMs: 0, retryCount: 0 });
    const st2 = queueState(cwd, data);
    if (st2.status !== 'running') { console.log(`RESUME: REFUSED - ${st2.status}（${st2.reason}）`); return failResult('RESUME_REFUSED', st2.reason, EXIT.BLOCKED); }
    console.log('RESUME: OK - 人工确认介入，失败连击已打断，队列恢复 running');
    console.log('  提示：连续失败已被人工接管（台账记 resumed）。继续：rootagent next / start');
    return;
  }
  const cur = getInProgress(data);
  if (cur) {
    const lease = assertAttempt(cur);
    if (!lease.ok) {
      if (!force) {
        console.log(`RESUME: REFUSED - ${lease.reason}；使用 resume --force 回收并创建新 Attempt`);
        return failResult('LEASE_EXPIRED', lease.reason, EXIT.CONFLICT);
      }
      const previous = cur.attempt ? { attemptId: cur.attempt.attemptId, fencingToken: cur.attempt.fencingToken } : null;
      beginAttempt(cwd, data, cur);
      commitTaskState(cwd, data, [{ taskId: cur.id, taskName: cur.name, outcome: 'resumed', reason: 'stale lease reclaimed', retryCount: cur.retryCount }]);
      console.log(`RESUME: OK - 已回收旧 Attempt ${previous?.attemptId || '(legacy)'}，新 attempt=${cur.attempt.attemptId}，fence=${cur.attempt.fencingToken}`);
      return successResult('LEASE_RECLAIMED', { taskId: cur.id, previous, attempt: cur.attempt });
    }
    appendLedger(cwd, { taskId: cur.id, taskName: cur.name, outcome: 'resumed', durationMs: durationSince(cur), retryCount: cur.retryCount });
    console.log(`RESUME: OK - 恢复任务 ${cur.id} ${cur.name}（台账已记 resumed）`);
    console.log('  闭环纪律：实现自测通过 → git commit 提交产品代码 → rootagent validate 冻结候选 → Checker 复核 → rootagent pass');
    return;
  }
  const next = getNextTask(data);
  if (!next) { console.log('RESUME: REFUSED - 没有可恢复或可开始的任务'); return failResult('RESUME_REFUSED', '没有可恢复或可开始的任务', EXIT.STATE); }
  beginAttempt(cwd, data, next);
  commitTaskState(cwd, data, [{ taskId: next.id, taskName: next.name, outcome: 'started', retryCount: next.retryCount }]);
  console.log(`RESUME: OK - 无 in_progress，已自动开始 ${next.id} ${next.name}`);
  console.log('  闭环纪律：实现自测通过 → git commit 提交产品代码 → rootagent validate 冻结候选 → Checker 复核 → rootagent pass');
}

// ── 教训库：curated memory（P1-6）────────────────────────
function lessonsFile(cwd) { return path.join(cwd, '.rootagent', 'lessons.jsonl'); }
function loadLessons(cwd) {
  const f = lessonsFile(cwd);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function saveLessons(cwd, lessons) {
  fs.mkdirSync(path.join(cwd, '.rootagent'), { recursive: true });
  atomicWriteFile(lessonsFile(cwd), lessons.map(l => JSON.stringify(l)).join('\n') + (lessons.length ? '\n' : ''), 'utf-8');
}
function cmdLesson(cwd, args) {
  const [sub, ...rest] = args;
  const lessons = loadLessons(cwd);
  if (sub === 'add') {
    const ei = rest.indexOf('--evidence');
    const text = ei === -1 ? rest.join(' ').trim() : rest.filter((_, i) => i !== ei && i !== ei + 1).join(' ').trim();
    const evidence = ei !== -1 ? rest.slice(ei + 1).join(' ').trim() : '';
    if (!text) { console.log('用法：lesson add "<教训>" [--evidence <证据>]'); return failResult('INVALID_ARGUMENT', '教训内容不能为空', EXIT.USAGE); }
    const id = `l${String(lessons.length + 1).padStart(3, '0')}`;
    lessons.push({ id, text, evidence, status: 'keep', at: new Date().toISOString() });
    saveLessons(cwd, lessons);
    console.log(`✓ 已沉淀教训 [${id}]：${text}${evidence ? `（证据：${evidence}）` : ''}`);
    return;
  }
  if (sub === 'keep' || sub === 'discard') {
    const id = rest[0];
    const l = lessons.find(x => x.id === id);
    if (!l) { console.log(`没有教训 ${id}。`); return failResult('NOT_FOUND', `没有教训 ${id}`, EXIT.STATE); }
    l.status = sub;
    saveLessons(cwd, lessons);
    console.log(`✓ [${id}] 已标记 ${l.status}`);
    return;
  }
  if (sub === 'list') {
    const onlyKeep = rest.includes('--keep');
    const list = lessons.filter(l => !onlyKeep || l.status === 'keep');
    if (!list.length) { console.log(onlyKeep ? '（没有 keep 状态的教训）' : '（教训库为空）'); return; }
    list.forEach(l => console.log(`  [${l.id}] ${l.status} ${l.text}${l.evidence ? ` — 证据：${l.evidence}` : ''}`));
    console.log(`教训：${lessons.filter(l => l.status === 'keep').length} keep / ${lessons.filter(l => l.status === 'discard').length} discard / 共 ${lessons.length}`);
    return;
  }
  console.log('用法：lesson add "<教训>" [--evidence <证据>] | lesson keep|discard <id> | lesson list [--keep]');
  return failResult('INVALID_ARGUMENT', '未知 lesson 子命令', EXIT.USAGE);
}
function recentKeepLessons(cwd, n = 3) {
  return loadLessons(cwd).filter(l => l.status === 'keep').slice(-n);
}

// 观测与成本（P1-7）：任务耗时与验证次数
function durationSince(t) {
  if (!t || !t.startedAt) return null;
  return Date.now() - new Date(t.startedAt).getTime();
}
function humanMs(ms) {
  if (ms == null || !isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}
function cmdCost(cwd) {
  const data = loadTasks(cwd);
  const entries = readLedger(cwd);
  const res = resultRounds(entries);
  const accepted = data.features.filter(f => f.status === 'completed').length;
  const fails = entries.filter(e => e.outcome === 'validation_failed' || e.outcome === 'blocked').length;
  const totalMs = entries.reduce((s, e) => s + (e.durationMs || 0), 0);
  const retryRate = res ? Math.round(fails / res * 100) : 0;
  console.log('成本（cost per accepted change）');
  console.log(`  已接受变更：${accepted}（completed 任务）`);
  console.log(`  总轮次：${res}（结果轮，不含 started）；失败轮：${fails}（${retryRate}% 失败率）`);
  console.log(`  时长口径：每接受变更 ${humanMs(accepted ? totalMs / accepted : 0)}（累计 ${humanMs(totalMs)}）`);
  console.log(`  轮次口径：每接受变更 ${accepted ? (res / accepted).toFixed(1) : '—'} 轮`);
  console.log('  token 口径：预留接口（需模型定价表，当前未计）');
}
function cmdTrend(cwd) {
  const all = readLedger(cwd);
  const entries = all.filter(e => e.outcome !== 'started'); // 结果轮口径
  const isFail = e => e.outcome === 'validation_failed' || e.outcome === 'blocked';
  const rate = es => (es.length ? es.filter(isFail).length / es.length : 0);
  if (entries.length < 4) { console.log(`TREND: INSUFFICIENT - 台账仅 ${entries.length} 轮，需至少 4 轮`); return failResult('INSUFFICIENT_DATA', '趋势分析至少需要 4 轮', EXIT.NOT_MET); }
  const half = Math.floor(entries.length / 2);
  const eRate = rate(entries.slice(0, half));
  const rRate = rate(entries.slice(half));
  if (rRate > eRate + 0.05) {
    console.log(`TREND: UP - 近段失败率 ${(rRate * 100).toFixed(0)}% 高于前段 ${(eRate * 100).toFixed(0)}%（+${((rRate - eRate) * 100).toFixed(0)}pp）`);
    const byTask = new Map();
    entries.slice(half).filter(isFail).forEach(e => {
      const key = (e.taskName || e.taskId || '?').slice(0, 24);
      byTask.set(key, (byTask.get(key) || 0) + 1);
    });
    console.log('  归因（近段失败任务 Top）：');
    [...byTask.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([k, v]) => console.log(`    - ${k} ×${v}`));
  } else {
    console.log(`TREND: FLAT/DOWN - 近段失败率 ${(rRate * 100).toFixed(0)}% vs 前段 ${(eRate * 100).toFixed(0)}%`);
  }
}

// ── 项目存储（.rootagent/）───────────────────────────────
function taskFiles(cwd) {
  return {
    dir: path.join(cwd, '.rootagent'),
    tasks: path.join(cwd, '.rootagent', 'tasks.json'),
    ledger: path.join(cwd, '.rootagent', 'rounds.jsonl'),
    budget: path.join(cwd, '.rootagent', 'budget.json'),
    taskMd: path.join(cwd, '.rootagent', 'TASK.md'),
    planMd: path.join(cwd, '.rootagent', 'PLAN.md'),
    doneDir: path.join(cwd, '.rootagent', 'tasks', 'done'),
    runtimeDir: path.join(cwd, '.rootagent', 'runtime'),
  };
}

// ── 任务数据 ──────────────────────────────────────────────
function loadTasks(cwd) {
  const tf = taskFiles(cwd);
  fs.mkdirSync(tf.dir, { recursive: true });
  recoverPendingTransaction(cwd);
  if (!fs.existsSync(tf.tasks)) {
    return { schemaVersion: STATE_SCHEMA_VERSION, revision: 0, nextFencingToken: 1, goal: '', goalCount: null, goalDefinition: null, createdAt: new Date().toISOString(), features: [], archive: [] };
  }
  const data = JSON.parse(fs.readFileSync(tf.tasks, 'utf-8'));
  if (data.goalCount === undefined) data.goalCount = null;
  if (data.goalDefinition === undefined) data.goalDefinition = null;
  if (!Number.isInteger(data.schemaVersion)) data.schemaVersion = STATE_SCHEMA_VERSION;
  if (!Number.isInteger(data.revision)) data.revision = 0;
  if (!Number.isInteger(data.nextFencingToken)) data.nextFencingToken = 1;
  for (const task of data.features || []) {
    if (!task.contractDigest) task.contractDigest = taskContractDigest(task);
    if (!Array.isArray(task.attestations)) task.attestations = [];
  }
  return data;
}
function diskRevision(file) {
  if (!fs.existsSync(file)) return 0;
  const current = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return Number.isInteger(current.revision) ? current.revision : 0;
}
function transactionFile(cwd) { return path.join(taskFiles(cwd).runtimeDir, 'transaction.json'); }
function normalizeEvent(entry) {
  return { eventId: entry.eventId || cryptoRandomId(), at: entry.at || new Date().toISOString(), ...entry };
}
function recoverPendingTransaction(cwd) {
  const file = transactionFile(cwd);
  if (!fs.existsSync(file)) return;
  const tx = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const tf = taskFiles(cwd);
  const currentRevision = diskRevision(tf.tasks);
  if (currentRevision === tx.expectedRevision) atomicWriteJson(tf.tasks, tx.snapshot);
  else if (currentRevision !== tx.targetRevision) {
    const error = new Error(`transaction revision conflict: expected ${tx.expectedRevision} or ${tx.targetRevision}, actual ${currentRevision}`);
    error.code = 'ROOTAGENT_REVISION_CONFLICT';
    throw error;
  }
  let ledgerText = '';
  try { ledgerText = fs.readFileSync(tf.ledger, 'utf-8'); } catch { /* empty */ }
  const rawLines = ledgerText.split('\n');
  const validLines = [];
  const eventIds = new Set();
  let repairedTail = false;
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      validLines.push(line);
      if (event.eventId) eventIds.add(event.eventId);
    } catch {
      if (i === rawLines.length - 1) repairedTail = true;
      else throw new Error(`rounds.jsonl 中间存在损坏事件（line ${i + 1}），拒绝自动恢复`);
    }
  }
  if (repairedTail) atomicWriteFile(tf.ledger, validLines.join('\n') + (validLines.length ? '\n' : ''));
  for (const event of tx.events || []) {
    if (!eventIds.has(event.eventId)) durableAppendJsonLine(tf.ledger, event);
  }
  fs.unlinkSync(file);
}
function commitTaskState(cwd, data, entries = [], expectedRevision = data.revision ?? 0) {
  const tf = taskFiles(cwd);
  fs.mkdirSync(tf.dir, { recursive: true });
  const actualRevision = diskRevision(tf.tasks);
  if (actualRevision !== expectedRevision) {
    const error = new Error(`revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    error.code = 'ROOTAGENT_REVISION_CONFLICT';
    error.expectedRevision = expectedRevision;
    error.actualRevision = actualRevision;
    throw error;
  }
  const snapshot = JSON.parse(JSON.stringify(data));
  snapshot.schemaVersion = STATE_SCHEMA_VERSION;
  snapshot.revision = expectedRevision + 1;
  snapshot.updatedAt = new Date().toISOString();
  const events = entries.map(normalizeEvent);
  const tx = { schemaVersion: 1, txId: cryptoRandomId(), expectedRevision, targetRevision: snapshot.revision, snapshot, events, createdAt: new Date().toISOString() };
  atomicWriteJson(transactionFile(cwd), tx);
  atomicWriteJson(tf.tasks, snapshot);
  for (const event of events) durableAppendJsonLine(tf.ledger, event);
  fs.unlinkSync(transactionFile(cwd));
  for (const key of Object.keys(data)) delete data[key];
  Object.assign(data, snapshot);
}
function saveTasks(cwd, data, expectedRevision = data.revision ?? 0) {
  commitTaskState(cwd, data, [], expectedRevision);
}
function appendLedger(cwd, entry) {
  const tf = taskFiles(cwd);
  fs.mkdirSync(tf.dir, { recursive: true });
  durableAppendJsonLine(tf.ledger, normalizeEvent(entry));
}

function cryptoRandomId() {
  return `ev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ── 队列与状态机 ──────────────────────────────────────────
function getInProgress(data) {
  return data.features.find(f => f.status === 'in_progress') || null;
}
function getNextTask(data) {
  const done = new Set(data.features.filter(f => f.status === 'completed').map(f => f.id));
  for (const f of data.features) {
    if (f.status !== 'decomposed') continue;
    const kids = data.features.filter(c => c.parentId === f.id);
    if (kids.length && kids.every(k => k.status === 'completed')) done.add(f.id);
  }
  return data.features
    .filter(f => f.status !== 'completed' && f.status !== 'decomposed' && f.status !== 'in_progress' && !f.blocked)
    .filter(f => (f.dependsOn || []).every(d => done.has(d)))
    .sort((a, b) => (a.priority || 999) - (b.priority || 999))[0] || null;
}
function findTask(data, id) {
  return data.features.find(f => f.id === id) || null;
}

// ── 契约解析 ──────────────────────────────────────────────
// 分节解析：节标题必须位于行首（(?:^|\n) 锚定，避免 m 标志让 $ 在每行行尾命中而截空分节）
// 注意：匹配可能吞入行首 \n，故逐行过滤标题行（## 开头）与空行
// 同时支持两种格式：
//   1. ## 验收标准（二级标题，用于 TASK.md）
//   2. 验收标准：（文本+冒号，用于 PLAN.md 任务块内）
function grabList(text, section) {
  const esc = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(?:^|\\n)(?:##\\s*)?${esc}[：:]?\\s*\\n([\\s\\S]*?)(?=(?:\\n##\\s|\\n\\S+[：:]\\s*\\n|\\s*$))`
  );
  const m = text.match(re);
  if (!m) return [];
  return m[1].split('\n')
    .map(l => l.replace(/^(?:[-*]|\d+[.、])\s*/, '').trim())
    .filter(l => l && !/^##/.test(l));
}
function grabIdList(text, section) {
  const esc = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(?:^|\\n)(?:##\\s*)?${esc}[：:]?\\s*\\n([\\s\\S]*?)(?=(?:\\n##\\s|\\n\\S+[：:]\\s*\\n|\\s*$))`
  );
  const m = text.match(re);
  if (!m) return [];
  return m[1].split('\n')
    .flatMap(l => l.replace(/^(?:[-*]|\d+[.、])\s*/, '').trim().split(/[\s,，、]+/))
    .filter(t => /^t\d+$/i.test(t));
}
// 验证命令解析：支持 `- [L2] cmd` / `- [L3] cmd` 前缀（P0-4），默认 L1
function parseVcList(list) {
  return list.map(c => {
    const m = c.match(/^\[([LV][0-5])\]\s*(.*)$/i);
    if (m && m[2]) return { cmd: m[2], level: parseInt(m[1].slice(1), 10), ladder: m[1][0].toUpperCase() };
    return { cmd: c, level: 1, ladder: 'L' };
  });
}
function normalizeVc(vc) {
  if (isCommandSpec(vc)) return { cmd: commandDisplay(vc), command: vc, level: Number.isInteger(vc.level) ? vc.level : 1, ladder: vc.ladder || 'L', mode: 'structured' };
  if (typeof vc === 'string') return { cmd: vc, command: vc, level: 1, ladder: 'L', mode: 'opaque-interactive' };
  return { cmd: (vc && vc.cmd) || '', command: vc, level: Number.isInteger(vc?.level) ? vc.level : 1, ladder: vc?.ladder || 'L', mode: 'opaque-interactive' };
}
function initializeTaskTrust(task) {
  task.attestations = Array.isArray(task.attestations) ? task.attestations : [];
  task.contractDigest = taskContractDigest(task);
  return task;
}
function transitionTask(task, next) {
  if (task.status === next) return;
  if (!canTransition(task.status, next)) {
    const error = new Error(`illegal task transition: ${task.status} -> ${next} (${task.id})`);
    error.code = 'ROOTAGENT_INVALID_TRANSITION';
    throw error;
  }
  task.status = next;
}
function beginAttempt(cwd, data, task) {
  const leaseMs = loadBudget(cwd).staleMs || 30 * 60 * 1000;
  const token = data.nextFencingToken || 1;
  data.nextFencingToken = token + 1;
  task.attempt = createAttempt(cwd, task, token, leaseMs);
  task.candidate = null;
  task.attestations = [];
  task.hostExecutions = [];
  task.hostCapabilityEvidence = [];
  task.reviewedAt = null;
  task.approval = null;
  if (task.status !== 'in_progress') transitionTask(task, 'in_progress');
  task.startedAt = new Date().toISOString();
  return task.attempt;
}
function parseHostPolicySection(text) {
  const match = String(text || '').match(/(?:^|\n)##\s*Agent Host Policy\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (!match) return { hostPolicy: undefined, hostPolicyError: null };
  let raw = match[1].trim();
  raw = raw.replace(/^\`\`\`(?:json)?\s*\n?/i, '').replace(/\n?\`\`\`\s*$/i, '').trim();
  if (!raw) return { hostPolicy: undefined, hostPolicyError: 'Agent Host Policy 不能为空；不需要时删除该标题' };
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (error) { return { hostPolicy: undefined, hostPolicyError: 'Agent Host Policy JSON 无法解析：' + error.message }; }
  const checked = validateHostPolicy(parsed);
  if (!checked.ok) {
    return { hostPolicy: undefined, hostPolicyError: checked.errors.map(item => item.code + (item.role ? ':' + item.role : '')).join('；') };
  }
  return { hostPolicy: checked.policy, hostPolicyError: null };
}

function parseTaskFromMd(cwd) {
  const md = taskFiles(cwd).taskMd;
  if (!fs.existsSync(md)) return { description: '', acceptanceCriteria: [], validationCommands: [], dependsOn: [], writes: [], parentId: null, requiresReview: false, hostPolicy: undefined, hostPolicyError: null };
  const text = fs.readFileSync(md, 'utf-8');
  const host = parseHostPolicySection(text);
  const descM = text.match(/(?:^|\n)##\s*描述\s*\n([\s\S]*?)(?=\n##\s|$)/);
  const parents = grabIdList(text, '父任务');
  const criteria = grabList(text, '验收标准');
  const requiresReview = grabList(text, '审批').length > 0 || criteria.some(c => c.startsWith('[审批]'));
  return {
    description: descM ? descM[1].trim().slice(0, 500) : '',
    acceptanceCriteria: criteria,
    validationCommands: parseVcList(grabList(text, '验证命令')),
    dependsOn: grabIdList(text, '依赖'),
    writes: grabList(text, '写目标'),
    parentId: parents[0] || null,
    requiresReview,
    hostPolicy: host.hostPolicy,
    hostPolicyError: host.hostPolicyError,
  };
}
function parsePlanFromMd(cwd) {
  const md = taskFiles(cwd).planMd;
  if (!fs.existsSync(md)) return { goal: '', tasks: [] };
  const text = fs.readFileSync(md, 'utf-8');
  const goalM = text.match(/##\s*目标\s*\n([\s\S]*?)(?=\n##\s|$)/);
  const taskListSectionMatch = text.match(/##\s*任务清单\s*\n([\s\S]*)$/);
  const taskSectionText = taskListSectionMatch ? taskListSectionMatch[1] : text;
  const blocks = taskSectionText.split(/^###\s+/m).slice(1);
  const tasks = [];
  for (const b of blocks) {
    const lines = b.trim().split('\n');
    const name = lines[0].trim();
    const body = lines.slice(1).join('\n');
    const descM = body.match(/描述[:：]\s*\n?([\s\S]*?)(?=\n验收标准|\n验证命令|$)/);
    const depM = body.match(/依赖[:：]\s*([^\n]+)/);
    const wrtM = body.match(/写目标[:：]\s*([^\n]+)/);
    const parM = body.match(/父任务[:：]\s*([^\n]+)/);
    const aprM = body.match(/审批[:：]\s*([^\n]+)/);
    tasks.push({
      name,
      description: descM ? descM[1].trim().slice(0, 500) : name,
      acceptanceCriteria: grabList(body, '验收标准'),
      validationCommands: parseVcList(grabList(body, '验证命令')),
      dependsOn: depM ? depM[1].split(/[\s,，、]+/).filter(t => /^t\d+$/i.test(t)) : [],
      writes: wrtM ? wrtM[1].split(/[\s,，、]+/).map(s => s.trim()).filter(Boolean) : [],
      parentId: parM ? (parM[1].match(/t\d+/i) || [null])[0] : null,
      requiresReview: !!aprM || grabList(body, '验收标准').some(c => c.startsWith('[审批]')),
    });
  }
  return { goal: goalM ? goalM[1].trim() : '', tasks };
}

// ── 命令实现 ──────────────────────────────────────────────
function cmdInit(cwd, goal) {
  const data = loadTasks(cwd);
  if (data.features.length) {
    data.archive.push({ archivedAt: new Date().toISOString(), goal: data.goal, features: data.features });
  }
  data.goal = goal;
  data.goalCount = null;
  data.features = [];
  saveTasks(cwd, data);
  console.log(`✓ 任务队列已初始化，目标：${goal || '(未设置)'}`);
}

// 依赖图校验：id 必须存在、不得自依赖、整体无环；返回错误信息或 null（P0-2）
function validateDeps(existing, newTasks) {
  const graph = new Map();
  existing.forEach(f => graph.set(f.id, new Set(f.dependsOn || [])));
  newTasks.forEach(t => graph.set(t.id, new Set(t.dependsOn || [])));
  for (const [id, deps] of graph) {
    for (const d of deps) {
      if (d === id) return `[${id}] 任务不能依赖自己：${d}`;
      if (!graph.has(d)) return `[${id}] 依赖的任务不存在：${d}`;
    }
  }
  // 边方向：依赖 d → 任务 id（deps[id] 即指向 id 的全部入边），入度 = deps.size
  const indeg = new Map(); for (const [id, deps] of graph) indeg.set(id, deps.size);
  const q = [...indeg.keys()].filter(id => indeg.get(id) === 0).sort();
  let seen = 0;
  while (q.length) {
    const id = q.shift(); seen += 1;
    for (const [tid, deps] of graph) if (deps.has(id)) { indeg.set(tid, indeg.get(tid) - 1); if (indeg.get(tid) === 0) q.push(tid); }
  }
  if (seen !== graph.size) return '存在依赖环';
  return null;
}
function parseFlagList(args, flag) {
  const i = (args || []).indexOf(flag);
  return i !== -1 ? String(args[i + 1] || '').split(',').map(s => s.trim()).filter(Boolean) : [];
}
function parseDependsFlag(args) { return parseFlagList(args, '--depends'); }
function parseWritesFlag(args) { return parseFlagList(args, '--writes'); }
function parseParentFlag(args) {
  const i = (args || []).indexOf('--parent');
  return i !== -1 ? String(args[i + 1] || '').trim() : '';
}
function cmdAdd(cwd, name, args) {
  const data = loadTasks(cwd);
  const t = parseTaskFromMd(cwd);
  if (t.hostPolicyError) {
    console.log('✗ Agent Host Policy 非法：' + t.hostPolicyError);
    return failResult('INVALID_HOST_POLICY', t.hostPolicyError, EXIT.USAGE);
  }
  if (!t.acceptanceCriteria.length || !t.validationCommands.length) {
    console.log('✗ 任务契约不完整：至少需要 1 条验收标准和 1 条验证命令。');
    return failResult('INVALID_CONTRACT', '验收标准和验证命令不能为空', EXIT.USAGE);
  }
  const acceptanceQuality = evaluateAcceptanceCriteria(t.acceptanceCriteria);
  if (!acceptanceQuality.ok) {
    console.log('✗ 验收标准质量门禁未通过：');
    acceptanceQuality.errors.forEach(item => console.log('  - ' + formatAcceptanceFinding(item)));
    return failResult('ACCEPTANCE_CRITERIA_QUALITY_FAILED', '存在不可验证或只描述实现手段的验收标准', EXIT.USAGE, {
      errors: acceptanceQuality.errors,
      warnings: acceptanceQuality.warnings,
    });
  }
  if (acceptanceQuality.warnings.length) {
    console.log('~ 验收标准质量警告：');
    acceptanceQuality.warnings.forEach(item => console.log('  - ' + formatAcceptanceFinding(item)));
  }
  const n = data.features.length + 1;
  const id = `t${String(n).padStart(3, '0')}`;
  const dependsOn = [...new Set([...t.dependsOn, ...parseDependsFlag(args)])];
  const parentId = t.parentId || parseParentFlag(args) || null;
  if (parentId && !data.features.some(f => f.id === parentId)) {
    console.log(`✗ 父任务不存在：${parentId}，任务未入队。`);
    return failResult('INVALID_DEPENDENCY', `父任务不存在：${parentId}`, EXIT.STATE);
  }
  const candidate = {
    id,
    name,
    description: t.description || name,
    priority: n,
    status: 'pending',
    acceptanceCriteria: t.acceptanceCriteria,
    validationCommands: t.validationCommands,
    dependsOn,
    writes: [...new Set([...(t.writes || []), ...parseWritesFlag(args)])],
    parentId,
    requiresReview: t.requiresReview || false,
    ...(t.hostPolicy !== undefined ? { hostPolicy: t.hostPolicy } : {}),
    retryCount: 0,
    blocked: false,
    validationHistory: [],
    attestations: [],
    commit: '',
  };
  initializeTaskTrust(candidate);
  const err = validateDeps(data.features, [candidate]);
  if (err) { console.log(`✗ 依赖校验失败：${err}，任务未入队。`); return failResult('INVALID_DEPENDENCY', err, EXIT.STATE); }
  if (parentId) {
    const parent = findTask(data, parentId);
    if (parent?.status === 'pending') transitionTask(parent, 'decomposed');
  }
  data.features.push(candidate);
  saveTasks(cwd, data);
  console.log(`✓ 已加入任务 [${candidate.id}] ${candidate.name}`);
  if (dependsOn.length) console.log(`  依赖：${dependsOn.join(', ')}`);
  if (candidate.writes.length) console.log(`  写目标：${candidate.writes.join(', ')}`);
  if (candidate.parentId) console.log(`  父任务：${candidate.parentId}`);
  console.log(`  验收标准 ${candidate.acceptanceCriteria.length} 条，验证命令 ${candidate.validationCommands.length} 条`);
  console.log('  提示：把 .rootagent/TASK.md 归档到 .rootagent/tasks/done/ 后，再为下一个任务写新的 .rootagent/TASK.md');
}

function cmdNext(cwd) {
  const data = loadTasks(cwd);
  const curs = data.features.filter(f => f.status === 'in_progress');
  if (curs.length) {
    console.log(`▶ 当前进行中：${curs.map(c => `${c.id} ${c.name}`).join('；')} —— 先 validate/pass/fail 处理，再取下一个。`);
    return;
  }
  const t = getNextTask(data);
  if (!t) { console.log('队列里没有可执行任务（全部完成或被阻塞）。'); return; }
  console.log(`▶ 下一个任务 [${t.id}] ${t.name}  (优先级 ${t.priority}${t.retryCount ? `, 已重试 ${t.retryCount} 次` : ''})`);
  console.log(`\n  描述：${t.description}`);
  if (t.acceptanceCriteria.length) {
    console.log('\n  验收标准：');
    t.acceptanceCriteria.forEach((c, i) => console.log(`    ${i + 1}. ${c}`));
  }
  if (t.validationCommands.length) {
    console.log('\n  验证命令（硬验证，引擎亲自跑）：');
    t.validationCommands.map(normalizeVc).forEach(v => console.log(`    $ [L${v.level}] ${v.cmd}`));
  }
  if (t.hostPolicy) {
    console.log('\n  Agent Host Policy：requiredRoles=' + (t.hostPolicy.requiredRoles || []).join(',') + ' distinctExecutionIds=' + !!t.hostPolicy.requireDistinctExecutionIds);
  }
  if (t.repairFocus) {
    console.log('\n  RootAgent 当前修复焦点（优先处理这一项）：');
    console.log(`    - [${t.repairFocus.category}] ${t.repairFocus.label}（selector=${t.repairFocus.selection?.provider || 'deterministic'}）`);
  }
  if (t.validationHistory.length) {
    console.log('\n  上次失败原因（先修这些，别原样重做）：');
    t.validationHistory.slice(-2).forEach(h => console.log(`    - ${h.notes}`));
  }
  const lessons = recentKeepLessons(cwd);
  if (lessons.length) {
    console.log('\n  相关教训（keep）：');
    lessons.forEach(l => console.log(`    - [${l.id}] ${l.text}${l.evidence ? ` — 证据：${l.evidence}` : ''}`));
  }
  console.log('\n  就绪后可执行：rootagent start（锁定后 validate/pass/fail）');
}

function cmdStart(cwd, args) {
  const data = loadTasks(cwd);
  const st = queueState(cwd, data);
  if (st.status !== 'running') {
    console.log(`✗ 队列状态 ${st.status}（${st.reason}），停止接新任务。调整预算或 clear 后继续。`);
    return failResult(st.status === 'exhausted' ? 'EXHAUSTED' : 'STALLED', st.reason, st.status === 'exhausted' ? EXIT.EXHAUSTED : EXIT.BLOCKED);
  }
  const pi = (args || []).indexOf('--parallel');
  if (pi !== -1) {
    const isolation = optionValue(args, '--isolation') || 'auto';
    if (!['auto', 'lightweight', 'worktree'].includes(isolation)) return failResult('INVALID_ARGUMENT', '--isolation 必须是 auto/lightweight/worktree', EXIT.USAGE);
    const rawIds = String(args[pi + 1] || '').split(',').map(a => a.trim()).filter(Boolean);
    const ids = [...new Set(rawIds)];
    const doneSet = new Set(data.features.filter(f => f.status === 'completed').map(f => f.id));
    const problems = [];
    if (ids.length !== rawIds.length) problems.push('并行任务 id 重复');
    const picks = [];
    for (const id of ids) {
      const f = findTask(data, id);
      if (!f) { problems.push(`任务不存在：${id}`); continue; }
      if (f.status !== 'pending') { problems.push(`[${f.id}] 状态为 ${f.status}，并行只能锁定 pending`); continue; }
      if (!(f.dependsOn || []).every(d => doneSet.has(d))) { problems.push(`[${f.id}] 依赖未就绪`); continue; }
      picks.push(f);
    }
    const existing = data.features.filter(f => f.status === 'in_progress');
    const classified = classifyParallelIsolation([...existing, ...picks], { git: isGitProject(cwd) });
    problems.push(...classified.errors);
    if (classified.decision === 'SERIAL_REQUIRED') problems.push(...classified.reasons);
    if (isolation === 'lightweight' && classified.decision !== 'LIGHTWEIGHT') problems.push(`显式 lightweight 无法覆盖保守判定：${classified.decision || 'CONTRACT_INCOMPLETE'}`);
    if (problems.length) {
      console.log('✗ 并行 start 被拒绝：');
      problems.forEach(p => console.log('  - ' + p));
      console.log('  补齐结构化契约、选择 worktree，或改为串行 start。');
      return failResult('START_REJECTED', problems.join('；'), EXIT.CONFLICT, { problems });
    }
    if (!picks.length) { console.log('没有可并行锁定的任务。'); return failResult('NO_READY_TASK', '没有可并行锁定的任务', EXIT.STATE); }
    const decision = isolation === 'worktree' ? 'WORKTREE_REQUIRED' : classified.decision;
    let preflight = null; const workspaces = [];
    try {
      if (decision === 'WORKTREE_REQUIRED') preflight = preflightWorkspaceBatch(cwd, picks);
      picks.forEach(f => { beginAttempt(cwd, data, f); f.attempt.isolationDecision = decision; f.attempt.isolationReasons = classified.reasons; });
      if (decision === 'WORKTREE_REQUIRED') {
        for (let i = 0; i < picks.length; i++) {
          const descriptor = preflight.descriptors.find(item => item.taskId === picks[i].id);
          const workspace = createWorkspace(cwd, picks[i], { workspaceId: descriptor.workspaceId, base: descriptor.baseCommit });
          workspaces.push(workspace); picks[i].attempt.workspaceId = workspace.workspaceId; picks[i].attempt.runtimeStatus = workspace.runtimeStatus;
          if (process.env.ROOTAGENT_TEST_FAIL_WORKTREE_AFTER === String(i + 1)) throw Object.assign(new Error(`故障注入：第 ${i + 1} 个 worktree 后失败`), { code: 'WORKTREE_BATCH_INJECTED_FAILURE' });
        }
      }
    } catch (error) {
      if (workspaces.length) rollbackWorkspaceBatch(cwd, workspaces, error.message);
      console.log(`✗ 并行 worktree 批次已全量回滚：${error.message}`);
      return failResult(error.code || 'WORKTREE_BATCH_FAILED', error.message, EXIT.CONFLICT, { rolledBack: workspaces.map(item => item.workspaceId) });
    }
    commitTaskState(cwd, data, picks.map(f => ({ taskId: f.id, taskName: f.name, outcome: 'started', retryCount: f.retryCount })));
    console.log(`▶ 已并行锁定 ${picks.length} 个任务：${picks.map(f => f.id).join(', ')}（${decision}）`);
    classified.reasons.forEach(reason => console.log(`  判定：${reason}`));
    console.log(`  Attempts：${picks.map(f => `${f.id}(attempt=${f.attempt.attemptId}, fence=${f.attempt.fencingToken})`).join(', ')}`);
    console.log('  定向操作需带 id：validate/pass/fail <id>');
    return successResult('ATTEMPTS_STARTED', { isolationDecision: decision, reasons: classified.reasons, tasks: picks.map(f => ({ taskId: f.id, attemptId: f.attempt.attemptId, fencingToken: f.attempt.fencingToken, workspaceId: f.attempt.workspaceId || null, runtimeStatus: f.attempt.runtimeStatus || 'NOT_APPLICABLE' })), workspaces });
  }
  const cur = getInProgress(data);
  if (cur) {
    console.log(`✗ 已有进行中任务 [${cur.id}] ${cur.name}。一次只做一个——先 validate/pass/fail 处理它。`);
    return failResult('START_REJECTED', `已有进行中任务 ${cur.id}`, EXIT.CONFLICT);
  }
  const requested = optionValue(args, '--task');
  const t = requested ? data.features.find(f => f.id === requested && f.status === 'pending' && (f.dependsOn || []).every(id => data.features.some(d => d.id === id && d.status === 'completed'))) : getNextTask(data);
  if (!t) { console.log('没有可执行任务。'); return failResult('NO_READY_TASK', '没有可执行任务', EXIT.STATE); }
  beginAttempt(cwd, data, t);
  if (t.proposalSource) projectAutomatedTask(cwd, t);
  commitTaskState(cwd, data, [{ taskId: t.id, taskName: t.name, outcome: 'started', retryCount: t.retryCount }]);
  console.log(`▶ 已锁定 [${t.id}] ${t.name}（in_progress，attempt=${t.attempt.attemptId}，fence=${t.attempt.fencingToken}，leaseUntil=${t.attempt.leaseUntil}）。`);
  console.log('  Maker 铁律：实现自测通过后，必须主动执行 git commit 提交产品代码，然后由 rootagent validate 冻结候选（无需用户催促！）。');
  return successResult('ATTEMPT_STARTED', { taskId: t.id, attemptId: t.attempt.attemptId, fencingToken: t.attempt.fencingToken, leaseUntil: t.attempt.leaseUntil });
}

function runCmd(cmd, cwd, extraEnv, envRestricted, timeoutMs = 300000) {
  try {
    return executeCommand(cwd, cmd, { env: extraEnv, timeoutMs });
  } catch (e) {
    return { ok: false, code: e.status ?? 1, out: String(e.message || ''), errorCode: e.code };
  }
}

function taskSecurityCommands(cwd, task) {
  const validations = (task?.validationCommands || []).filter(item => commandDisplay(item));
  const hooks = Object.values(loadHooks(cwd)).flat().filter(Boolean).map(cmd => ({ cmd, level: 1, ladder: 'V' }));
  return [...validations, ...hooks];
}

function prepareSecurity(cwd, commands, scope = 'validation', runControls = true) {
  const policy = loadSecurityPolicy(cwd);
  if (!policy) {
    if (process.env.ROOTAGENT_UNATTENDED === '1') assertProjectTrust(cwd, commands, scope);
    return { policy: null, legacy: true, controls: [] };
  }
  const verified = checkTrustedVerifiers(cwd, commands, { scope });
  const controls = runControls ? runNegativeControls(cwd, policy, verified.trust) : [];
  const failed = controls.filter(item => item.verdict === 'FAIL');
  const infrastructure = controls.filter(item => item.verdict === 'INFRASTRUCTURE');
  if (failed.length || infrastructure.length) {
    const parts = [];
    if (failed.length) parts.push(`${failed.length} 个 negative control 未匹配预期断言失败`);
    if (infrastructure.length) parts.push(`${infrastructure.length} 个 negative control 发生基础设施错误`);
    const error = new Error(parts.join('；'));
    error.code = infrastructure.length ? 'NEGATIVE_CONTROL_INFRASTRUCTURE' : 'NEGATIVE_CONTROL_FAILED'; error.data = { controls, failed, infrastructure };
    throw error;
  }
  return { policy, verified, controls, configDigest: verified.trust.configDigest };
}

function executeTrusted(cwd, command, security, extraEnv = {}, options = {}) {
  if (options.automated && isCommandSpec(command) && command.network === 'allow' && !security?.policy) {
    const error = new Error('自动化命令请求网络，但项目没有受信 security policy'); error.code = 'NETWORK_NOT_AUTHORIZED'; throw error;
  }
  return security?.policy
    ? secureExecute(cwd, command, security.policy, { env: extraEnv, ...options })
    : executeCommand(cwd, command, { env: extraEnv, ...options });
}

function securityFailure(error, fallback = 'SECURITY_ERROR') {
  console.log(`✗ ${error.message}`);
  const policyCodes = ['SECURITY_NOT_INITIALIZED', 'PROJECT_TRUST_REQUIRED', 'TRUST_RECORD_CORRUPT', 'VERIFIER_TAMPERED', 'UNTRUSTED_VERIFIER', 'NEGATIVE_CONTROL_MISSING', 'NEGATIVE_CONTROL_FAILED', 'NEGATIVE_CONTROL_INFRASTRUCTURE', 'SANDBOX_UNAVAILABLE'];
  return failResult(error.code || fallback, error.message, policyCodes.includes(error.code) ? EXIT.POLICY : EXIT.VALIDATION, error.data || {});
}

function optionValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}
// 受限环境（P2-9）：白名单 env + ROOTAGENT_VALIDATE=1，剥掉其余注入面
function restrictedEnv(extra) {
  const env = { PATH: process.env.PATH || '', ROOTAGENT_VALIDATE: '1' };
  for (const k of ['HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']) if (process.env[k] != null) env[k] = process.env[k];
  if (extra) Object.assign(env, extra);
  return env;
}
// 定向解析（P1-5）：有 id 且为 in_progress 用之；无 id 时单 in_progress 用之，多个必须指定
function resolveTarget(cwd, data, idArg, verb, requireLease = true, suppliedLease = {}) {
  let target = null;
  if (idArg) {
    const f = findTask(data, idArg);
    if (!f) { console.log(`没有任务 ${idArg}。`); failResult('NOT_FOUND', `没有任务 ${idArg}`, EXIT.STATE); return null; }
    if (f.status !== 'in_progress') { console.log(`[${f.id}] 状态为 ${f.status}，${verb} 只作用于 in_progress。`); failResult('INVALID_STATE', `${verb} 只作用于 in_progress`, EXIT.STATE); return null; }
    target = f;
  } else {
    const curs = data.features.filter(f => f.status === 'in_progress');
    if (!curs.length) { console.log('没有进行中任务。先 rootagent start 锁定一个。'); failResult('INVALID_STATE', '没有进行中任务', EXIT.STATE); return null; }
    if (curs.length > 1) { console.log(`有 ${curs.length} 个进行中任务（${curs.map(f => f.id).join(', ')}），请指定 id：${verb} <id>`); failResult('AMBIGUOUS_TARGET', '多个进行中任务，必须指定 id', EXIT.USAGE); return null; }
    target = curs[0];
  }
  if (requireLease) {
    const lease = assertAttempt(target, suppliedLease);
    if (!lease.ok) {
      console.log(`✗ [${target.id}] ${lease.reason}，${verb} 被拒绝。`);
      failResult('LEASE_REJECTED', lease.reason, EXIT.CONFLICT);
      return null;
    }
  }
  return target;
}
function cmdValidate(cwd, idArg, dryRun, suppliedLease = {}) {
  const data = loadTasks(cwd);
  const t = resolveTarget(cwd, data, idArg, 'validate', true, suppliedLease);
  if (!t) return;
  const actualContractDigest = taskContractDigest(t);
  if (actualContractDigest !== t.contractDigest) {
    console.log(`✗ [${t.id}] 任务契约已被入队后修改（digest mismatch），拒绝验证；请新建任务或显式迁移契约。`);
    return failResult('CONTRACT_TAMPERED', '任务契约摘要不匹配', EXIT.CONFLICT, { expected: t.contractDigest, actual: actualContractDigest });
  }
  const vcs = (t.validationCommands || []).map(normalizeVc).filter(v => v.cmd);
  if (!vcs.length) {
    console.log(`⚠ [${t.id}] 没有验证命令，只能靠 AI 语义验证。建议补上（如 npm run build）。`);
    return failResult('VALIDATION_MISSING', '没有验证命令', EXIT.VALIDATION);
  }
  // 任一新的真实验证尝试都会撤销旧 Candidate/证明；失败不能回退复用上一次绿灯。
  if (!dryRun) { t.candidate = null; t.attestations = []; }
  // 验证器必须是只读观察者：先冻结验证前 Product tree，所有命令/hook/trust check 完成后再比较。
  // .rootagent/**、.git/** 与 gitignore 排除项不属于 Product Candidate，不会触发此稳定性门。
  const productTreeBeforeValidation = dryRun ? null : projectTreeHash(cwd);
  // 策略扫描（P2-9）：deny 无条件拦截；approve 需已 review --approve
  const p = loadPolicy(cwd);
  const hv = loadHooks(cwd);
  let security;
  try { security = prepareSecurity(cwd, taskSecurityCommands(cwd, t), 'validation', !dryRun); }
  catch (error) { if (!dryRun) saveTasks(cwd, data); return securityFailure(error); }
  const scanned = vcs.map(vc => {
    const s = policyScan(p, vc.cmd);
    if (!s.blocked) return { vc, verdict: 'ok' };
    if (s.requireApprove && t.reviewedAt) return { vc, verdict: 'approved', s };
    return { vc, verdict: 'blocked', s };
  });
  const blockedN = scanned.filter(x => x.verdict === 'blocked').length;
  if (dryRun) {
    console.log(`dry-run [${t.id}] ${t.name}（只报告，不执行）\n`);
    scanned.forEach(({ vc, verdict, s }) => {
      const L = `[${vc.ladder || 'L'}${vc.level}]`;
      if (verdict === 'blocked') console.log(`✗ ${L} $ ${vc.cmd} — 策略拦截：${s.requireApprove ? `「${s.rule}」需人工审批（review --approve）` : `deny「${s.rule}」`}`);
      else if (verdict === 'approved') console.log(`✓ ${L} $ ${vc.cmd} — 已审批放行（${s.rule}）`);
      else console.log(`○ ${L} $ ${vc.cmd} — 放行`);
    });
    if (security.policy) console.log(`○ security trust=${security.verified.trust.approval.approvalId} sandbox=${detectSandboxBackend().backend}`);
    console.log(blockedN ? `DRY-RUN: FAIL - ${blockedN} 条被策略拦截` : 'DRY-RUN: PASS - 全部放行');
    return blockedN === 0
      ? successResult('DRY_RUN_PASS', { taskId: t.id })
      : failResult('POLICY_BLOCKED', `${blockedN} 条命令被策略拦截`, EXIT.POLICY, { taskId: t.id, blocked: blockedN });
  }
  let allOk = true;
  let candidateInstability = null;
  const checkEvidence = [...(security.controls || []).map(control => ({ type: 'negative-control', ...control }))];
  console.log(`硬验证 [${t.id}] ${t.name}\n`);
  // before_validate hook（P2-10）：与验证命令共享外部 trust 与 OS sandbox
  if (!runHooks(cwd, hv.before_validate, 'before_validate', security)) {
    saveTasks(cwd, data);
    console.log('硬验证结果：HARD FAIL（before_validate hook 拦截）');
    return failResult('VALIDATION_FAILED', 'before_validate hook 拦截', EXIT.VALIDATION);
  }
  for (const { vc, verdict, s } of scanned) {
    const L = `[${vc.ladder || 'L'}${vc.level}]`;
    if (vc.ladder === 'V' && vc.level >= 4) {
      console.log(`✗ ${L} $ ${vc.cmd} — V4/V5 是 Checker/人工门，不允许伪装成 shell 验证命令`);
      allOk = false;
      checkEvidence.push({ cmd: vc.cmd, level: vc.level, verdict: 'FAIL', reason: 'EXTERNAL_GATE_REQUIRED' });
      continue;
    }
    if (verdict === 'blocked') {
      console.log(`✗ ${L} $ ${vc.cmd} — 策略拦截（不执行）：${s.requireApprove ? `「${s.rule}」需人工审批（review --approve）` : `deny「${s.rule}」`}`);
      allOk = false;
      checkEvidence.push({ cmd: vc.cmd, level: vc.level, verdict: 'FAIL', reason: 'POLICY_BLOCKED' });
      continue;
    }
    if (vc.mode === 'opaque-interactive') {
      const hints = legacyCommandWarnings(vc.command);
      console.log(`⚠ ${L} opaque-interactive：旧字符串命令仅限当前人工会话，未作为安全边界解析${hints.length ? `；静态提示：${hints.join('、')}` : ''}`);
    }
    const r = security.policy ? executeTrusted(cwd, vc.command, security, {}, { validation: true }) : executeCommand(cwd, vc.command, { validation: true });
    if (!r.ok) {
      console.log(`✗ ${L} $ ${vc.cmd}\n${r.out.trim().split('\n').slice(-10).join('\n')}\n`);
      allOk = false;
      checkEvidence.push({ cmd: vc.cmd, level: vc.level, verdict: 'FAIL', exitCode: r.code, outputDigest: sha256(r.out), outputTail: r.out.trim().split('\n').slice(-10), securityReceipt: r.receipt || null });
      continue;
    }
    const okCount = (r.out.match(/^\s*ok - /gm) || []).length;
    if (vc.level >= 2 && okCount === 0) {
      console.log(`✗ ${L} $ ${vc.cmd} — 测试通过但无任何断言（ok - 行 = 0），疑似空转/假绿\n${r.out.trim().split('\n').slice(-5).join('\n')}\n`);
      allOk = false;
      checkEvidence.push({ cmd: vc.cmd, level: vc.level, verdict: 'FAIL', exitCode: 0, reason: 'NO_ASSERTIONS', outputDigest: sha256(r.out) });
      continue;
    }
    if (vc.level >= 3 && !security.policy) {
      const red = executeTrusted(cwd, vc.command, security, { RA_RED: '1' }, { validation: true });
      if (red.ok) {
        console.log(`✗ ${L} $ ${vc.cmd} — 红绿自证失败：红对照（RA_RED=1）仍为绿，测试无法证伪自己\n`);
        allOk = false;
        checkEvidence.push({ cmd: vc.cmd, level: vc.level, verdict: 'FAIL', exitCode: 0, reason: 'RED_CONTROL_STAYED_GREEN', outputDigest: sha256(r.out) });
        continue;
      }
      checkEvidence.push({ cmd: vc.cmd, level: vc.level, verdict: 'PASS', exitCode: 0, assertions: okCount, redExitCode: red.code, outputDigest: sha256(r.out), securityReceipt: r.receipt || null });
      console.log(`✓ ${L} $ ${vc.cmd}\n${r.out.trim().split('\n').slice(-5).join('\n') || '(无输出)'}\n  → 断言 ${okCount} 条；红对照 exit=${red.code}（红）✓ 可证伪\n`);
      continue;
    }
    checkEvidence.push({ cmd: vc.cmd, level: vc.level, verdict: 'PASS', exitCode: 0, assertions: okCount, outputDigest: sha256(r.out), securityReceipt: r.receipt || null });
    console.log(`✓ ${L} $ ${vc.cmd}\n${r.out.trim().split('\n').slice(-5).join('\n') || '(无输出)'}\n${vc.level >= 2 ? `  → 断言 ${okCount} 条 ✓\n` : ''}`);
  }
  if (allOk) {
    // after_validate hook（P2-10）：验证完成后非零退出把结果改判为 FAIL
    if (!runHooks(cwd, hv.after_validate, 'after_validate', security)) {
      allOk = false;
    }
  }
  if (allOk && security.policy) {
    try { checkTrustedVerifiers(cwd, taskSecurityCommands(cwd, t), { scope: 'validation' }); }
    catch (error) { allOk = false; checkEvidence.push({ verdict: 'FAIL', reason: error.code || 'TRUST_CHANGED_DURING_VALIDATION', message: error.message }); }
  }
  if (allOk) {
    const productTreeAfterValidation = projectTreeHash(cwd);
    if (productTreeAfterValidation && productTreeBeforeValidation) {
      if (productTreeAfterValidation.treeHash !== productTreeBeforeValidation.treeHash) {
        candidateInstability = {
          beforeTreeHash: productTreeBeforeValidation.treeHash,
          afterTreeHash: productTreeAfterValidation.treeHash,
          beforeFiles: productTreeBeforeValidation.files,
          afterFiles: productTreeAfterValidation.files,
        };
        allOk = false;
        checkEvidence.push({ verdict: 'FAIL', reason: 'CANDIDATE_UNSTABLE_AFTER_VALIDATION', ...candidateInstability });
        console.log(`✗ [${t.id}] 验证过程改变了 Product tree（before ${productTreeBeforeValidation.treeHash.slice(0, 12)}/${productTreeBeforeValidation.files} files, after ${productTreeAfterValidation.treeHash.slice(0, 12)}/${productTreeAfterValidation.files} files）。`);
        console.log('  拒绝冻结 Candidate；请把测试临时文件移到 .rootagent/runtime/、系统临时目录或独立 sandbox，并清理产品树后重新 validate。');
      }
    }
  }
  // 体验与反偷懒硬审计门禁 (Experience Quality Audit Gate)
  if (allOk && !dryRun) {
    const outcomeContract = deriveOutcomeContract(t.acceptanceCriteria || [], { taskId: t.id, contractDigest: t.contractDigest });
    const expAudit = auditProjectExperience(cwd, data.goal || '', { outcomeContract });
    if (!expAudit.ok) {
      allOk = false;
      console.log(`\n✗ [${t.id}] 体验与反偷懒审计未通过 (Experience Audit Failed)：`);
      expAudit.violations.forEach(v => {
        console.log(`  ✕ ${v}`);
        checkEvidence.push({ verdict: 'FAIL', reason: 'EXPERIENCE_AUDIT_VIOLATION', violation: v });
      });
      for (const finding of expAudit.qualityFindings || []) {
        checkEvidence.push({
          verdict: 'FAIL',
          reason: 'PRODUCT_QUALITY_FINDING',
          findingId: finding.id,
          archetype: finding.archetype,
          severity: finding.severity,
          confidence: finding.confidence,
          label: finding.label,
          evidence: finding.evidence,
        });
      }
      console.log('  RootAgent 体验契约：严禁降级偷懒，必须符合该品类的强制技术基线！请修正后重试。');
    } else if (expAudit.archetypes.length) {
      console.log(`✓ 体验契约符合品类画像基准：${expAudit.archetypes.join(', ')}`);
    }
  }
  if (allOk) {
    delete t.repairFocus;
    t.validateCount = (t.validateCount || 0) + 1;
    t.hostExecutions = [];
    t.candidate = createCandidate(cwd, t);
    if (t.attempt?.isolationDecision === 'LIGHTWEIGHT' && t.candidate.commit) {
      const commitPaths = t.candidate.commitChangedPaths || [];
      const outside = commitPaths.filter(rel => !declaredPathAllows(rel, t.writes || []));
      if (!commitPaths.length || t.candidate.commit === t.attempt.baseCommit) {
        allOk = false; checkEvidence.push({ verdict: 'FAIL', reason: 'TASK_COMMIT_REQUIRED', commit: t.candidate.commit });
        console.log(`✗ [${t.id}] 轻量并行任务必须有独立实现提交，当前 HEAD 没有本任务的新提交内容。`);
      } else if (outside.length) {
        allOk = false; checkEvidence.push({ verdict: 'FAIL', reason: 'COMMIT_SCOPE_VIOLATION', commit: t.candidate.commit, commitPaths, outside });
        console.log(`✗ [${t.id}] HEAD commit 混入本任务写集之外的文件：${outside.join(', ')}`);
      }
    }
  }
  if (allOk) {
    t.attestations = (t.attestations || []).filter(a => a.type !== 'hard-check' && a.type !== 'checker');
    t.attestations.push({
      attestationId: cryptoRandomId(), type: 'hard-check', verdict: 'PASS',
      issuer: 'rootagent-verifier', issuedAt: new Date().toISOString(),
      contractDigest: t.contractDigest, candidateDigest: t.candidate.digest,
      treeHash: t.candidate.treeHash, attemptId: t.attempt.attemptId,
      evidence: checkEvidence,
      security: security.policy ? { configDigest: security.configDigest, approvalId: security.verified.trust.approval.approvalId, sandbox: detectSandboxBackend() } : null,
    });
    saveTasks(cwd, data);
    console.log('硬验证结果：HARD PASS');
    const cm = loadConfig(cwd).checkerModel;
    console.log(`  下一步：Checker 软验证（checkerModel: ${cm || '同模型'}，独立模型判，逐条核验验收标准，末行 CHECK: PASS/FAIL）。通过后 rootagent pass。`);
    return successResult('VALIDATION_PASSED', { taskId: t.id, candidateDigest: t.candidate.digest });
  } else {
    t.candidate = null;
    t.attestations = [];
    t.hostExecutions = [];
    const repairFocus = selectRepairFocusSync(cwd, checkEvidence, {
      taskId: t.id,
      goal: data.goal || '',
      retryCount: t.retryCount || 0,
    });
    if (repairFocus) {
      t.repairFocus = {
        ...repairFocus,
        at: new Date().toISOString(),
        evidence: repairFocus.evidence.slice(0, 4),
      };
    }
    saveTasks(cwd, data);
    console.log(candidateInstability
      ? '硬验证结果：HARD FAIL（验证副作用改变 Product tree，未冻结 Candidate）'
      : '硬验证结果：HARD FAIL（失败证据已进入下一轮 Maker ContextPacket）');
    if (t.repairFocus) {
      console.log(`  修复焦点：[${t.repairFocus.category}] ${t.repairFocus.label}（selector=${t.repairFocus.selection?.provider || 'deterministic'}）`);
    }
    return failResult(
      candidateInstability ? 'CANDIDATE_UNSTABLE_AFTER_VALIDATION' : 'VALIDATION_FAILED',
      candidateInstability ? '验证过程改变了 Product tree，拒绝冻结不稳定 Candidate' : '一项或多项硬验证失败',
      EXIT.VALIDATION,
      { taskId: t.id, evidence: checkEvidence, ...(candidateInstability ? { stability: candidateInstability } : {}) },
    );
  }
}

function flagValue(args, flag, fallback = '') {
  const val = optionValue(args, flag, fallback);
  return val == null ? fallback : String(val);
}

function currentCandidateMatches(cwd, task) {
  if (!task.candidate) return { ok: false, reason: '缺少硬验证证明及 candidate' };
  const current = projectTreeHash(cwd);
  if (current.treeHash !== task.candidate.treeHash) {
    return { ok: false, reason: `候选内容已变化（expected ${task.candidate.treeHash.slice(0, 12)}, actual ${current.treeHash.slice(0, 12)}）` };
  }
  if (task.candidate.commit) {
    let head = '';
    try {
      head = execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return { ok: false, reason: `候选提交无法复核（expected ${task.candidate.commit.slice(0, 12)}, current HEAD unavailable）` };
    }
    if (head !== task.candidate.commit) {
      return { ok: false, reason: `候选提交已变化（expected ${task.candidate.commit.slice(0, 12)}, actual ${head.slice(0, 12)}）；即使 Product tree 相同，Git 提交身份变化也必须重新 validate` };
    }
  }
  return { ok: true, current };
}

function leaseFromArgs(args) {
  const fence = flagValue(args, '--fence', '');
  return { attemptId: flagValue(args, '--attempt', ''), fencingToken: fence === '' ? null : Number(fence) };
}

function checkerHostExecutionBinding(task, declaredIssuer) {
  const entries = (task.hostExecutions || []).filter(entry => entry.role === 'checker');
  if (!entries.length) {
    return { ok: true, issuer: declaredIssuer, assurance: 'UNBOUND_DECLARED_ISSUER', ref: null };
  }
  const validation = validateTaskHostExecutions(task);
  if (!validation.ok) {
    return { ok: false, code: 'HOST_PROVENANCE_INVALID', reason: 'Checker Host provenance 无效', errors: validation.errors };
  }
  if (entries.length !== 1) {
    return { ok: false, code: 'CHECKER_HOST_PROVENANCE_AMBIGUOUS', reason: '当前候选必须且只能有一条 Checker Host provenance' };
  }
  const entry = entries[0];
  const executionId = String(entry.provenance?.executionId || '');
  if (!executionId || (declaredIssuer && declaredIssuer !== executionId)) {
    return {
      ok: false,
      code: 'CHECKER_ISSUER_HOST_MISMATCH',
      reason: `Checker issuer 必须等于已核销 Host executionId（expected ${executionId || '(missing)'}, actual ${declaredIssuer || '(omitted)'}）`,
    };
  }
  return {
    ok: true,
    issuer: executionId,
    assurance: 'HOST_PROVENANCE_BOUND',
    ref: {
      role: 'checker',
      hostAttestationId: entry.attestationId,
      hostAttestationDigest: entry.digest,
      executionId,
      provenanceDigest: entry.provenance.digest,
    },
  };
}

function verifyCheckerHostExecutionBinding(task, checker) {
  const entries = (task.hostExecutions || []).filter(entry => entry.role === 'checker');
  if (!entries.length) {
    return !checker.hostExecutionRef && checker.identityAssurance === 'UNBOUND_DECLARED_ISSUER'
      ? { ok: true }
      : { ok: false, code: 'CHECKER_HOST_BINDING_UNEXPECTED' };
  }
  if (entries.length !== 1) return { ok: false, code: 'CHECKER_HOST_PROVENANCE_AMBIGUOUS' };
  const entry = entries[0]; const ref = checker.hostExecutionRef || {};
  const ok = checker.identityAssurance === 'HOST_PROVENANCE_BOUND'
    && checker.issuer === entry.provenance?.executionId
    && ref.role === 'checker'
    && ref.hostAttestationId === entry.attestationId
    && ref.hostAttestationDigest === entry.digest
    && ref.executionId === entry.provenance?.executionId
    && ref.provenanceDigest === entry.provenance?.digest;
  return ok ? { ok: true } : { ok: false, code: 'CHECKER_HOST_BINDING_MISMATCH' };
}

function cmdAttest(cwd, args) {
  const [type, idArg] = args;
  if (type !== 'checker') {
    console.log('用法：rootagent attest checker [task-id] --report <checker.json> [--issuer <session-id>]');
    return failResult('INVALID_ARGUMENT', 'attest 仅允许 checker 类型；hard-check 只能由 validate 生成', EXIT.USAGE);
  }
  const data = loadTasks(cwd);
  const task = resolveTarget(cwd, data, /^t\d+$/i.test(idArg || '') ? idArg : '', 'attest', true, leaseFromArgs(args));
  if (!task) return false;
  const actualContractDigest = taskContractDigest(task);
  if (actualContractDigest !== task.contractDigest) {
    console.log(`✗ [${task.id}] 任务契约摘要不匹配，拒绝签发证明。`);
    return failResult('CONTRACT_TAMPERED', '任务契约摘要不匹配', EXIT.CONFLICT);
  }
  const securityPolicy = loadSecurityPolicy(cwd);
  const reportPath = flagValue(args, '--report');
  let issuer = flagValue(args, '--issuer');
  let report = null;
  let verdict = flagValue(args, '--verdict').toUpperCase();
  if (reportPath) {
    try { report = JSON.parse(fs.readFileSync(path.resolve(cwd, reportPath), 'utf-8')); }
    catch (error) { return failResult('CHECKER_REPORT_INVALID', `无法读取 Checker report：${error.message}`, EXIT.USAGE); }
    if (issuer && report.issuer && issuer !== report.issuer) return failResult('CHECKER_REPORT_INVALID', '命令 issuer 与报告 issuer 不一致', EXIT.VALIDATION);
    issuer ||= String(report.issuer || '');
    const checked = validateCheckerReport(report, task);
    if (!checked.ok) return failResult('CHECKER_REPORT_INVALID', checked.errors.join('；'), EXIT.VALIDATION, { errors: checked.errors });
    report = checked.report; verdict = report.verdict;
  } else if (securityPolicy?.checker?.requireStructuredReport) {
    return failResult('CHECKER_REPORT_REQUIRED', '安全模式要求 --report 提供逐条结构化 Checker 报告', EXIT.VALIDATION);
  }
  const hostBinding = checkerHostExecutionBinding(task, issuer);
  if (!hostBinding.ok) {
    return failResult(hostBinding.code, hostBinding.reason, EXIT.POLICY, { errors: hostBinding.errors || [] });
  }
  issuer = hostBinding.issuer;
  const criteriaArg = flagValue(args, '--criteria');
  const evidence = flagValue(args, '--evidence', `checker:${issuer}`);
  if (!issuer || (!report && (!['PASS', 'FAIL'].includes(verdict) || !criteriaArg))) {
    console.log('✗ Checker 证明必须有 issuer（有唯一 Host provenance 时可自动解析），并提供 --report；兼容模式可用 --verdict/--criteria。');
    return failResult('INVALID_ARGUMENT', 'Checker 证明字段不完整', EXIT.USAGE);
  }
  if (issuer === task.attempt?.owner || issuer === 'rootagent-verifier') {
    console.log(`✗ Checker 身份隔离失败：issuer=${issuer} 与 Maker/Verifier 身份相同。`);
    return failResult('ROLE_ISOLATION_FAILED', 'Checker 与 Maker/Verifier 必须是不同身份', EXIT.POLICY);
  }
  const match = currentCandidateMatches(cwd, task);
  if (!match.ok) {
    console.log(`✗ ${match.reason}；重新 validate 后才能签发 Checker 证明。`);
    return failResult('STALE_CANDIDATE', match.reason, EXIT.CONFLICT);
  }
  const hard = (task.attestations || []).find(a => a.type === 'hard-check' && a.verdict === 'PASS' && a.candidateDigest === task.candidate.digest && a.contractDigest === task.contractDigest);
  if (!hard) {
    console.log('✗ 缺少绑定当前候选的 hard-check PASS 证明。');
    return failResult('ATTESTATION_MISSING', '缺少 hard-check PASS', EXIT.VALIDATION);
  }
  const total = (task.acceptanceCriteria || []).length;
  const indexes = report ? report.criteria.map(item => item.index) : criteriaArg === 'all'
    ? Array.from({ length: total }, (_, i) => i + 1)
    : [...new Set(criteriaArg.split(',').map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= total))];
  if (!report && indexes.length !== total) {
    const missing = Array.from({ length: total }, (_, i) => i + 1).filter(i => !indexes.includes(i));
    console.log(`✗ Checker 未逐条覆盖全部验收标准；缺少：${missing.join(', ') || '(标准索引非法)'}`);
    return failResult('CRITERIA_NOT_COVERED', 'Checker 必须逐条覆盖全部验收标准', EXIT.VALIDATION, { missing });
  }
  let calibration = null;
  if (securityPolicy?.checker?.requireCalibration) {
    calibration = loadCheckerCalibration(cwd, issuer);
    if (!calibration || calibration.verdict !== 'PASS') return failResult('CHECKER_NOT_CALIBRATED', `Checker ${issuer} 没有通过当前校准门`, EXIT.POLICY);
  }
  const attestation = {
    attestationId: cryptoRandomId(), type: 'checker', verdict, issuer,
    issuedAt: new Date().toISOString(), contractDigest: task.contractDigest,
    candidateDigest: task.candidate.digest, treeHash: task.candidate.treeHash,
    attemptId: task.attempt.attemptId,
    criteria: report ? report.criteria.map(item => ({ ...item, criterion: task.acceptanceCriteria[item.index - 1] })) : indexes.map(index => ({ index, criterion: task.acceptanceCriteria[index - 1], verdict, evidence })),
    reportDigest: report ? sha256(report) : null,
    calibrationDigest: calibration?.digest || null,
    identityAssurance: hostBinding.assurance,
    hostExecutionRef: hostBinding.ref,
  };
  task.attestations = (task.attestations || []).filter(a => a.type !== 'checker');
  task.attestations.push(attestation);
  saveTasks(cwd, data);
  console.log(`${verdict === 'PASS' ? '✓' : '✗'} ATTEST: ${verdict} - [${task.id}] checker=${issuer}，逐条覆盖 ${indexes.length}/${total}，candidate=${task.candidate.digest.slice(0, 12)}`);
  return verdict === 'PASS'
    ? successResult('CHECKER_ATTESTED', { taskId: task.id, attestationId: attestation.attestationId, candidateDigest: task.candidate.digest })
    : failResult('CHECKER_REJECTED', `Checker verdict=${verdict}`, EXIT.VALIDATION, { taskId: task.id });
}



function validateTaskHostCapabilityEvidence(task) {
  const entries = Array.isArray(task.hostCapabilityEvidence) ? task.hostCapabilityEvidence : [];
  const errors = [];
  const evidences = [];

  for (const entry of entries) {
    const claimed = entry?.digest;
    const unsigned = { ...entry };
    delete unsigned.digest;
    if (!claimed || claimed !== sha256(unsigned)) {
      errors.push({ code: 'HOST_CAPABILITY_ATTESTATION_DIGEST_INVALID' });
      continue;
    }
    if (
      entry.taskId !== task.id
      || entry.contractDigest !== task.contractDigest
      || entry.attemptId !== task.attempt?.attemptId
      || entry.fencingToken !== task.attempt?.fencingToken
    ) {
      errors.push({ code: 'HOST_CAPABILITY_ATTESTATION_SUBJECT_MISMATCH' });
      continue;
    }
    const checked = verifyHostCapabilityEvidence(entry.evidence);
    if (!checked.ok) {
      errors.push(...checked.errors);
      continue;
    }
    const subject = checked.evidence.subject || {};
    if (
      subject.taskId !== task.id
      || subject.contractDigest !== task.contractDigest
      || subject.attemptId !== task.attempt?.attemptId
      || subject.fencingToken !== task.attempt?.fencingToken
    ) {
      errors.push({ code: 'HOST_CAPABILITY_EVIDENCE_SUBJECT_MISMATCH' });
      continue;
    }
    evidences.push(checked.evidence);
  }

  return { ok: errors.length === 0, errors, entries, evidences };
}

function validateTaskHostExecutions(task) {
  const entries = Array.isArray(task.hostExecutions) ? task.hostExecutions : [];
  const errors = [];
  const validRecords = [];

  for (const entry of entries) {
    const claimed = entry?.digest;
    const unsigned = { ...entry };
    delete unsigned.digest;
    if (!claimed || claimed !== sha256(unsigned)) {
      errors.push({ code: 'HOST_ATTESTATION_DIGEST_INVALID', role: entry?.role || null });
      continue;
    }
    if (
      entry.taskId !== task.id
      || entry.contractDigest !== task.contractDigest
      || entry.candidateDigest !== task.candidate?.digest
      || entry.treeHash !== task.candidate?.treeHash
      || entry.attemptId !== task.attempt?.attemptId
      || entry.fencingToken !== task.attempt?.fencingToken
    ) {
      errors.push({ code: 'HOST_ATTESTATION_SUBJECT_MISMATCH', role: entry.role || null });
      continue;
    }
    const record = entry.provenance || {};
    const subject = record.subject || {};
    if (
      record.role !== entry.role
      || subject.taskId !== task.id
      || subject.contractDigest !== task.contractDigest
      || subject.candidateDigest !== task.candidate?.digest
      || subject.attemptId !== task.attempt?.attemptId
      || subject.fencingToken !== task.attempt?.fencingToken
    ) {
      errors.push({ code: 'HOST_PROVENANCE_SUBJECT_MISMATCH', role: entry.role || null });
      continue;
    }
    const verified = verifyExecutionProvenance([record]);
    if (!verified.ok) {
      errors.push(...verified.errors);
      continue;
    }
    validRecords.push(record);
  }

  const crossRole = verifyExecutionProvenance(validRecords);
  if (!crossRole.ok) errors.push(...crossRole.errors);
  return { ok: errors.length === 0, errors, entries };
}

function cmdHost(cwd, args) {
  const [sub, roleArg] = args;

  if (sub === 'chat') {
    const action = String(args[1] || 'pending');
    try {
      enableChatHost(cwd);
      if (action === 'pending') {
        const requests = listChatHostRequests(cwd).filter(item => item.status === 'PENDING');
        requests.forEach(item => console.log(`  ${item.requestId} role=${item.role} task=${item.taskId} run=${item.runId}`));
        return successResult('HOST_CHAT_REQUESTS_LISTED', { requests });
      }
      if (action === 'inspect') {
        const requestId = String(args[2] || '').trim();
        if (!requestId) return failResult('INVALID_ARGUMENT', 'host chat inspect 需要 <requestId>', EXIT.USAGE);
        const inspected = inspectChatHostRequest(cwd, requestId);
        console.log(JSON.stringify(inspected, null, 2));
        return successResult('HOST_CHAT_REQUEST_INSPECTED', inspected);
      }
      if (action === 'respond') {
        const requestId = String(args[2] || '').trim();
        const valueArg = flagValue(args, '--value');
        if (!requestId || !valueArg) return failResult('INVALID_ARGUMENT', 'host chat respond 需要 <requestId> --value <JSON|file>', EXIT.USAGE);
        const output = parseJsonArgument(cwd, valueArg);
        const response = respondChatHostRequest(cwd, requestId, output);
        console.log('✓ HOST CHAT RESPONSE: request=' + requestId + ' digest=' + response.digest.slice(0, 12));
        return successResult('HOST_CHAT_RESPONSE_SUBMITTED', { requestId, responseDigest: response.digest, executionId: response.executionId });
      }
      return failResult('INVALID_ARGUMENT', '用法：host chat pending | inspect <requestId> | respond <requestId> --value <JSON|file>', EXIT.USAGE);
    } catch (error) {
      return failResult(error.code || 'HOST_CHAT_ERROR', error.message || String(error), EXIT.CONFLICT);
    }
  }

  if (sub === 'bridge') {
    const action = String(args[1] || 'pending');
    try {
      if (action === 'enable') {
        const enabled = enableDoubaoBridge(cwd);
        console.log('✓ HOST BRIDGE ENABLED: inbox=' + enabled.inbox);
        return successResult('HOST_BRIDGE_ENABLED', enabled);
      }
      if (action === 'pending' || action === 'list') {
        enableDoubaoBridge(cwd);
        const requests = listDoubaoBridgeRequests(cwd).filter(item => item.status === 'PENDING');
        requests.forEach(item => console.log(`  ${item.executionId} role=${item.role} task=${item.taskId}`));
        return successResult('HOST_BRIDGE_REQUESTS_LISTED', { requests });
      }
      if (action === 'inspect') {
        const executionId = String(args[2] || '').trim();
        if (!executionId) return failResult('INVALID_ARGUMENT', 'host bridge inspect 需要 <executionId>', EXIT.USAGE);
        const inspected = inspectDoubaoBridgeRequest(cwd, executionId);
        console.log(JSON.stringify(inspected, null, 2));
        return successResult('HOST_BRIDGE_REQUEST_INSPECTED', inspected);
      }
      if (action === 'respond') {
        const executionId = String(args[2] || '').trim();
        const valueArg = flagValue(args, '--value');
        if (!executionId || !valueArg) return failResult('INVALID_ARGUMENT', 'host bridge respond 需要 <executionId> --value <JSON|file>', EXIT.USAGE);
        const output = parseJsonArgument(cwd, valueArg);
        const response = respondDoubaoBridgeRequest(cwd, executionId, output);
        console.log('✓ HOST BRIDGE RESPONSE: executionId=' + executionId + ' file=' + response.file);
        return successResult('HOST_BRIDGE_RESPONSE_SUBMITTED', { executionId, file: response.file });
      }
      return failResult('INVALID_ARGUMENT', '用法：host bridge enable | pending | inspect <executionId> | respond <executionId> --value <JSON|file>', EXIT.USAGE);
    } catch (error) {
      return failResult(error.code || 'HOST_BRIDGE_ERROR', error.message || String(error), EXIT.CONFLICT);
    }
  }

  if (sub === 'drive') {
    const runId = String(args[1] || '').trim();
    if (!runId) return failResult('INVALID_ARGUMENT', 'host drive 需要 <runId>', EXIT.USAGE);
    const recovery = path.join(cwd, '.rootagent', 'runtime', 'transaction.json');
    if (fs.existsSync(recovery)) {
      return failResult('PENDING_RECOVERY', '检测到未完成的恢复事务，先运行 doctor/resume', EXIT.CONFLICT);
    }
    // drive 是异步长命令：run 状态机推进由 executeRunStep / resumeRun 内部的项目短锁保护，
    // driver 只写 run 专属 checkpoint 与 resume 值，不与其他命令共享写路径，因此不再额外持锁
    // （mutatesState 对 host drive 保持 false，避免与 main 的同步锁冲突或双重加锁）。
    return (async () => {
      // 动态选择或显式指定两类模式：Bridge（SubAgent） vs Chat（单会话接力）
      const providers = [];
      if (args.includes('--bridge') || args.includes('--subagent')) {
        enableDoubaoBridge(cwd);
        providers.push(createDoubaoBridgeProvider({ priority: 120 }));
      } else if (args.includes('--chat')) {
        enableChatHost(cwd);
        providers.push(createChatHostProvider({ priority: 120 }));
      } else {
        // 未传显式 flag 时的动态自动判定：
        if (doubaoBridgeEnabled(cwd) && !chatHostEnabled(cwd)) {
          providers.push(createDoubaoBridgeProvider({ priority: 120 }));
        } else if (chatHostEnabled(cwd) && !doubaoBridgeEnabled(cwd)) {
          providers.push(createChatHostProvider({ priority: 120 }));
        } else if (process.env.DOUBAO_HOST_INSTANCE_ID || process.env.ROOTAGENT_HOST_BRIDGE || process.env.DOUBAO_SESSION_ID || process.env.ROOTAGENT_HOST_INSTANCE_ID) {
          enableDoubaoBridge(cwd);
          providers.push(createDoubaoBridgeProvider({ priority: 120 }));
        }
      }

      const noWait = args.includes('--no-wait');
      const waitArg = flagValue(args, '--wait');
      const waitMs = noWait ? 0 : (waitArg ? Number(waitArg) : undefined);

      const result = await driveAgentHostRun(cwd, runId, undefined, { providers, waitMs, wait: !noWait });
      if (!result.ok) {
        return failResult(result.code || 'HOST_DRIVE_FAILED', result.reason || 'Agent Host drive 失败', EXIT.CONFLICT, {
          runId,
          status: result.status || null,
        });
      }
      console.log('✓ HOST DRIVE: run=' + runId + ' status=' + result.status + ' interrupts=' + result.automatedInterrupts + ' profile=' + (result.runtime?.profile || ''));
      if (result.code === 'HOST_WAITING_SUBAGENT_EXECUTION') {
        console.log(`[WAITING] 等待 SubAgent 执行：角色=${result.role || '-'}，任务=${result.taskId || '-'}，executionId=${result.executionId || '-'}`);
        console.log(`  查看详情: node bin/rootagent.mjs host bridge inspect ${result.executionId}`);
        console.log(`  提交响应: node bin/rootagent.mjs host bridge respond ${result.executionId} --value '{"done":true,...}'`);
      }
      const resultStatus = result.status === 'COMPLETED' ? 'HOST_RUN_COMPLETED' : result.code;
      return successResult(resultStatus, {
        runId,
        status: result.status,
        requestId: result.requestId || null,
        executionId: result.executionId || null,
        role: result.role || null,
        taskId: result.taskId || null,
        prompt: result.prompt || null,
        interrupt: result.interrupt || null,
        automatedInterrupts: result.automatedInterrupts,
        profile: result.runtime?.profile || null,
        source: result.runtime?.source || null,
      });
    })();
  }

  if (sub === 'reconcile' && roleArg === 'run') {
    const runId = String(args[2] || '').trim();
    if (!runId) return failResult('INVALID_ARGUMENT', 'host reconcile run 需要 <runId>', EXIT.USAGE);

    const data = loadTasks(cwd);
    const idArg = args.find(arg => /^t\d+$/i.test(arg || '')) || '';
    const task = resolveTarget(cwd, data, idArg, 'host reconcile run', true, leaseFromArgs(args));
    if (!task) return false;

    const actualContractDigest = taskContractDigest(task);
    if (actualContractDigest !== task.contractDigest) {
      return failResult('CONTRACT_TAMPERED', '任务契约摘要不匹配', EXIT.CONFLICT);
    }
    const match = currentCandidateMatches(cwd, task);
    if (!match.ok) return failResult('STALE_CANDIDATE', match.reason, EXIT.CONFLICT);

    const existingCapability = validateTaskHostCapabilityEvidence(task);
    if (!existingCapability.ok) {
      return failResult('HOST_CAPABILITY_EVIDENCE_INVALID', '当前 Host capability evidence 已损坏，拒绝对账', EXIT.CONFLICT, { errors: existingCapability.errors });
    }
    const existingExecutions = validateTaskHostExecutions(task);
    if (!existingExecutions.ok) {
      return failResult('HOST_PROVENANCE_INVALID', '当前 Host execution provenance 已损坏，拒绝对账', EXIT.CONFLICT, { errors: existingExecutions.errors });
    }

    const batch = readAgentHostRunDriverEvidence(cwd, runId);
    if (!batch.ok) {
      return failResult(batch.code || 'HOST_DRIVER_EVIDENCE_INVALID', 'Run Driver evidence 无效或不完整', EXIT.CONFLICT, {
        runId,
        errors: batch.errors || [],
      });
    }

    const expectedSubject = {
      taskId: task.id,
      contractDigest: task.contractDigest,
      attemptId: task.attempt?.attemptId || null,
      fencingToken: task.attempt?.fencingToken ?? null,
      candidateDigest: task.candidate?.digest || null,
    };
    const prepared = [];
    const seenRoles = new Map();

    for (const checkpoint of batch.checkpoints) {
      const subject = checkpoint.subject || {};
      if (
        checkpoint.taskId !== task.id
        || subject.taskId !== task.id
        || subject.contractDigest !== task.contractDigest
        || subject.attemptId !== task.attempt?.attemptId
        || subject.fencingToken !== task.attempt?.fencingToken
      ) {
        return failResult('HOST_DRIVER_EVIDENCE_SUBJECT_MISMATCH', 'Driver evidence 未绑定当前 task/contract/Attempt/fence', EXIT.CONFLICT, {
          runId,
          executionKey: checkpoint.executionKey,
          expected: expectedSubject,
          actual: subject,
        });
      }

      let provenance;
      try {
        provenance = finalizeAgentHostProvenance(checkpoint.executionRecord, expectedSubject);
      } catch (error) {
        return failResult(error.code || 'HOST_DRIVER_PROVENANCE_FINALIZE_FAILED', error.message || String(error), EXIT.CONFLICT, {
          runId,
          executionKey: checkpoint.executionKey,
        });
      }
      const provenanceCheck = verifyExecutionProvenance([provenance]);
      if (!provenanceCheck.ok) {
        return failResult('HOST_PROVENANCE_INVALID', 'finalized Host provenance 无效', EXIT.CONFLICT, {
          runId,
          executionKey: checkpoint.executionKey,
          errors: provenanceCheck.errors,
        });
      }

      const evidenceCheck = verifyHostCapabilityEvidence(checkpoint.capabilityEvidence);
      if (!evidenceCheck.ok) {
        return failResult('HOST_CAPABILITY_EVIDENCE_INVALID', 'Driver capability evidence 无效', EXIT.CONFLICT, {
          runId,
          executionKey: checkpoint.executionKey,
          errors: evidenceCheck.errors,
        });
      }
      const evidence = evidenceCheck.evidence;
      if (
        provenance.capabilityEvidenceDigest !== evidence.digest
        || provenance.hostCapabilityDigest !== evidence.capabilityDigest
      ) {
        return failResult('HOST_DRIVER_EVIDENCE_LINK_MISMATCH', 'finalized provenance 与 capability evidence 不匹配', EXIT.CONFLICT, {
          runId,
          executionKey: checkpoint.executionKey,
        });
      }

      const previous = seenRoles.get(provenance.role);
      if (previous && previous !== provenance.digest) {
        return failResult('HOST_DRIVER_ROLE_DUPLICATE', '同一 Run 中出现多个不同的同角色执行，拒绝隐式覆盖', EXIT.CONFLICT, {
          runId,
          role: provenance.role,
        });
      }
      seenRoles.set(provenance.role, provenance.digest);
      prepared.push({ checkpoint, provenance, evidence });
    }

    const nextCapabilities = [...(task.hostCapabilityEvidence || [])];
    const capabilityDigests = new Set(nextCapabilities.map(entry => entry.evidence?.digest).filter(Boolean));
    let importedCapabilities = 0;
    for (const item of prepared) {
      if (capabilityDigests.has(item.evidence.digest)) continue;
      const entry = {
        schemaVersion: 1,
        registrationId: 'driver_' + sha256({ runId, executionKey: item.checkpoint.executionKey, evidenceDigest: item.evidence.digest }).slice(0, 24),
        taskId: task.id,
        registeredAt: item.checkpoint.completedAt || new Date().toISOString(),
        contractDigest: task.contractDigest,
        attemptId: task.attempt?.attemptId || null,
        fencingToken: task.attempt?.fencingToken ?? null,
        evidence: item.evidence,
      };
      entry.digest = sha256(entry);
      nextCapabilities.push(entry);
      capabilityDigests.add(item.evidence.digest);
      importedCapabilities++;
    }

    const nextExecutions = [...(task.hostExecutions || [])];
    let importedExecutions = 0;
    let reusedExecutions = 0;
    for (const item of prepared) {
      const currentIndex = nextExecutions.findIndex(entry => entry.role === item.provenance.role);
      if (currentIndex >= 0 && nextExecutions[currentIndex].provenance?.digest === item.provenance.digest) {
        reusedExecutions++;
        continue;
      }
      const entry = {
        schemaVersion: 1,
        attestationId: 'driver_' + sha256({ runId, executionKey: item.checkpoint.executionKey, provenanceDigest: item.provenance.digest }).slice(0, 24),
        taskId: task.id,
        role: item.provenance.role,
        attestedAt: item.checkpoint.completedAt || new Date().toISOString(),
        contractDigest: task.contractDigest,
        candidateDigest: task.candidate.digest,
        treeHash: task.candidate.treeHash,
        attemptId: task.attempt?.attemptId || null,
        fencingToken: task.attempt?.fencingToken ?? null,
        provenance: item.provenance,
      };
      entry.digest = sha256(entry);
      if (currentIndex >= 0) nextExecutions.splice(currentIndex, 1, entry);
      else nextExecutions.push(entry);
      importedExecutions++;
    }

    const shadow = {
      ...task,
      hostCapabilityEvidence: nextCapabilities,
      hostExecutions: nextExecutions,
    };
    const capabilityValidation = validateTaskHostCapabilityEvidence(shadow);
    if (!capabilityValidation.ok) {
      return failResult('HOST_CAPABILITY_EVIDENCE_INVALID', '对账后的 capability evidence 集合无效', EXIT.CONFLICT, { errors: capabilityValidation.errors });
    }
    const executionValidation = validateTaskHostExecutions(shadow);
    if (!executionValidation.ok) {
      return failResult('HOST_PROVENANCE_INVALID', '对账后的 Host execution 集合无效', EXIT.CONFLICT, { errors: executionValidation.errors });
    }

    task.hostCapabilityEvidence = nextCapabilities;
    task.hostExecutions = nextExecutions;
    saveTasks(cwd, data);
    console.log('✓ HOST RECONCILE: run=' + runId + ' roles=' + [...seenRoles.keys()].join(',') + ' candidate=' + task.candidate.digest.slice(0, 12));
    return successResult('HOST_DRIVER_EVIDENCE_RECONCILED', {
      taskId: task.id,
      runId,
      candidateDigest: task.candidate.digest,
      roles: [...seenRoles.keys()],
      importedCapabilities,
      importedExecutions,
      reusedExecutions,
      checkpointCount: prepared.length,
    });
  }

  if (sub === 'capabilities' && roleArg === 'attest') {
    const data = loadTasks(cwd);
    const idArg = args.find(arg => /^t\d+$/i.test(arg || '')) || '';
    const task = resolveTarget(cwd, data, idArg, 'host capabilities attest', true, leaseFromArgs(args));
    if (!task) return false;

    const actualContractDigest = taskContractDigest(task);
    if (actualContractDigest !== task.contractDigest) {
      return failResult('CONTRACT_TAMPERED', '任务契约摘要不匹配', EXIT.CONFLICT);
    }

    const recordPath = flagValue(args, '--record');
    if (!recordPath) return failResult('INVALID_ARGUMENT', 'host capabilities attest 需要 --record <capability-evidence.json>', EXIT.USAGE);

    let evidence;
    try { evidence = JSON.parse(fs.readFileSync(path.resolve(cwd, recordPath), 'utf-8')); }
    catch (error) { return failResult('HOST_CAPABILITY_EVIDENCE_INVALID', '无法读取 capability evidence：' + error.message, EXIT.USAGE); }

    const checked = verifyHostCapabilityEvidence(evidence);
    if (!checked.ok) {
      return failResult('HOST_CAPABILITY_EVIDENCE_INVALID', 'capability evidence digest/结构无效', EXIT.CONFLICT, { errors: checked.errors });
    }
    evidence = checked.evidence;
    const subject = evidence.subject || {};
    if (
      subject.taskId !== task.id
      || subject.contractDigest !== task.contractDigest
      || subject.attemptId !== task.attempt?.attemptId
      || subject.fencingToken !== task.attempt?.fencingToken
    ) {
      return failResult('HOST_CAPABILITY_EVIDENCE_SUBJECT_MISMATCH', 'capability evidence 未绑定当前 task/attempt/fence', EXIT.CONFLICT, {
        expected: {
          taskId: task.id,
          contractDigest: task.contractDigest,
          attemptId: task.attempt?.attemptId || null,
          fencingToken: task.attempt?.fencingToken ?? null,
        },
        actual: subject,
      });
    }

    const entry = {
      schemaVersion: 1,
      registrationId: cryptoRandomId(),
      taskId: task.id,
      registeredAt: new Date().toISOString(),
      contractDigest: task.contractDigest,
      attemptId: task.attempt?.attemptId || null,
      fencingToken: task.attempt?.fencingToken ?? null,
      evidence,
    };
    entry.digest = sha256(entry);
    task.hostCapabilityEvidence = (task.hostCapabilityEvidence || []).filter(item => item.evidence?.digest !== evidence.digest);
    task.hostCapabilityEvidence.push(entry);
    saveTasks(cwd, data);
    console.log('✓ HOST CAPABILITY: assurance=' + evidence.assurance + ' capability=' + evidence.capabilityDigest.slice(0, 12));
    return successResult('HOST_CAPABILITY_EVIDENCE_ATTESTED', {
      taskId: task.id,
      evidenceDigest: evidence.digest,
      capabilityDigest: evidence.capabilityDigest,
      assurance: evidence.assurance,
    });
  }

  if (sub === 'attest') {
    const role = String(roleArg || '').trim();
    const allowedRoles = new Set(['maker', 'checker', 'reviewer', 'integrator', 'planner']);
    if (!allowedRoles.has(role)) {
      return failResult('INVALID_ARGUMENT', 'host attest role 必须是 maker/checker/reviewer/integrator/planner', EXIT.USAGE);
    }

    const data = loadTasks(cwd);
    const idArg = args.find(arg => /^t\d+$/i.test(arg || '')) || '';
    const task = resolveTarget(cwd, data, idArg, 'host attest', true, leaseFromArgs(args));
    if (!task) return false;

    const actualContractDigest = taskContractDigest(task);
    if (actualContractDigest !== task.contractDigest) {
      return failResult('CONTRACT_TAMPERED', '任务契约摘要不匹配', EXIT.CONFLICT);
    }
    const match = currentCandidateMatches(cwd, task);
    if (!match.ok) return failResult('STALE_CANDIDATE', match.reason, EXIT.CONFLICT);

    const recordPath = flagValue(args, '--record');
    if (!recordPath) return failResult('INVALID_ARGUMENT', 'host attest 需要 --record <provenance.json>', EXIT.USAGE);

    let record;
    try { record = JSON.parse(fs.readFileSync(path.resolve(cwd, recordPath), 'utf-8')); }
    catch (error) { return failResult('HOST_PROVENANCE_INVALID', '无法读取 provenance：' + error.message, EXIT.USAGE); }

    if (record.role !== role) {
      return failResult('HOST_PROVENANCE_ROLE_MISMATCH', 'provenance role 与 host attest role 不一致', EXIT.CONFLICT);
    }
    const checked = verifyExecutionProvenance([record]);
    if (!checked.ok) {
      return failResult('HOST_PROVENANCE_INVALID', 'provenance digest/结构无效', EXIT.CONFLICT, { errors: checked.errors });
    }

    const capabilityValidation = validateTaskHostCapabilityEvidence(task);
    if (!capabilityValidation.ok) {
      return failResult('HOST_CAPABILITY_EVIDENCE_INVALID', '当前 Host capability evidence 无效', EXIT.CONFLICT, { errors: capabilityValidation.errors });
    }
    if (task.hostPolicy?.capabilityEvidence?.required && !record.capabilityEvidenceDigest) {
      return failResult('HOST_CAPABILITY_EVIDENCE_REQUIRED', 'Agent Host Policy 要求 execution provenance 引用 capability evidence', EXIT.POLICY);
    }
    if (record.capabilityEvidenceDigest) {
      const capabilityEvidence = capabilityValidation.evidences.find(item => item.digest === record.capabilityEvidenceDigest);
      if (!capabilityEvidence) {
        return failResult('HOST_CAPABILITY_EVIDENCE_UNKNOWN', 'provenance 引用了当前 Attempt 未登记的 capability evidence', EXIT.CONFLICT, {
          capabilityEvidenceDigest: record.capabilityEvidenceDigest,
        });
      }
      if (capabilityEvidence.capabilityDigest !== record.hostCapabilityDigest) {
        return failResult('HOST_CAPABILITY_EVIDENCE_CAPABILITY_MISMATCH', 'capability evidence 与 provenance hostCapabilityDigest 不一致', EXIT.CONFLICT);
      }
    }

    const subject = record.subject || {};
    const subjectMatches = subject.taskId === task.id
      && subject.contractDigest === task.contractDigest
      && subject.candidateDigest === task.candidate.digest
      && subject.attemptId === task.attempt?.attemptId
      && subject.fencingToken === task.attempt?.fencingToken;
    if (!subjectMatches) {
      return failResult('HOST_PROVENANCE_SUBJECT_MISMATCH', 'provenance 未绑定当前 task/attempt/fence/candidate', EXIT.CONFLICT, {
        expected: {
          taskId: task.id,
          contractDigest: task.contractDigest,
          candidateDigest: task.candidate.digest,
          attemptId: task.attempt?.attemptId || null,
          fencingToken: task.attempt?.fencingToken ?? null,
        },
        actual: subject,
      });
    }

    const entry = {
      schemaVersion: 1,
      attestationId: cryptoRandomId(),
      taskId: task.id,
      role,
      attestedAt: new Date().toISOString(),
      contractDigest: task.contractDigest,
      candidateDigest: task.candidate.digest,
      treeHash: task.candidate.treeHash,
      attemptId: task.attempt?.attemptId || null,
      fencingToken: task.attempt?.fencingToken ?? null,
      provenance: record,
    };
    entry.digest = sha256(entry);
    task.hostExecutions = (task.hostExecutions || []).filter(item => item.role !== role);
    task.hostExecutions.push(entry);
    saveTasks(cwd, data);
    console.log('✓ HOST ATTEST: ' + role + ' execution=' + record.executionId + ' strategy=' + record.strategy + ' candidate=' + task.candidate.digest.slice(0, 12));
    return successResult('HOST_EXECUTION_ATTESTED', {
      taskId: task.id,
      role,
      attestationId: entry.attestationId,
      candidateDigest: task.candidate.digest,
      executionId: record.executionId,
      strategy: record.strategy,
    });
  }

  if (sub === 'verify') {
    const data = loadTasks(cwd);
    const idArg = args.find(arg => /^t\d+$/i.test(arg || '')) || '';
    const task = idArg ? findTask(data, idArg) : (getInProgress(data) || data.features.find(item => item.status === 'completed'));
    if (!task) return failResult('TASK_NOT_FOUND', '找不到可验证的任务', EXIT.STATE);
    const verified = validateTaskHostExecutions(task);
    if (!verified.ok) {
      return failResult('HOST_PROVENANCE_INVALID', 'Host execution provenance 验证失败', EXIT.CONFLICT, { errors: verified.errors });
    }
    const capabilityValidation = validateTaskHostCapabilityEvidence(task);
    if (!capabilityValidation.ok) {
      return failResult('HOST_CAPABILITY_EVIDENCE_INVALID', 'Host capability evidence 验证失败', EXIT.CONFLICT, { errors: capabilityValidation.errors });
    }
    const policy = verifyHostPolicyProvenance(
      task.hostPolicy,
      verified.entries.map(entry => entry.provenance),
      capabilityValidation.evidences,
    );
    if (!policy.ok) {
      return failResult('HOST_POLICY_UNSATISFIED', 'Agent Host Policy 未满足', EXIT.POLICY, { errors: policy.errors });
    }
    console.log('HOST: VERIFIED - task=' + task.id + ' records=' + verified.entries.length + (task.hostPolicy ? ' policy=SATISFIED' : ' policy=LEGACY'));
    return successResult('HOST_PROVENANCE_VERIFIED', {
      taskId: task.id,
      hostPolicyDigest: task.hostPolicy?.digest || null,
      records: verified.entries.map(entry => ({
        role: entry.role,
        executionId: entry.provenance?.executionId || null,
        strategy: entry.provenance?.strategy || null,
        digest: entry.digest,
      })),
    });
  }

  return failResult('INVALID_ARGUMENT', '用法：host drive <runId> [--chat] | host chat pending|inspect|respond | host reconcile run <runId> [taskId] | host capabilities attest [taskId] --record <json> | host attest <role> [taskId] --record <json> | host verify [taskId]', EXIT.USAGE);
}

function cmdPass(cwd, idArg, suppliedLease = {}) {
  const data = loadTasks(cwd);
  const t = resolveTarget(cwd, data, idArg, 'pass', true, suppliedLease);
  if (!t) return;
  const actualContractDigest = taskContractDigest(t);
  if (actualContractDigest !== t.contractDigest) {
    console.log(`✗ [${t.id}] 任务契约已变化，旧证明失效。`);
    return failResult('CONTRACT_TAMPERED', '任务契约摘要不匹配', EXIT.CONFLICT);
  }
  const taskWorkspaces = listWorkspaces(cwd).filter(workspace => workspace.taskId === t.id);
  if (taskWorkspaces.length || t.attempt?.isolationDecision === 'WORKTREE_REQUIRED') {
    const integrated = taskWorkspaces.find(workspace => workspace.status === 'INTEGRATED' && workspace.contractDigest === t.contractDigest && workspace.integrationReceiptDigest);
    if (!integrated) {
      const states = taskWorkspaces.map(workspace => `${workspace.workspaceId}:${workspace.status}`).join(', ');
      console.log(`✗ [${t.id}] 已进入 P2 workspace 流程，但没有绑定当前契约的 Integration receipt。`);
      console.log(`  工作区状态：${states}`);
      return failResult('INTEGRATION_REQUIRED', 'P2 任务必须完成串行集成后才能 pass', EXIT.VALIDATION, { workspaces: taskWorkspaces.map(workspace => ({ workspaceId: workspace.workspaceId, status: workspace.status })) });
    }
  }
  const match = currentCandidateMatches(cwd, t);
  if (!match.ok) {
    console.log(`✗ [${t.id}] ${match.reason}，旧证明失效；请重新 validate 与 Checker。`);
    return failResult('STALE_CANDIDATE', match.reason, EXIT.CONFLICT);
  }
  const hard = (t.attestations || []).find(a => a.type === 'hard-check' && a.verdict === 'PASS' && a.contractDigest === t.contractDigest && a.candidateDigest === t.candidate.digest && a.treeHash === t.candidate.treeHash);
  if (!hard) {
    console.log(`✗ [${t.id}] 缺少绑定当前 contract/candidate 的硬验证证明（hard-check PASS）。`);
    return failResult('ATTESTATION_MISSING', '缺少 hard-check PASS', EXIT.VALIDATION);
  }
  const checker = (t.attestations || []).find(a => a.type === 'checker' && a.verdict === 'PASS' && a.contractDigest === t.contractDigest && a.candidateDigest === t.candidate.digest && a.treeHash === t.candidate.treeHash);
  const structuredRequired = !!loadSecurityPolicy(cwd)?.checker?.requireStructuredReport;
  const criteriaCovered = checker && checker.criteria?.length === (t.acceptanceCriteria || []).length && checker.criteria.every(c => c.verdict === 'PASS' && (!structuredRequired || (Array.isArray(c.evidence) && c.evidence.length && typeof c.confidence === 'number' && Array.isArray(c.limitations))));
  if (!criteriaCovered) {
    console.log(`✗ [${t.id}] 缺少逐条覆盖当前候选的 Checker PASS 证明。`);
    console.log(`  由独立 Checker 执行：rootagent attest checker ${t.id} --report <checker.json> [--issuer <session-id>]`);
    return failResult('ATTESTATION_MISSING', '缺少完整 Checker PASS', EXIT.VALIDATION);
  }
  const hostValidation = validateTaskHostExecutions(t);
  if (!hostValidation.ok) {
    console.log(`✗ [${t.id}] Host execution provenance 无效或存在隔离矛盾。`);
    return failResult('HOST_PROVENANCE_INVALID', 'Host execution provenance 验证失败', EXIT.CONFLICT, { errors: hostValidation.errors });
  }
  const checkerHostBinding = verifyCheckerHostExecutionBinding(t, checker);
  if (!checkerHostBinding.ok) {
    console.log(`✗ [${t.id}] Checker attestation 未绑定当前 Checker Host provenance。`);
    return failResult(checkerHostBinding.code, 'Checker attestation 与 Host execution provenance 不一致', EXIT.POLICY);
  }
  const capabilityValidation = validateTaskHostCapabilityEvidence(t);
  if (!capabilityValidation.ok) {
    console.log(`✗ [${t.id}] Host capability evidence 无效。`);
    return failResult('HOST_CAPABILITY_EVIDENCE_INVALID', 'Host capability evidence 验证失败', EXIT.CONFLICT, { errors: capabilityValidation.errors });
  }
  const hostPolicyValidation = verifyHostPolicyProvenance(
    t.hostPolicy,
    hostValidation.entries.map(entry => entry.provenance),
    capabilityValidation.evidences,
  );
  if (!hostPolicyValidation.ok) {
    console.log(`✗ [${t.id}] Agent Host Policy 未满足。`);
    return failResult('HOST_POLICY_UNSATISFIED', 'Agent Host Policy 未满足', EXIT.POLICY, { errors: hostPolicyValidation.errors });
  }
  const hp = loadHooks(cwd);
  let security;
  try { security = prepareSecurity(cwd, taskSecurityCommands(cwd, t), hp.before_pass?.length ? 'hooks' : 'validation', false); }
  catch (error) { return securityFailure(error); }
  if (security.policy && hard.security?.configDigest !== security.configDigest) {
    return failResult('STALE_SECURITY_ATTESTATION', '安全配置或受信命令在 validate 后变化，请重新验证', EXIT.CONFLICT);
  }
  // before_pass hook（P2-10）：非零退出即拦截（如 git diff --check 发现空白错误）
  if (!runHooks(cwd, hp.before_pass, 'before_pass', security)) {
    console.log(`✗ [${t.id}] before_pass hook 拦截，pass 中止。`);
    return failResult('POLICY_BLOCKED', 'before_pass hook 拦截', EXIT.POLICY);
  }
  // 证据链校验：实现必须已提交，否则 receipt 会把旧 HEAD 当成当前实现的 commit 证据。
  // .rootagent/ 是引擎运行状态，永远忽略。消费项目里可能存在未跟踪的 rootagent.mjs 兼容副本，
  // 该副本可忽略；但如果 rootagent.mjs 本身已被 Git 跟踪（例如 RootAgent 自举开发），它就是产品源码，
  // 任何修改都必须进入提交，不能因为文件名而绕过完成门。
  let dirty = [];
  try {
    const lines = command => execSync(command, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map(line => line.trim()).filter(Boolean);
    const tracked = [...new Set([...lines('git diff --name-only'), ...lines('git diff --cached --name-only')])]
      .filter(rel => !rel.startsWith('.rootagent/'));
    const untracked = lines('git ls-files --others --exclude-standard')
      .filter(rel => !rel.startsWith('.rootagent/'))
      .filter(rel => path.basename(rel) !== 'rootagent.mjs');
    dirty = [...new Set([...tracked, ...untracked])].sort();
  } catch { /* 非 git 项目跳过校验 */ }
  if (dirty.length) {
    console.log(`✗ [${t.id}] 实现尚未提交，拒绝归档。pass 会把旧 HEAD 记成 commit 证据，导致证据链错误。`);
    dirty.slice(0, 8).forEach(l => console.log('   ' + l));
    if (dirty.length > 8) console.log(`   …还有 ${dirty.length - 8} 个未提交文件`);
    console.log('  先 git add + commit 实现（建议信息：feat: [tXXX] …），再执行 pass。');
    return failResult('UNCOMMITTED_CHANGES', '实现尚未提交', EXIT.STATE, { dirty });
  }
  // Product Commit 与 Audit Seal 必须分离：当前产品提交不能把 RootAgent 控制面
  // (.rootagent/**) 一起带入，否则 receipt 与审计状态形成自引用/混合语义。
  const controlCommitPaths = commitRootAgentControlPaths(cwd);
  if (controlCommitPaths.length) {
    console.log(`✗ [${t.id}] 当前产品提交混入 .rootagent 控制面，拒绝归档。`);
    controlCommitPaths.slice(0, 8).forEach(rel => console.log('   ' + rel));
    console.log('  只提交产品文件；任务完成后再用独立 Audit Seal 提交 .rootagent durable state。');
    return failResult('CONTROL_PLANE_IN_PRODUCT_COMMIT', '产品提交混入 .rootagent 控制面', EXIT.CONFLICT, { paths: controlCommitPaths });
  }
  try { assertImprovementAcceptance(cwd, t); } catch (error) { return orchestrationFailure(error); }
  // 审批门（P1-8）：标记 [审批] 的任务必须已人工 review --approve
  if (t.requiresReview && !t.reviewedAt) {
    console.log(`✗ [${t.id}] 标记 [审批]，未经人工 review 不得 pass。`);
    console.log('  审视变更与证据后放行：rootagent review ' + t.id + ' --approve');
    return failResult('APPROVAL_MISSING', '任务需要人工审批', EXIT.POLICY);
  }
  if (t.requiresReview && (!t.approval || t.approval.candidateDigest !== t.candidate.digest)) {
    console.log(`✗ [${t.id}] 人工审批未绑定当前 candidate，旧审批无效。`);
    return failResult('STALE_APPROVAL', '审批未绑定当前 candidate', EXIT.CONFLICT);
  }
  // 证据附件（P1-8）：验收标准 [证据] <路径> 必须已就位
  const evs = evidenceFiles(t);
  if (evs.length) {
    const missing = evs.filter(p => !fs.existsSync(path.resolve(cwd, p)));
    if (missing.length) {
      console.log(`✗ [${t.id}] 证据附件缺失：${missing.join(', ')}（验收标准 [证据] 要求归档留档）`);
      return failResult('EVIDENCE_MISSING', `证据附件缺失：${missing.join(', ')}`, EXIT.VALIDATION, { missing });
    }
    console.log(`  证据附件：${evs.join(', ')} 已就位`);
  }
  if (security.policy?.evidence?.requiredForTaggedCriteria) {
    const required = requiredEvidenceTypes(t);
    const available = listTypedEvidence(cwd, t.id).filter(item => item.candidateDigest === t.candidate.digest);
    const missing = required.filter(type => !available.some(item => item.type === type));
    if (missing.length) {
      console.log(`✗ [${t.id}] 缺少绑定当前候选的类型化证据：${missing.join(', ')}`);
      return failResult('TYPED_EVIDENCE_MISSING', `缺少类型化证据：${missing.join(', ')}`, EXIT.VALIDATION, { missing });
    }
  }
  let commit = '';
  try { commit = execSync('git log --oneline -1', { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* 非 git 项目不阻塞 */ }
  const reusedCommit = t.attempt?.isolationDecision === 'LIGHTWEIGHT' && t.candidate?.commit
    ? data.features.find(task => task.id !== t.id && task.status === 'completed' && task.candidate?.commit === t.candidate.commit)
    : null;
  if (reusedCommit) {
    console.log(`✗ [${t.id}] commit ${t.candidate.commit.slice(0, 12)} 已由 [${reusedCommit.id}] 使用；轻量并行任务必须独立提交。`);
    return failResult('COMMIT_REUSED', `commit 已绑定任务 ${reusedCommit.id}`, EXIT.CONFLICT, { commit: t.candidate.commit, reusedBy: reusedCommit.id });
  }
  let receipt = {
    schemaVersion: 1,
    receiptId: cryptoRandomId(),
    taskId: t.id,
    taskName: t.name,
    acceptedAt: new Date().toISOString(),
    contractDigest: t.contractDigest,
    candidate: t.candidate,
    attempt: t.attempt,
    hardCheck: hard,
    checker,
    hostPolicy: t.hostPolicy || null,
    hostCapabilityEvidence: capabilityValidation.entries,
    hostExecutions: hostValidation.entries,
    security: security.policy ? { configDigest: security.configDigest, approvalId: security.verified.trust.approval.approvalId } : null,
    approval: t.approval || null,
    commit,
  };
  receipt.digest = sha256(receipt);
  const receiptRel = path.join('.rootagent', 'receipts', `${t.id}-${t.candidate.digest.slice(0, 12)}.json`);
  const receiptFile = path.join(cwd, receiptRel);
  if (fs.existsSync(receiptFile)) {
    const existing = JSON.parse(fs.readFileSync(receiptFile, 'utf-8'));
    const claimed = existing.digest;
    const unsigned = { ...existing };
    delete unsigned.digest;
    if (claimed !== sha256(unsigned) || existing.contractDigest !== receipt.contractDigest || existing.candidate?.digest !== receipt.candidate.digest) {
      console.log(`✗ [${t.id}] receipt 路径已存在但 subject 不一致，拒绝覆盖。`);
      return failResult('RECEIPT_CONFLICT', '不可变 receipt 冲突', EXIT.CONFLICT);
    }
    receipt = existing;
  } else atomicWriteJson(receiptFile, receipt);
  transitionTask(t, 'completed');
  if (t.attempt) t.attempt.status = 'ACCEPTED';
  t.completedAt = new Date().toISOString();
  t.commit = commit;
  t.receipt = { path: receiptRel.split(path.sep).join('/'), digest: receipt.digest };
  commitTaskState(cwd, data, [{ taskId: t.id, taskName: t.name, outcome: 'passed', commit, durationMs: durationSince(t), retryCount: t.retryCount }]);
  if (t.proposalSource) {
    try { archiveAutomatedTaskProjection(cwd, t); }
    catch (error) { console.log(`  ⚠ TASK.md 自动归档失败：${error.message}`); }
  }
  console.log(`✓ [${t.id}] ${t.name} 验证通过，已归档${commit ? ` @ ${commit}` : ''}`);
  console.log('  提示：.rootagent/TASK.md 归档到 .rootagent/tasks/done/，然后继续下一个任务。');
  return successResult('ACCEPTED', { taskId: t.id, candidateDigest: t.candidate.digest, receipt: t.receipt, commit });
}

function evidenceFiles(t) {
  return (t.acceptanceCriteria || []).map(c => {
    const m = String(c).match(/^\[证据\]\s*(\S+)/);
    return m ? m[1] : null;
  }).filter(Boolean);
}
function requiredEvidenceTypes(task) {
  const tags = new Map([['视觉', 'visual'], ['性能', 'performance'], ['科学', 'scientific'], ['物理', 'scientific'], ['供应链', 'supply-chain']]);
  const result = new Set();
  for (const criterion of task.acceptanceCriteria || []) for (const [tag, type] of tags) if (String(criterion).includes(`[${tag}]`)) result.add(type);
  return [...result];
}
// ── 安全 harness（P2-9）：命令策略 + 隔离 ─────────────────
const DEFAULT_POLICY = {
  // deny：' rm ' 带前后空格命中"命令中段"；'rm ' 不带前导空格命中"命令开头"（修复：mv/rm 开头的命令此前漏网）
  deny: ['rm ', ' mv ', 'mv ', 'git push', 'sudo ', 'eval ', 'bash -c', 'sh -c', 'mkfs ', 'dd if=', '> /dev/sd', ':(){'],
  approve: ['curl ', 'wget ', 'ssh ', 'scp ', 'rsync ', 'git clone', 'git pull', 'npm install', 'npm i ', 'yarn add', 'pnpm add', 'pip install', 'npx ', 'docker ', 'kubectl '],
  envRestricted: true,
};
function policyFile(cwd) { return path.join(cwd, '.rootagent', 'policy.json'); }
function loadPolicy(cwd) {
  const f = policyFile(cwd);
  if (!fs.existsSync(f)) return { ...DEFAULT_POLICY, deny: [...DEFAULT_POLICY.deny], approve: [...DEFAULT_POLICY.approve] };
  try { return { ...DEFAULT_POLICY, ...JSON.parse(fs.readFileSync(f, 'utf-8')) }; }
  catch { return { ...DEFAULT_POLICY, deny: [...DEFAULT_POLICY.deny], approve: [...DEFAULT_POLICY.approve] }; }
}
function savePolicy(cwd, p) {
  fs.mkdirSync(path.join(cwd, '.rootagent'), { recursive: true });
  atomicWriteJson(policyFile(cwd), p);
}
function policyScan(p, cmd) {
  for (const d of p.deny || []) if (cmd.includes(d)) return { blocked: true, requireApprove: false, rule: d };
  for (const a of p.approve || []) if (cmd.includes(a)) return { blocked: true, requireApprove: true, rule: a };
  return { blocked: false };
}
function cmdPolicy(cwd, args) {
  const p = loadPolicy(cwd);
  if (!args.length) {
    console.log('策略（.rootagent/policy.json）');
    console.log(`  deny（无条件拦截）：${(p.deny || []).join(' | ') || '（空）'}`);
    console.log(`  approve（需 review --approve）：${(p.approve || []).join(' | ') || '（空）'}`);
    console.log(`  envRestricted（受限 env）：${p.envRestricted ? '是' : '否'}`);
    console.log('  用法：policy deny <p1,p2> | policy approve <p1,p2> | policy envRestricted <true|false>');
    return;
  }
  const [key, ...vals] = args;
  if (key === 'deny' || key === 'approve') {
    p[key] = vals.join(' ').split(/[\s,，、]+/).map(s => s.trim()).filter(Boolean);
    savePolicy(cwd, p);
    console.log(`✓ policy.${key} = ${p[key].join(' | ')}`);
  } else if (key === 'envRestricted') {
    p.envRestricted = vals[0] !== 'false' && vals[0] !== '0';
    savePolicy(cwd, p);
    console.log(`✓ policy.envRestricted = ${p.envRestricted}`);
  } else {
    console.log('用法：policy | policy deny <p1,p2> | policy approve <p1,p2> | policy envRestricted <true|false>');
    return failResult('INVALID_ARGUMENT', `未知 policy 字段：${key}`, EXIT.USAGE);
  }
}

// ── Hooks 扩展点（P2-10）：生命周期可插拔硬门 ─────────────
const HOOK_STAGES = ['before_validate', 'after_validate', 'before_pass', 'on_blocked'];
function hooksFile(cwd) { return path.join(cwd, '.rootagent', 'hooks.json'); }
function loadHooks(cwd) {
  const f = hooksFile(cwd);
  const empty = { before_validate: [], after_validate: [], before_pass: [], on_blocked: [] };
  if (!fs.existsSync(f)) return empty;
  try { return { ...empty, ...JSON.parse(fs.readFileSync(f, 'utf-8')) }; }
  catch { return empty; }
}
function saveHooks(cwd, h) {
  fs.mkdirSync(path.join(cwd, '.rootagent'), { recursive: true });
  atomicWriteJson(hooksFile(cwd), h);
}
// hook 非零退出即拦截；返回 false 表示被 hook 拦下
function runHooks(cwd, list, stage, security = null) {
  let ok = true;
  for (const cmd of list || []) {
    const r = executeTrusted(cwd, cmd, security);
    if (!r.ok) {
      console.log(`✗ [hook:${stage}] $ ${cmd} — 退出码 ${r.code}，拦截`);
      ok = false;
    } else {
      console.log(`✓ [hook:${stage}] $ ${cmd}`);
    }
  }
  return ok;
}
function cmdHooks(cwd, args) {
  const h = loadHooks(cwd);
  if (!args.length) {
    console.log('hooks（.rootagent/hooks.json）');
    HOOK_STAGES.forEach(s => console.log(`  ${s}：${(h[s] || []).join(' | ') || '（空）'}`));
    console.log(`  用法：hooks <${HOOK_STAGES.join('|')}> <cmd1;cmd2> | hooks clear <stage>`);
    return;
  }
  const [stage, ...rest] = args;
  if (stage === 'clear') {
    const s = rest[0];
    if (!HOOK_STAGES.includes(s)) { console.log(`阶段必须是 ${HOOK_STAGES.join('/')} 之一。`); return failResult('INVALID_ARGUMENT', `未知 hook 阶段：${s}`, EXIT.USAGE); }
    h[s] = [];
    saveHooks(cwd, h);
    console.log(`✓ hooks.${s} 已清空`);
    return;
  }
  if (!HOOK_STAGES.includes(stage)) { console.log(`阶段必须是 ${HOOK_STAGES.join('/')} 之一。`); return failResult('INVALID_ARGUMENT', `未知 hook 阶段：${stage}`, EXIT.USAGE); }
  h[stage] = rest.join(' ').split(';').map(s => s.trim()).filter(Boolean);
  saveHooks(cwd, h);
  console.log(`✓ hooks.${stage} = ${h[stage].join(' | ')}`);
}

// ── 引擎自举（P2-11）：selftest 全量套件 ──────────────────
function cmdSelftest(cwd, args = []) {
  const testsDir = path.join(cwd, 'tests');
  if (!fs.existsSync(testsDir) || !fs.statSync(testsDir).isDirectory()) {
    console.log('SELFTEST: FAIL - tests/ 目录不存在');
    return false;
  }
  const files = fs.readdirSync(testsDir).filter(f => /^t_.+\.mjs$/.test(f)).sort();
  if (!files.length) {
    console.log('SELFTEST: FAIL - tests/ 下没有 t_*.mjs 套件');
    return false;
  }
  let passed = 0;
  const failed = [];
  const configuredTimeout = Number(process.env.ROOTAGENT_SELFTEST_SUITE_TIMEOUT_MS || 360000);
  const suiteTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 360000;
  const deep = args.includes('--deep');
  const defaultWorkers = Math.min(4, os.availableParallelism?.() || os.cpus().length || 1);
  const configuredWorkers = Number(flagValue(args, '--workers', process.env.ROOTAGENT_SELFTEST_WORKERS || defaultWorkers));
  if (!Number.isInteger(configuredWorkers) || configuredWorkers < 1) {
    console.log('SELFTEST: FAIL - --workers 必须是正整数');
    return false;
  }
  const workers = Math.min(configuredWorkers, files.length);
  console.log(`SELFTEST: RUN - ${files.length} 套件，workers=${workers}，mode=${deep ? 'deep' : 'default'}`);
  const runner = path.resolve(path.dirname(realpathSync(process.argv[1] || new URL(import.meta.url).pathname)), '..', 'lib', 'selftest-runner.mjs');
  const totalTimeoutMs = suiteTimeoutMs * Math.ceil(files.length / workers) + 60000;
  const execution = spawnSync(process.execPath, [runner, JSON.stringify({ cwd, files, timeoutMs: suiteTimeoutMs, workers, parentMode: deep ? 'deep' : '1' })], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: totalTimeoutMs, maxBuffer: 50 * 1024 * 1024,
    env: process.env,
  });
  let suiteResults;
  try { suiteResults = JSON.parse(execution.stdout || '{}').results; } catch { suiteResults = null; }
  if (!Array.isArray(suiteResults)) {
    console.log(`SELFTEST: FAIL - 并行测试调度器异常\n${execution.stderr || execution.stdout || execution.error?.message || '无诊断输出'}`);
    return false;
  }
  for (const r of suiteResults) {
    const f = r.file;
    if (r.code === 0) { passed++; console.log(`✓ ${f} (${r.durationMs}ms)`); }
    else {
      failed.push(f);
      const diagnostic = r.timedOut ? `[TEST-INFRA] 套件超时（${suiteTimeoutMs}ms）：${f}` : r.output.trim().split('\n').slice(-20).join('\n');
      console.log(`✗ ${f}\n${diagnostic}`);
    }
  }
  if (!failed.length) {
    console.log(`SELFTEST: PASS - ${passed}/${files.length} 套件全绿（workers=${workers}）`);
    return true;
  }
  console.log(`SELFTEST: FAIL - ${failed.length}/${files.length} 套件失败：${failed.join(', ')}`);
  return false;
}

// ── 任务分解为图（P3-12）：decompose ─────────────────────
function cmdDecompose(cwd, name, count) {
  const data = loadTasks(cwd);
  const t = parseTaskFromMd(cwd);
  if (t.hostPolicyError) {
    console.log('✗ Agent Host Policy 非法：' + t.hostPolicyError);
    return failResult('INVALID_HOST_POLICY', t.hostPolicyError, EXIT.USAGE);
  }
  if (!t.acceptanceCriteria.length) {
    console.log('✗ decompose：当前 .rootagent/TASK.md 没有验收标准，无法分解。先写好契约（描述/验收标准/验证命令）。');
    return failResult('INVALID_CONTRACT', '没有验收标准，无法分解', EXIT.USAGE);
  }
  const criteria = t.acceptanceCriteria;
  const n = Math.max(2, Math.min(Number(count) || 5, criteria.length * 2));
  const mkId = () => `t${String(data.features.length + 1).padStart(3, '0')}`;
  // 1. 父任务（当前契约）
  const parent = {
    id: mkId(), name,
    description: t.description || name,
    priority: data.features.length + 1,
    status: 'decomposed',
    acceptanceCriteria: criteria,
    validationCommands: t.validationCommands,
    dependsOn: t.dependsOn || [], writes: t.writes || [], parentId: null,
    requiresReview: t.requiresReview || false,
    ...(t.hostPolicy !== undefined ? { hostPolicy: t.hostPolicy } : {}),
    retryCount: 0, blocked: false, validationHistory: [], commit: '',
  };
  initializeTaskTrust(parent);
  data.features.push(parent);
  // 2. 验收标准均分到 n 个子任务（链式依赖）
  const per = Math.ceil(criteria.length / n);
  for (let i = 0; i < n; i++) {
    const part = criteria.slice(i * per, (i + 1) * per);
    const prev = data.features[data.features.length - 1];
    const child = {
      id: mkId(), name: `${name} #${i + 1}`,
      description: `子任务 ${i + 1}/${n}（父 ${parent.id}）：${part.join('；').slice(0, 120)}`,
      priority: data.features.length + 1,
      status: 'pending',
      acceptanceCriteria: part,
      validationCommands: t.validationCommands,
      dependsOn: i === 0 ? [...(t.dependsOn || [])] : [prev.id],
      writes: [...(t.writes || [])], parentId: parent.id,
      requiresReview: false,
      ...(t.hostPolicy !== undefined ? { hostPolicy: t.hostPolicy } : {}),
      retryCount: 0, blocked: false, validationHistory: [], attestations: [], commit: '',
    };
    initializeTaskTrust(child);
    data.features.push(child);
  }
  // 父子图一次 CAS 落盘，崩溃时不会留下半张图。
  saveTasks(cwd, data);
  console.log(`✓ 已分解：父任务 [${parent.id}] ${name} → ${n} 个子任务（${data.features.slice(-n).map(f => f.id).join(', ')}），链式依赖`);
  console.log(`  验收标准 ${criteria.length} 条均分（每子任务 ≤${per} 条），全部继承父任务验证命令`);
  console.log(`  流程：next/start 逐个完成子任务 → 全部 pass 后 rootagent join ${parent.id} 自动归档父任务`);
  return successResult('DECOMPOSED', { parentId: parent.id, children: data.features.slice(-n).map(f => f.id) });
}

// ── 调度触发 + 双模型（P3-13）：config + cron ─────────────
function configFile(cwd) { return path.join(cwd, '.rootagent', 'config.json'); }
function loadConfig(cwd) {
  const f = configFile(cwd);
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return {}; }
}
function cmdConfig(cwd, args) {
  if (!args.length) {
    const c = loadConfig(cwd);
    console.log(`config：checkerModel=${c.checkerModel || '（未设置，Checker 默认同模型）'}`);
    console.log('  用法：config checkerModel <模型名>（独立模型判，不让同一 agent 自批）');
    return;
  }
  const [key, ...vals] = args;
  if (key === 'checkerModel') {
    const c = loadConfig(cwd);
    c.checkerModel = vals.join(' ').trim();
    fs.mkdirSync(path.join(cwd, '.rootagent'), { recursive: true });
    atomicWriteJson(configFile(cwd), c);
    console.log(`✓ config.checkerModel = ${c.checkerModel}`);
  } else {
    console.log('用法：config | config checkerModel <模型名>');
    return failResult('INVALID_ARGUMENT', `未知 config 字段：${key}`, EXIT.USAGE);
  }
}
function cronFile(cwd) { return path.join(cwd, '.rootagent', 'cron.json'); }
function loadCron(cwd) {
  const f = cronFile(cwd);
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return []; }
}
function saveCron(cwd, list) {
  fs.mkdirSync(path.join(cwd, '.rootagent'), { recursive: true });
  atomicWriteJson(cronFile(cwd), list);
}
function cronFieldMatch(field, v) {
  if (field === '*') return true;
  return field.split(',').some(part => {
    if (part.includes('/')) {
      const [base, step] = part.split('/');
      const b = base === '*' ? 0 : Number(base);
      return v >= b && (v - b) % Number(step) === 0;
    }
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      return v >= a && v <= b;
    }
    return Number(part) === v;
  });
}
function cronMatch(expr, d) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return cronFieldMatch(parts[0], d.getMinutes())
    && cronFieldMatch(parts[1], d.getHours())
    && cronFieldMatch(parts[2], d.getDate())
    && cronFieldMatch(parts[3], d.getMonth() + 1)
    && cronFieldMatch(parts[4], d.getDay());
}
function cmdCron(cwd, args) {
  const [sub, ...rest] = args;
  if (sub === 'add') {
    const expr = rest[0];
    const workflowRef = rest[1];
    if (!expr || !workflowRef || rest.length !== 2 || expr.trim().split(/\s+/).length !== 5) {
      console.log('用法：cron add "<分 时 日 月 周>" <已安装 workflowId>（* | */N | a-b | a,b）');
      return failResult('INVALID_ARGUMENT', 'cron 表达式必须是 5 字段且 workflow 引用不能为空', EXIT.USAGE);
    }
    let definition;
    try { definition = resolveWorkflow(cwd, workflowRef); }
    catch (error) { console.log(`✗ cron 只接受已安装 Workflow：${error.message}`); return failResult('WORKFLOW_NOT_FOUND', error.message, EXIT.STATE); }
    const list = loadCron(cwd);
    const id = `c${String(list.length + 1).padStart(2, '0')}`;
    list.push({ id, expr: expr.trim(), workflowId: definition.workflowId, workflowDigest: definition.digest, enabled: true, at: new Date().toISOString() });
    saveCron(cwd, list);
    console.log(`✓ 已注册触发计划 [${id}] ${expr.trim()} → workflow:${definition.workflowId}`);
    return successResult('CRON_ADDED', { id, expr: expr.trim(), workflowId: definition.workflowId, workflowDigest: definition.digest });
  }
  if (sub === 'remove') {
    const id = rest[0];
    const list = loadCron(cwd).filter(x => x.id !== id);
    saveCron(cwd, list);
    console.log(`✓ 已移除 ${id}（若存在）`);
    return;
  }
  if (sub === 'run') {
    const list = loadCron(cwd);
    const now = new Date();
    let ran = 0;
    let failed = 0;
    for (const it of list) {
      if (!it.enabled) continue;
      if (!cronMatch(it.expr, now)) continue;
      if (!it.workflowId) {
        console.log(`✗ [${it.id}] legacy shell cron 已禁用；请删除后改为已安装 Workflow`);
        failed++; ran++; continue;
      }
      try {
        const minute = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const emitted = emitTrigger(cwd, { workflowId: it.workflowId, digest: it.workflowDigest }, `cron:${it.id}:${minute}`, { trigger: 'cron', scheduleId: it.id, scheduledMinute: minute });
        console.log(`✓ [${it.id}] ${it.expr} → TriggerEvent run=${emitted.runId}${emitted.duplicate ? '（deduped）' : ''}`);
        ran++;
      } catch (error) { console.log(`✗ [${it.id}] ${error.message}`); failed++; ran++; }
    }
    console.log(ran ? `CRON: DONE - 本次触发 ${ran} 条` : 'CRON: NONE - 当前分钟无到期条目');
    return failed
      ? failResult('CRON_FAILED', `${failed}/${ran} 条定时命令失败`, EXIT.VALIDATION, { ran, failed })
      : successResult(ran ? 'CRON_DONE' : 'NO_OP', { ran, failed: 0 });
  }
  const list = loadCron(cwd);
  if (!list.length) { console.log('（cron 空）用法：cron add "<分 时 日 月 周>" <workflowId> | cron run | cron remove <id> | cron list'); return; }
  list.forEach(x => console.log(`  [${x.id}] ${x.enabled ? '启用' : '停用'} ${x.expr} → ${x.workflowId ? `workflow:${x.workflowId}` : 'legacy-shell（已禁用）'}`));
  console.log('  外部定时器只需周期调用 rootagent cron run；本命令只提交去重 TriggerEvent，不执行任意 shell。');
}

// 人工检查点（P1-8）：pass 前的审视门
function cmdReview(cwd, idArg, approve) {
  const data = loadTasks(cwd);
  const t = resolveTarget(cwd, data, idArg, 'review');
  if (!t) return;
  try {
    const stat = execSync('git diff --stat HEAD', { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (stat.trim()) console.log(`变更摘要（git diff --stat HEAD）：\n${stat.trim().split('\n').slice(0, 15).join('\n')}`);
    else console.log('变更摘要：无（工作区相对 HEAD 干净）');
  } catch { console.log('变更摘要：非 git 项目，跳过'); }
  let dirty = [];
  try {
    dirty = execSync('git status --porcelain', { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map(l => l.trim()).filter(Boolean);
  } catch { /* 非 git */ }
  console.log(`变更清单：${dirty.length ? dirty.slice(0, 15).join(', ') + (dirty.length > 15 ? ` …共 ${dirty.length} 项` : '') : '干净'}`);
  const vh = (t.validationHistory || []).slice(-2).map(h => h.notes).filter(Boolean);
  console.log(`验证证据：validateCount=${t.validateCount || 0}${vh.length ? `；最近失败：${vh.join('；')}` : '；无失败记录'}${t.requiresReview ? '；标记 [审批]' : ''}`);
  if (approve) {
    if (!t.candidate) {
      t.reviewedAt = new Date().toISOString();
      t.executionApproval = {
        approvalId: cryptoRandomId(), issuer: `human:${workerIdentity()}`,
        issuedAt: t.reviewedAt, contractDigest: t.contractDigest,
        scope: 'validation-command-execution',
      };
      saveTasks(cwd, data);
      console.log(`✓ [${t.id}] 已人工审批通过验证命令执行（仅绑定 contract；完成验收若要求 [审批]，validate 后仍需再次审批 candidate）`);
      return successResult('EXECUTION_APPROVED', { taskId: t.id, contractDigest: t.contractDigest });
    }
    const match = currentCandidateMatches(cwd, t);
    if (!match.ok) {
      console.log(`✗ [${t.id}] ${match.reason}；必须先 validate 当前候选再审批。`);
      return failResult('STALE_CANDIDATE', match.reason, EXIT.CONFLICT);
    }
    t.reviewedAt = new Date().toISOString();
    t.approval = {
      approvalId: cryptoRandomId(), issuer: `human:${workerIdentity()}`,
      issuedAt: t.reviewedAt, contractDigest: t.contractDigest,
      candidateDigest: t.candidate.digest, treeHash: t.candidate.treeHash,
    };
    saveTasks(cwd, data);
    console.log(`✓ [${t.id}] 已人工审批通过（绑定 candidate ${t.candidate.digest.slice(0, 12)}，reviewedAt ${t.reviewedAt.slice(0, 19)}）`);
    return successResult('APPROVED', { taskId: t.id, candidateDigest: t.candidate.digest });
  } else {
    console.log('  审视后若放行：rootagent review ' + t.id + ' --approve');
  }
}

function cmdFail(cwd, idArg, reason, suppliedLease = {}) {
  const data = loadTasks(cwd);
  const t = resolveTarget(cwd, data, idArg, 'fail', true, suppliedLease);
  if (!t) return;
  let blockedSecurity = null;
  if (loadHooks(cwd).on_blocked?.length) {
    try { blockedSecurity = prepareSecurity(cwd, taskSecurityCommands(cwd, t), 'hooks', false); }
    catch (error) { return securityFailure(error); }
  }
  t.retryCount += 1;
  t.validationHistory.push({ at: new Date().toISOString(), notes: reason });
  const h = t.validationHistory;
  const repeated = h.length >= 2 && h[h.length - 1].notes === h[h.length - 2].notes;
  if (t.retryCount >= MAX_RETRY) {
    t.blocked = true;
    t.blockedReason = `已达最大重试 ${MAX_RETRY} 次`;
  } else if (repeated) {
    t.blocked = true;
    t.blockedReason = '连续两次相同失败，重试无信息增益';
  }
  transitionTask(t, t.blocked ? 'blocked' : 'pending');
  if (t.attempt) t.attempt.status = t.blocked ? 'BLOCKED' : 'FAILED';
  t.candidate = null;
  t.attestations = [];
  commitTaskState(cwd, data, [{
    taskId: t.id, taskName: t.name,
    outcome: t.blocked ? 'blocked' : 'validation_failed',
    reason: reason.slice(0, 300), durationMs: durationSince(t), retryCount: t.retryCount,
  }]);
  if (t.blocked) {
    // on_blocked hook（P2-10）：阻塞时触发，失败仅告警不拦截
    const hb = loadHooks(cwd);
    runHooks(cwd, hb.on_blocked, 'on_blocked', blockedSecurity);
  }
  console.log(`✗ [${t.id}] 验证失败 (第 ${t.retryCount} 次)`);
  if (t.blocked) console.log(`  已标记阻塞：${t.blockedReason}。跳过，处理下一个任务（rootagent clear ${t.id} 可人工解除）。`);
  else console.log('  把失败原因粘给 AI，让它针对原因修，不要原样重做。');
  console.log('  教训可沉淀：rootagent lesson add "<一句话教训>" [--evidence <证据>]');
  return failResult(t.blocked ? 'TASK_BLOCKED' : 'TASK_FAILED', reason, t.blocked ? EXIT.BLOCKED : EXIT.VALIDATION, { taskId: t.id, retryCount: t.retryCount, blocked: t.blocked });
}

function cmdJoin(cwd, parentId) {
  const data = loadTasks(cwd);
  const p = findTask(data, parentId);
  if (!p) { console.log(`✗ 父任务不存在：${parentId}`); return failResult('NOT_FOUND', `父任务不存在：${parentId}`, EXIT.STATE); }
  const kids = data.features.filter(c => c.parentId === parentId);
  if (!kids.length) { console.log(`✗ [${parentId}] 没有子任务（无 parentId=${parentId} 的任务）。`); return failResult('INVALID_STATE', '父任务没有子任务', EXIT.STATE); }
  const notDone = kids.filter(k => k.status !== 'completed');
  if (notDone.length) {
    console.log(`JOIN: WAIT - [${parentId}] 还有 ${notDone.length} 个子任务未完成：${notDone.map(k => `${k.id}(${k.status})`).join(', ')}`);
    return failResult('JOIN_WAIT', `${notDone.length} 个子任务未完成`, EXIT.NOT_MET, { pending: notDone.map(k => k.id) });
  }
  transitionTask(p, 'completed');
  p.completedAt = new Date().toISOString();
  commitTaskState(cwd, data, [{ taskId: p.id, taskName: p.name, outcome: 'passed', reason: 'join: 子任务全部完成', durationMs: durationSince(p), retryCount: p.retryCount }]);
  console.log(`JOIN: PASS - [${parentId}] ${p.name} 子任务全部完成，父任务已 completed`);
  console.log('  提示：契约归档 .rootagent/tasks/done/ 后可继续。');
  return successResult('JOINED', { taskId: parentId, children: kids.map(k => k.id) });
}

function cmdClear(cwd, id) {
  const data = loadTasks(cwd);
  const t = findTask(data, id);
  if (!t) { const label = id ? ` ${id}` : ''; console.log(`没有任务${label}。`); return failResult('NOT_FOUND', `没有任务${label}`, EXIT.STATE); }
  if (!t.blocked) { console.log(`[${id}] 不是阻塞状态，无需 clear。`); return failResult('INVALID_STATE', `${id} 不是阻塞状态`, EXIT.STATE); }
  t.blocked = false;
  t.blockedReason = '';
  t.retryCount = 0; // 人工接管 = 新开始；history 保留供参考（教训还在）
  transitionTask(t, 'pending');
  commitTaskState(cwd, data, [{ taskId: t.id, taskName: t.name, outcome: 'cleared', durationMs: durationSince(t), retryCount: 0 }]);
  console.log(`✓ [${t.id}] 已解除阻塞，回 pending。教训保留在 history：`);
  t.validationHistory.slice(-2).forEach(h => console.log(`    - ${h.notes}`));
  return successResult('CLEARED', { taskId: t.id });
}

function cmdGraph(cwd) {
  const data = loadTasks(cwd);
  const nodes = data.features;
  const ids = new Set(nodes.map(f => f.id));
  const graph = new Map();
  nodes.forEach(f => graph.set(f.id, new Set((f.dependsOn || []).filter(d => ids.has(d)))));
  // 边方向：依赖 d → 任务 id，入度 = 该任务的依赖数
  const indeg = new Map(); nodes.forEach(f => indeg.set(f.id, (f.dependsOn || []).filter(d => ids.has(d)).length));
  const q = nodes.filter(f => indeg.get(f.id) === 0).map(f => f.id).sort();
  const order = [];
  while (q.length) {
    const id = q.shift(); order.push(id);
    for (const [tid, deps] of graph) if (deps.has(id)) { indeg.set(tid, indeg.get(tid) - 1); if (indeg.get(tid) === 0) { q.push(tid); q.sort(); } }
  }
  const cyclic = nodes.filter(f => indeg.get(f.id) > 0).map(f => f.id).sort();
  const missing = [];
  nodes.forEach(f => (f.dependsOn || []).forEach(d => { if (!ids.has(d)) missing.push(`[${f.id}] 依赖不存在：${d}`); }));
  // 关键路径：按拓扑序 DP 求最长依赖链
  const depth = new Map(); const prev = new Map();
  nodes.forEach(f => depth.set(f.id, 1));
  for (const id of order) {
    for (const d of graph.get(id) || []) {
      if (depth.get(d) + 1 > depth.get(id)) { depth.set(id, depth.get(d) + 1); prev.set(id, d); }
    }
  }
  let deepest = order.length ? order.reduce((a, b) => (depth.get(a) >= depth.get(b) ? a : b)) : null;
  const chain = [];
  for (let cur = deepest; cur; cur = prev.get(cur)) chain.unshift(cur);
  // 运行时视角：就绪 = 依赖全部完成；等待 = 有未完成依赖
  const doneSet = new Set(nodes.filter(f => f.status === 'completed').map(f => f.id));
  const ready = nodes.filter(f => f.status !== 'completed' && !f.blocked && (f.dependsOn || []).every(d => doneSet.has(d))).map(f => f.id).sort();
  const waiting = nodes.filter(f => f.status !== 'completed' && !f.blocked && (f.dependsOn || []).some(d => !doneSet.has(d))).map(f => `[${f.id}] 依赖未完成`).join(', ');
  console.log(`依赖图（${nodes.length} 个任务）`);
  console.log(`拓扑序: ${order.join(' → ') || '(空)'}`);
  console.log(`就绪: ${ready.join(', ') || '(无)'}`);
  if (waiting) console.log(`等待依赖: ${waiting}`);
  console.log(`环: ${cyclic.length ? cyclic.join(' ↔ ') : '无'}`);
  console.log(`缺失依赖: ${missing.length ? missing.join('；') : '无'}`);
  console.log(`关键路径: ${chain.join(' → ') || '(空)'}（${deepest ? depth.get(deepest) : 0} 层）`);
}

function shellText(cwd, command) {
  try { return execSync(command, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

function controllerGitSnapshot(cwd) {
  const inside = shellText(cwd, 'git rev-parse --is-inside-work-tree') === 'true';
  if (!inside) return { isGit: false, branch: null, head: null, shortHead: null, dirty: false, dirtyPaths: [] };
  const branch = shellText(cwd, 'git branch --show-current') || null;
  const head = shellText(cwd, 'git rev-parse HEAD') || null;
  const dirtyPaths = shellText(cwd, 'git status --porcelain')
    .split('\n').map(line => line.trim()).filter(Boolean)
    .map(line => line.slice(2).trim().replace(/^"|"$/g, ''))
    .filter(rel => rel && !rel.includes('.rootagent/'));
  return { isGit: true, branch, head, shortHead: head ? head.slice(0, 12) : null, dirty: dirtyPaths.length > 0, dirtyPaths };
}

function controllerRunCapabilities(status, pendingInterrupt) {
  return {
    step: status === 'RUNNING' || status === 'WAITING_RETRY',
    pause: status === 'RUNNING' || status === 'WAITING_RETRY',
    resume: status === 'PAUSED' || status === 'WAITING',
    cancel: !['COMPLETED', 'FAILED', 'CANCELLED'].includes(status),
    resolveInterrupt: status === 'WAITING' && !!pendingInterrupt,
  };
}

function controllerTaskCapabilities(cwd, task, nextTaskId, queue, auditReady = false) {
  const hard = (task.attestations || []).find(a => a.type === 'hard-check' && a.verdict === 'PASS' && a.candidateDigest === task.candidate?.digest);
  const checker = (task.attestations || []).find(a => a.type === 'checker' && a.verdict === 'PASS' && a.candidateDigest === task.candidate?.digest);
  let candidateFresh = false;
  if (task.status === 'in_progress' && task.candidate) {
    try { candidateFresh = currentCandidateMatches(cwd, task).ok; } catch { candidateFresh = false; }
  }
  const approvalFresh = !task.requiresReview || !!(task.approval && task.approval.candidateDigest === task.candidate?.digest);
  let hostPolicyReady = true;
  if (task.hostPolicy) {
    const hostValidation = validateTaskHostExecutions(task);
    const capabilityValidation = validateTaskHostCapabilityEvidence(task);
    hostPolicyReady = hostValidation.ok
      && capabilityValidation.ok
      && verifyHostPolicyProvenance(
        task.hostPolicy,
        hostValidation.entries.map(entry => entry.provenance),
        capabilityValidation.evidences,
      ).ok;
  }
  return {
    start: task.status === 'pending' && nextTaskId === task.id && queue.status === 'running',
    validate: task.status === 'in_progress' && queue.status === 'running',
    attestChecker: task.status === 'in_progress' && candidateFresh && !!hard,
    attestHostCapabilities: task.status === 'in_progress',
    attestHostExecution: task.status === 'in_progress' && candidateFresh && !!hard,
    reconcileHostRun: task.status === 'in_progress' && candidateFresh && !!hard,
    pass: task.status === 'in_progress' && candidateFresh && !!hard && !!checker && approvalFresh && hostPolicyReady,
    fail: task.status === 'in_progress',
    clear: task.status === 'blocked' || !!task.blocked,
    review: task.status === 'in_progress' && !!task.requiresReview && candidateFresh,
    auditSeal: auditReady && (task.status === 'completed' || task.status === 'blocked' || !!task.blocked),
  };
}

function controllerRuns(cwd) {
  const root = path.join(cwd, '.rootagent', 'runtime', 'control', 'runs');
  if (!fs.existsSync(root)) return [];
  const summaries = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const { run, definition } = inspectRun(cwd, entry.name);
      summaries.push({
        runId: run.runId,
        workflowId: run.workflowId,
        workflowVersion: run.workflowVersion,
        workflowDigest: run.workflowDigest,
        status: run.status,
        revision: run.revision,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        activeStep: run.activeStep ? { nodeId: run.activeStep.nodeId, startedAt: run.activeStep.startedAt, attempt: run.activeStep.attempt } : null,
        pendingInterrupt: run.pendingInterrupt ? { kind: run.pendingInterrupt.kind, nodeId: run.pendingInterrupt.nodeId, reason: run.pendingInterrupt.reason || null } : null,
        nextRetryAt: run.nextRetryAt || null,
        lastFailure: run.lastFailure || null,
        nodeCount: definition.nodes.length,
        capabilities: controllerRunCapabilities(run.status, run.pendingInterrupt),
      });
    } catch (error) {
      summaries.push({ runId: entry.name, status: 'CORRUPT', error: error.message, capabilities: controllerRunCapabilities('FAILED', null) });
    }
  }
  return summaries.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function cmdSnapshot(cwd) {
  const data = loadTasks(cwd);
  const queue = queueState(cwd, data);
  const next = getNextTask(data);
  const workspaces = listWorkspaces(cwd);
  const integrationQueue = listIntegrationQueue(cwd);
  const policy = loadSecurityPolicy(cwd);
  const audit = auditSealState(cwd);
  let trust = { approvals: [] };
  try { trust = inspectProjectTrust(cwd); } catch { /* no trust record */ }
  const snapshot = {
    schemaVersion: 1,
    revision: data.revision ?? 0,
    generatedAt: new Date().toISOString(),
    project: {
      name: path.basename(cwd),
      path: cwd,
      git: controllerGitSnapshot(cwd),
    },
    goal: { text: data.goal || '', count: data.goalCount ?? null },
    queue: { ...queue, budget: loadBudget(cwd) },
    improvement: { sessions: listImprovementSessions(cwd).map(s => ({ sessionId: s.sessionId, target: s.target, levels: s.levels, status: s.status, stage: s.stage, cycles: s.cycles, maxCycles: s.maxCycles, reason: s.reason || null, taskIds: s.current?.taskIds || [], supervisorCommit: s.supervisor?.commit || null })) },
    currentTaskIds: data.features.filter(task => task.status === 'in_progress').map(task => task.id),
    nextTaskId: next?.id || null,
    tasks: data.features.map(task => ({
      id: task.id,
      name: task.name,
      description: task.description || '',
      status: task.status,
      blocked: !!task.blocked,
      blockedReason: task.blockedReason || null,
      dependsOn: task.dependsOn || [],
      parentId: task.parentId || null,
      priority: task.priority ?? null,
      retryCount: task.retryCount || 0,
      acceptanceCriteria: task.acceptanceCriteria || [],
      validationCommands: task.validationCommands || [],
      writes: task.writes || [],
      resources: task.resources || [],
      contractDigest: task.contractDigest || null,
      requiresReview: !!task.requiresReview,
      hostPolicy: task.hostPolicy || null,
      reviewedAt: task.reviewedAt || null,
      attempt: task.attempt ? {
        attemptId: task.attempt.attemptId,
        status: task.attempt.status,
        fencingToken: task.attempt.fencingToken,
        leaseUntil: task.attempt.leaseUntil,
        isolationDecision: task.attempt.isolationDecision || null,
        isolationReasons: task.attempt.isolationReasons || [],
      } : null,
      candidate: task.candidate ? {
        candidateId: task.candidate.candidateId,
        digest: task.candidate.digest,
        treeHash: task.candidate.treeHash,
        baseCommit: task.candidate.baseCommit || null,
        commit: task.candidate.commit || null,
        changedPaths: task.candidate.changedPaths || [],
      } : null,
      attestations: (task.attestations || []).map(a => ({
        type: a.type,
        verdict: a.verdict,
        issuer: a.issuer || null,
        issuedAt: a.issuedAt || null,
        candidateDigest: a.candidateDigest || null,
        criteria: a.criteria || [],
      })),
      hostCapabilityEvidence: (task.hostCapabilityEvidence || []).map(entry => ({
        registeredAt: entry.registeredAt || null,
        attemptId: entry.attemptId || null,
        fencingToken: entry.fencingToken ?? null,
        evidenceDigest: entry.evidence?.digest || null,
        capabilityDigest: entry.evidence?.capabilityDigest || null,
        assurance: entry.evidence?.assurance || null,
        source: entry.evidence?.source || null,
        digest: entry.digest || null,
      })),
      hostExecutions: (task.hostExecutions || []).map(entry => ({
        role: entry.role,
        attestedAt: entry.attestedAt || null,
        candidateDigest: entry.candidateDigest || null,
        attemptId: entry.attemptId || null,
        fencingToken: entry.fencingToken ?? null,
        executionId: entry.provenance?.executionId || null,
        strategy: entry.provenance?.strategy || null,
        capabilityEvidenceDigest: entry.provenance?.capabilityEvidenceDigest || null,
        physicalIsolation: entry.provenance?.physicalIsolation ?? null,
        independentContext: entry.provenance?.independentContext ?? null,
        contextPacketDigest: entry.provenance?.contextPacketDigest || null,
        digest: entry.digest || null,
      })),
      approval: task.approval || null,
      receipt: task.receipt || null,
      completedAt: task.completedAt || null,
      commit: task.commit || null,
      capabilities: controllerTaskCapabilities(cwd, task, next?.id || null, queue, audit.ready),
    })),
    workspaces: workspaces.map(workspace => ({
      workspaceId: workspace.workspaceId,
      taskId: workspace.taskId,
      status: workspace.status,
      runtimeStatus: workspace.runtimeStatus || null,
      path: workspace.path,
      branch: workspace.branch || null,
      baseCommit: workspace.baseCommit || null,
      candidateDigest: workspace.candidateDigest || null,
      integrationReceiptDigest: workspace.integrationReceiptDigest || null,
      updatedAt: workspace.updatedAt || null,
    })),
    integration: integrationQueue.entries.map(entry => ({
      entryId: entry.entryId,
      taskId: entry.taskId,
      candidateDigest: entry.candidateDigest,
      status: entry.status,
      targetBranch: entry.targetBranch || null,
      createdAt: entry.createdAt || null,
      updatedAt: entry.updatedAt || null,
      receipt: entry.receipt || null,
      lastFailure: entry.lastFailure || null,
      capabilities: { apply: entry.status === 'QUEUED' },
    })),
    runs: controllerRuns(cwd),
    audit: { ready: audit.ready, code: audit.code, paths: audit.paths || [], blockers: audit.blockers || [] },
    security: {
      initialized: !!policy,
      sandbox: detectSandboxBackend(),
      trustRequired: !!policy?.trustRequired,
      approvalCount: trust.approvals?.length || 0,
    },
  };
  console.log(`SNAPSHOT: revision=${snapshot.revision} tasks=${snapshot.tasks.length} runs=${snapshot.runs.length} workspaces=${snapshot.workspaces.length}`);
  return successResult('SNAPSHOT_REPORTED', { snapshot });
}

function cmdStatus(cwd) {
  const data = loadTasks(cwd);
  const total = data.features.length;
  const done = data.features.filter(f => f.status === 'completed').length;
  const blocked = data.features.filter(f => f.blocked).length;
  const cur = getInProgress(data);
  const st = queueState(cwd, data);
  console.log(`目标：${data.goal || '(未设置)'}${data.goalCount ? `（≥${data.goalCount} 个）` : ''}`);
  console.log(`进度：${done}/${total} 完成${blocked ? `，${blocked} 阻塞` : ''}${data.archive.length ? `，已归档 ${data.archive.length} 轮` : ''}`);
  console.log(`队列：${st.status}${st.reason ? `（${st.reason}）` : ''}  ${st.rounds} 轮 / ${st.failed} 失败`);
  const _cm = loadConfig(cwd).checkerModel;
  if (_cm) console.log(`checkerModel：${_cm}（独立模型验证）`);
  data.features.forEach(f => {
    const mark = f.status === 'completed' ? '✓' : f.blocked ? '✗' : f.status === 'decomposed' ? '⊘' : f.status === 'in_progress' ? '▶' : '·';
    const extra = f.blocked && f.blockedReason ? ` — ${f.blockedReason}` : '';
    console.log(`  ${mark} [${f.id}] ${f.name} (${f.status}${f.retryCount ? `, 重试${f.retryCount}` : ''})${extra}`);
  });
  const curs = data.features.filter(f => f.status === 'in_progress');
  if (curs.length) {
    console.log(`\n  当前锁定：${curs.map(c => c.id).join(', ')}${curs.length > 1 ? `（${curs.length} 个并行，定向操作带 id）` : ''}`);
    if (curs.length === 1) {
      const last = lastLedgerAt(cwd);
      const b = loadBudget(cwd);
      if (last && b.staleMs) {
        const mins = Math.round((Date.now() - new Date(last).getTime()) / 60000);
        if (mins > b.staleMs / 60000) console.log(`  ⚠ 已停滞 ${mins} 分钟（> staleMs ${b.staleMs / 60000} 分钟）：建议 doctor / resume`);
      }
    }
  }
}

function cmdProgress(cwd) {
  const data = loadTasks(cwd);
  const tf = taskFiles(cwd);
  const total = data.features.length;
  const done = data.features.filter(f => f.status === 'completed').length;
  const blocked = data.features.filter(f => f.blocked).length;
  const inProgress = data.features.filter(f => f.status === 'in_progress');
  const pending = data.features.filter(f => f.status !== 'completed' && f.status !== 'in_progress' && !f.blocked).length;
  const progressWorkspaces = listWorkspaces(cwd);
  const integrationQueue = listIntegrationQueue(cwd);
  const integration = {};
  for (const entry of integrationQueue.entries) integration[entry.status] = (integration[entry.status] || 0) + 1;
  const openIntegrations = integrationQueue.entries.filter(entry => entry.status !== 'INTEGRATED');
  const goalStatus = total > 0 && done === total && blocked === 0 ? 'SUCCEEDED' : blocked ? 'BLOCKED' : 'RUNNING';
  const deliveryStatus = goalStatus === 'SUCCEEDED' && openIntegrations.length === 0 ? 'DELIVERED' : goalStatus === 'BLOCKED' ? 'BLOCKED' : 'INCOMPLETE';
  const projection = {
    asOfRevision: data.revision ?? null,
    asOf: data.updatedAt ?? null,
    tasks: {
      total, completed: done, inProgress: inProgress.map(task => task.id), blocked, pending,
      states: data.features.map(task => {
        const workspace = progressWorkspaces.filter(item => item.taskId === task.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        return { taskId: task.id, status: task.status, isolationDecision: task.attempt?.isolationDecision || null, isolationReasons: task.attempt?.isolationReasons || [], runtimeStatus: workspace?.runtimeStatus || task.attempt?.runtimeStatus || 'NOT_APPLICABLE' };
      }),
    },
    integration: { total: integrationQueue.entries.length, byStatus: integration, open: openIntegrations.map(entry => ({ entryId: entry.entryId, taskId: entry.taskId, status: entry.status })) },
    goalStatus,
    deliveryStatus,
  };
  console.log(`进度统计 —— ${path.basename(cwd)}`);
  console.log(`  完成：${done}/${total}（${total ? Math.round((done / total) * 100) : 0}%）`);
  console.log(`  进行中：${inProgress.length ? inProgress.map(task => `${task.id} ${task.name}`).join('；') : '无'}  阻塞：${blocked}  待办：${pending}`);
  console.log(`  目标：${goalStatus}  交付：${deliveryStatus}${openIntegrations.length ? `（${openIntegrations.length} 个集成项未完成）` : ''}`);
  if (fs.existsSync(tf.ledger)) {
    const lines = fs.readFileSync(tf.ledger, 'utf-8').trim().split('\n').filter(Boolean);
    const byDay = {};
    let failed = 0;
    for (const l of lines) {
      const e = JSON.parse(l);
      const day = e.at.slice(0, 10);
      byDay[day] = (byDay[day] || 0) + 1;
      if (e.outcome === 'validation_failed') failed += 1;
    }
    console.log(`\n  台账轮次：${lines.length} 轮（失败 ${failed} 次）`);
    console.log('  近 7 天节奏：');
    Object.keys(byDay).sort().slice(-7).forEach(d => console.log(`    ${d}  ${byDay[d]} 轮`));
  }
  return successResult('PROGRESS_REPORTED', projection);
}

function cmdLedger(cwd) {
  const tf = taskFiles(cwd);
  if (!fs.existsSync(tf.ledger)) { console.log('台账为空。'); return; }
  const lines = fs.readFileSync(tf.ledger, 'utf-8').trim().split('\n').slice(-12);
  console.log('最近轮次：');
  lines.forEach(l => {
    const e = JSON.parse(l);
    console.log(`  ${e.at.slice(0, 19)}  [${e.taskId}] ${e.taskName}  ${e.outcome}${e.reason ? ` — ${e.reason.slice(0, 60)}` : ''}`);
  });
}

function cmdReport(cwd, savePath) {
  const data = loadTasks(cwd);
  const lines = [];
  const w = s => lines.push(s);
  w(`# RootAgent 复盘报告 — ${path.basename(cwd)}`);
  w('');
  w(`- 目标：${data.goal || '(未设置)'}${data.goalCount ? `（≥${data.goalCount} 个）` : ''}`);
  w(`- 生成时间：${new Date().toISOString().slice(0, 19)}`);
  w('');
  const total = data.features.length;
  const done = data.features.filter(f => f.status === 'completed').length;
  const blocked = data.features.filter(f => f.blocked).length;
  w(`## 进度：${done}/${total} 完成，${blocked} 阻塞`);
  w('');
  w('## 任务清单');
  w('');
  w('| id | 任务 | 状态 | 重试 | commit |');
  w('|---|---|---|---|---|');
  data.features.forEach(f => w(`| ${f.id} | ${f.name} | ${f.status} | ${f.retryCount} | ${f.commit || '—'} |`));
  const blockedList = data.features.filter(f => f.blocked);
  if (blockedList.length) {
    w('');
    w('## 阻塞任务（需人工决定）');
    blockedList.forEach(f => {
      w(`- **[${f.id}] ${f.name}**：${f.blockedReason}`);
      f.validationHistory.slice(-3).forEach(h => w(`  - ${h.at.slice(0, 10)} ${h.notes.slice(0, 120)}`));
    });
  }
  const lessons = new Map();
  data.features.forEach(f => f.validationHistory.forEach(h => {
    const key = h.notes.slice(0, 60);
    lessons.set(key, (lessons.get(key) || 0) + 1);
  }));
  if (lessons.size) {
    w('');
    w('## 失败教训（按相似原因聚合）');
    [...lessons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .forEach(([k, v]) => w(`- (×${v}) ${k}`));
  }
  const curated = loadLessons(cwd);
  if (curated.length) {
    w('');
    w('## 教训库（curated memory）');
    curated.slice(-5).forEach(l => w(`- [${l.id}] ${l.status} ${l.text}${l.evidence ? ` — 证据：${l.evidence}` : ''}`));
    w(`- 统计：${curated.filter(l => l.status === 'keep').length} keep / ${curated.filter(l => l.status === 'discard').length} discard / 共 ${curated.length}`);
  }
  const next = getNextTask(data);
  if (next) {
    w('');
    w('## 下一步');
    w(`- [${next.id}] ${next.name} — ${next.description.slice(0, 100)}`);
  }
  const out = lines.join('\n');
  if (savePath) {
    fs.mkdirSync(path.dirname(path.resolve(cwd, savePath)), { recursive: true });
    atomicWriteFile(path.resolve(cwd, savePath), out, 'utf-8');
    console.log(`✓ 报告已写入 ${savePath}\n`);
  }
  console.log(out);
}

function cmdPlan(cwd, apply) {
  const planFile = taskFiles(cwd).planMd;
  if (!apply) {
    if (fs.existsSync(planFile)) {
      console.log('.rootagent/PLAN.md 已存在。AI 按格式填写任务清单后：rootagent plan --apply 批量入队。');
      return;
    }
    const data = loadTasks(cwd);
    const expContract = generateExperienceContract(data.goal || '');
    const tpl = `# 规划：${data.goal || '<标题>'}

## 目标

${data.goal || '<一句话目标，含可机器判定的硬指标>'}

${expContract}## 任务清单

### <任务名 1>
描述：<一句话描述>

验收标准：
- <可判定的标准，如"npm run build 通过">
- <功能/物理/交互/内容/视觉类标准>

验证命令：
- <引擎亲自跑的命令，如 npm run build>

### <任务名 2>
...
`;
    atomicWriteFile(planFile, tpl, 'utf-8');
    console.log(`✓ 已生成融合品类体验契约的 ${planFile}`);
    console.log('  AI 填写任务清单（每个 ### 一段，含描述/验收标准/验证命令）后执行：rootagent plan --apply');
    return;
  }
  const p = parsePlanFromMd(cwd);
  if (!p.tasks.length) { console.log('.rootagent/PLAN.md 里没有可解析的任务（### 开头段落）。'); return failResult('INVALID_PLAN', 'PLAN.md 没有可解析任务', EXIT.USAGE); }
  const data = loadTasks(cwd);
  const base = data.features.length; // 固定基线，避免 forEach 中 length 动态变化导致跳号
  const newTasks = p.tasks.map((t, i) => initializeTaskTrust({
    id: `t${String(base + 1 + i).padStart(3, '0')}`,
    name: t.name,
    description: t.description,
    priority: base + 1 + i,
    status: 'pending',
    acceptanceCriteria: t.acceptanceCriteria,
    validationCommands: t.validationCommands,
    dependsOn: t.dependsOn || [],
    writes: t.writes || [],
    parentId: t.parentId || null,
    requiresReview: t.requiresReview || false,
    retryCount: 0,
    blocked: false,
    validationHistory: [],
    attestations: [],
    commit: '',
  }));
  const err = validateDeps(data.features, newTasks);
  if (err) { console.log(`✗ 规划入队被拒绝：${err}（未入队任何任务）。`); return failResult('INVALID_PLAN', err, EXIT.STATE); }
  const invalid = newTasks.find(t => !t.acceptanceCriteria.length || !t.validationCommands.length);
  if (invalid) {
    console.log(`✗ 规划入队被拒绝：[${invalid.id}] ${invalid.name} 缺少验收标准或验证命令（未入队任何任务）。`);
    return failResult('INVALID_PLAN', `${invalid.id} 契约不完整`, EXIT.USAGE);
  }
  // 父任务存在性校验（plan 批量）
  for (const t of newTasks) {
    if (t.parentId && !data.features.some(f => f.id === t.parentId) && !newTasks.some(f => f.id === t.parentId)) {
      console.log(`✗ 规划入队被拒绝：父任务不存在 ${t.parentId}（未入队任何任务）。`); return failResult('INVALID_PLAN', `父任务不存在 ${t.parentId}`, EXIT.STATE);
    }
  }
  newTasks.forEach(t => data.features.push(t));
  if (p.goal && !data.goal) data.goal = p.goal;
  saveTasks(cwd, data);
  console.log(`✓ 已从 .rootagent/PLAN.md 批量入队 ${newTasks.length} 个任务${p.goal ? `，目标：${p.goal}` : ''}`);
  console.log('  提示：.rootagent/PLAN.md 可归档到 .rootagent/tasks/done/ 保留规划痕迹。');
}

function cmdGoal(cwd, args) {
  const data = loadTasks(cwd);
  const check = args[0] === 'check';
  if (check) {
    const st = queueState(cwd, data);
    if (st.status === 'exhausted') { console.log(`GOAL: EXHAUSTED - ${st.reason}`); return failResult('EXHAUSTED', st.reason, EXIT.EXHAUSTED); }
    if (st.status === 'stalled') { console.log(`GOAL: STALLED - ${st.reason}`); return failResult('STALLED', st.reason, EXIT.BLOCKED); }
    const done = data.features.filter(f => f.status === 'completed').length;
    const remaining = data.features.filter(f => f.status === 'pending' || f.status === 'in_progress' || f.status === 'decomposed').length;
    const blocked = data.features.filter(f => f.blocked || f.status === 'blocked').length;
    if (blocked) {
      console.log(`GOAL: BLOCKED - ${blocked} 个任务阻塞，${done}/${data.features.length} 完成`);
      return failResult('BLOCKED', `${blocked} 个任务阻塞`, EXIT.BLOCKED, { done, blocked, remaining });
    }
    if (remaining || (data.goalCount != null && done < data.goalCount)) {
      const reason = data.goalCount != null ? `${done}/${data.goalCount}，继续` : `剩 ${remaining} 个`;
      console.log(`GOAL: NOT_MET - ${reason}`);
      console.log(`GOAL: NOT（${reason}）`);
      return failResult('NOT_MET', reason, EXIT.NOT_MET, { done, target: data.goalCount, remaining });
    }
    const def = data.goalDefinition || { probes: [], invariants: [] };
    const checks = [];
    const goalCommands = [...(def.probes || []), ...(def.invariants || [])].map(item => ({ cmd: item.cmd, level: 1, ladder: 'V' }));
    let goalSecurity;
    try { goalSecurity = prepareSecurity(cwd, goalCommands, 'workflow', false); }
    catch (error) { return securityFailure(error); }
    for (const [kind, items] of [['probe', def.probes || []], ['invariant', def.invariants || []]]) {
      for (const item of items) {
        const p = loadPolicy(cwd);
        const scan = policyScan(p, item.cmd);
        if (scan.blocked) {
          checks.push({ kind, cmd: item.cmd, verdict: 'FAIL', reason: 'POLICY_BLOCKED' });
          continue;
        }
        const r = goalSecurity.policy ? executeTrusted(cwd, item.cmd, goalSecurity) : runCmd(item.cmd, cwd, undefined, true);
        checks.push({ kind, cmd: item.cmd, verdict: r.ok ? 'PASS' : 'FAIL', exitCode: r.code, outputDigest: sha256(r.out) });
      }
    }
    const failed = checks.filter(c => c.verdict !== 'PASS');
    if (failed.length) {
      console.log(`GOAL: FAILED - ${failed.length}/${checks.length} 个业务谓词或质量不变量失败`);
      failed.forEach(c => console.log(`  ✗ [${c.kind}] ${c.cmd}（${c.reason || `exit=${c.exitCode}`}）`));
      return failResult('FAILED', '业务谓词或质量不变量失败', EXIT.VALIDATION, { checks });
    }
    if (!data.features.length && !checks.length && data.goalCount == null) {
      console.log('GOAL: NO_OP - 没有任务或可执行谓词');
      return successResult('NO_OP', { done: 0, checks: [] });
    }
    // 整体体验与反偷懒终验 (Project Final Experience Gate)
    const expAudit = auditProjectExperience(cwd, data.goal || '');
    if (!expAudit.ok) {
      console.log(`\nGOAL: FAILED - 项目级体验与反偷懒审计未通过：`);
      expAudit.violations.forEach(v => console.log(`  ✗ ${v}`));
      return failResult('EXPERIENCE_GOAL_FAILED', '项目级体验审计失败：存在偷懒或违背品类基线行为', EXIT.VALIDATION, { violations: expAudit.violations });
    }
    // 游戏与交互体验探针实机终验（杜绝不可操作的静态空壳）
    const matchedArchetypes = detectArchetypes(data.goal || '');
    if (matchedArchetypes.some(a => a.key === '3d-game-interactive')) {
      const probeRes = runPlayabilityProbe(cwd);
      if (!probeRes.ok && probeRes.score < 60) {
        console.log(`\nGOAL: FAILED - 游戏可玩性体验探针未达标（得分 ${probeRes.score}/100）：`);
        probeRes.results.filter(r => !r.pass).forEach(r => console.log(`  ✗ [${r.name}] ${r.reason}`));
        return failResult('PLAYABILITY_PROBE_FAILED', '游戏核心可玩性体验未达标，严禁将不可玩或无操作反馈的空壳交付！', EXIT.VALIDATION, probeRes);
      }
    }
    console.log(`GOAL: SUCCEEDED - ${done}/${data.features.length} 任务完成，${checks.length} 个谓词/不变量通过`);
    console.log(`GOAL: MET（${data.goalCount != null ? `${done}/${data.goalCount}` : '队列清空'}）`);
    return successResult('SUCCEEDED', { done, target: data.goalCount, checks });
  }
  const ci = args.indexOf('--count');
  const count = ci !== -1 ? parseInt(args[ci + 1], 10) : null;
  const probes = [];
  const invariants = [];
  const textArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--count') { i++; continue; }
    if (args[i] === '--probe') { probes.push({ type: 'command', cmd: String(args[++i] || '') }); continue; }
    if (args[i] === '--invariant') { invariants.push({ type: 'command', cmd: String(args[++i] || '') }); continue; }
    if (args[i] === '--help' || args[i] === '-h') {
      console.log('用法：rootagent goal "<目标>" [--count N] [--probe <cmd>] [--invariant <cmd>] | goal check');
      console.log('  goal "<目标>"          设置新目标（覆盖旧目标）');
      console.log('  goal check             检查目标是否达成（GOAL: MET / NOT）');
      console.log('  --count N              目标完成数量硬指标');
      console.log('  --probe <cmd>          目标达成探针命令（退出码0=PASS）');
      console.log('  --invariant <cmd>      质量不变量命令');
      return successResult('HELP', {});
    }
    textArgs.push(args[i]);
  }
  const text = textArgs.join(' ').trim();
  if (!text && count == null && !probes.length && !invariants.length) {
    console.log('用法：rootagent goal "<目标>" [--count N] [--probe <cmd>] [--invariant <cmd>] | goal check');
    return failResult('INVALID_ARGUMENT', '目标、数量或谓词至少提供一项', EXIT.USAGE);
  }
  if (ci !== -1 && (!Number.isInteger(count) || count < 0)) {
    console.log('✗ --count 必须是非负整数。');
    return failResult('INVALID_ARGUMENT', '--count 必须是非负整数', EXIT.USAGE);
  }
  if ([...probes, ...invariants].some(p => !p.cmd)) {
    console.log('✗ --probe/--invariant 后必须提供命令。');
    return failResult('INVALID_ARGUMENT', '谓词命令不能为空', EXIT.USAGE);
  }
  if (text) data.goal = text;
  data.goalCount = count;
  data.goalDefinition = {
    text: data.goal || '', count, probes, invariants,
    digest: sha256({ text: data.goal || '', count, probes, invariants }),
    updatedAt: new Date().toISOString(),
  };
  saveTasks(cwd, data);
  console.log(`✓ 目标已设置：${data.goal || '(沿用)'}${count != null ? `（≥${count} 个）` : ''}，probe=${probes.length}，invariant=${invariants.length}`);
  console.log('  每轮结束调用：rootagent goal check（输出 GOAL: MET / NOT，机器可读）');
  return successResult('GOAL_CONFIGURED', { goalDigest: data.goalDefinition.digest, probes: probes.length, invariants: invariants.length });
}

// ── 三层验证工具链 ──────────────────────────────────────
function cmdVerify(cwd, args) {
  const sub = args[0];
  const skillRoot = path.dirname(new URL(import.meta.url).pathname).replace(/\/bin$/, '');
  const verifyAssets = path.join(skillRoot, 'assets', 'verify');

  if (sub === 'init') {
    const verifyDir = path.join(cwd, 'scripts', 'verify');
    fs.mkdirSync(verifyDir, { recursive: true });

    // 复制标准验证脚本
    const scripts = ['file-check.mjs', 'math-assert.mjs', 'smoke.mjs'];
    for (const s of scripts) {
      const src = path.join(verifyAssets, s);
      const dst = path.join(verifyDir, s);
      fs.copyFileSync(src, dst);
      console.log('  ✓ scripts/verify/' + s);
    }

    // 生成示例配置
    const configDir = path.join(verifyDir, 'configs');
    fs.mkdirSync(configDir, { recursive: true });

    const sampleFileCheck = {
      files: [
        { path: 'experiments/01-example.html', minSize: 3000, contains: ['three', 'canvas'] }
      ]
    };
    fs.writeFileSync(path.join(configDir, 'file-check.example.json'), JSON.stringify(sampleFileCheck, null, 2) + '\n');

    const sampleMath = {
      assertions: [
        { name: '示例：单摆周期', expr: '2*PI*sqrt(1/9.8)', expect: 2.006, tol: 0.01 }
      ]
    };
    fs.writeFileSync(path.join(configDir, 'math-assert.example.json'), JSON.stringify(sampleMath, null, 2) + '\n');

    const sampleSmoke = {
      tests: [
        { file: 'experiments/01-example.html', minScreenshotKB: 20, checkCanvas: false, checkSliders: true }
      ]
    };
    fs.writeFileSync(path.join(configDir, 'smoke.example.json'), JSON.stringify(sampleSmoke, null, 2) + '\n');

    // 生成综合 runner（run-all.mjs）
    const runnerCode = [
      '#!/usr/bin/env node',
      '/**',
      ' * 三层综合验证（goal probe 入口）',
      ' * 用法: node scripts/verify/run-all.mjs',
      ' */',
      "import { execSync } from 'child_process';",
      'import fs from \'fs\';',
      'import path from \'path\';',
      '',
      'const __dirname = path.dirname(new URL(import.meta.url).pathname);',
      'const root = path.join(__dirname, \'..\', \'..\');',
      'const configDir = path.join(__dirname, \'configs\');',
      '',
      'const layers = [];',
      '',
      'const fileConfig = path.join(configDir, \'file-check.json\');',
      'if (fs.existsSync(fileConfig)) {',
      '  layers.push({ name: \'第一层：文件检查\', cmd: \'node \' + path.join(__dirname, \'file-check.mjs\') + \' \' + fileConfig });',
      '}',
      '',
      'const mathConfig = path.join(configDir, \'math-assert.json\');',
      'if (fs.existsSync(mathConfig)) {',
      '  layers.push({ name: \'第二层：数值断言\', cmd: \'node \' + path.join(__dirname, \'math-assert.mjs\') + \' \' + mathConfig });',
      '}',
      '',
      'const smokeConfig = path.join(configDir, \'smoke.json\');',
      'if (fs.existsSync(smokeConfig)) {',
      '  layers.push({ name: \'第三层：冒烟测试\', cmd: \'node \' + path.join(__dirname, \'smoke.mjs\') + \' \' + smokeConfig });',
      '}',
      '',
      'let fail = 0;',
      'for (const l of layers) {',
      '  console.log(\'\\n=== \' + l.name + \' ===\');',
      '  try { console.log(execSync(l.cmd, { cwd: root, timeout: 180000 }).toString()); }',
      '  catch (e) {',
      '    console.error(e.stdout ? e.stdout.toString() : \'\');',
      '    console.error(e.stderr ? e.stderr.toString() : e.message);',
      '    fail++;',
      '  }',
      '}',
      '',
      'if (fail > 0) { console.error(\'\\nFAIL: \' + fail + \' layers failed\'); process.exit(1); }',
      'console.log(\'\\nPASS: all layers green\');',
    ].join('\n');
    fs.writeFileSync(path.join(verifyDir, 'run-all.mjs'), runnerCode + '\n');

    console.log('\n✓ 验证工具链已初始化到 scripts/verify/');
    console.log('\n下一步：');
    console.log('  1. 复制 configs/*.example.json 为 *.json，填入你的实验参数');
    console.log('  2. 跑验证：node scripts/verify/run-all.mjs');
    console.log('  3. 设置 goal probe：rootagent goal "你的目标" --probe "node scripts/verify/run-all.mjs"');
    return successResult('VERIFY_INIT', { dir: verifyDir });
  }

  if (sub === 'run' || sub === 'check') {
    const runner = path.join(cwd, 'scripts', 'verify', 'run-all.mjs');
    if (!fs.existsSync(runner)) {
      console.error('✗ 未找到 scripts/verify/run-all.mjs，先跑 rootagent verify init');
      return failResult('NOT_INITIALIZED', 'verify not initialized', EXIT.USAGE);
    }
    try {
      const out = execSync('node "' + runner + '"', { cwd, timeout: 300000 });
      console.log(out.toString());
      return successResult('VERIFY_PASSED');
    } catch (e) {
      console.error(e.stdout ? e.stdout.toString() : '');
      console.error(e.stderr ? e.stderr.toString() : e.message);
      return failResult('VERIFY_FAILED', 'verification failed', EXIT.VALIDATION);
    }
  }

  console.log('用法：rootagent verify init | verify run');
  console.log('  verify init   在项目 scripts/verify/ 生成三层验证工具链和示例配置');
  console.log('  verify run    跑三层综合验证（文件检查 + 数值断言 + 冒烟测试）');
  return failResult('USAGE', 'unknown subcommand', EXIT.USAGE);
}

// ── Durable Control Graph（v4 P1）─────────────────────────
function printWorkflowErrors(errors) {
  for (const e of errors || []) console.log(`  ✗ ${e.code}${e.nodeId ? ` [${e.nodeId}]` : ''}: ${e.message}`);
}
function cmdWorkflow(cwd, args) {
  const [sub, ref] = args;
  if (!['validate', 'install', 'show'].includes(sub) || !ref) {
    console.log('用法：workflow validate|install|show <definition.json|workflowId>');
    return failResult('INVALID_ARGUMENT', 'workflow 子命令或引用缺失', EXIT.USAGE);
  }
  try {
    if (sub === 'install') {
      const installed = installWorkflow(cwd, ref);
      if (!installed.ok) {
        printWorkflowErrors(installed.errors);
        return failResult('WORKFLOW_INVALID', `${installed.errors.length} 个 WorkflowDefinition 错误`, EXIT.VALIDATION, { errors: installed.errors });
      }
      console.log(`WORKFLOW: INSTALLED - ${installed.definition.workflowId}@${installed.definition.version} digest=${installed.digest}`);
      return successResult('WORKFLOW_INSTALLED', { workflowId: installed.definition.workflowId, version: installed.definition.version, digest: installed.digest, path: installed.path });
    }
    let definition;
    if (fs.existsSync(path.resolve(cwd, ref))) {
      const raw = JSON.parse(fs.readFileSync(path.resolve(cwd, ref), 'utf-8'));
      const checked = validateWorkflowDefinition(raw);
      if (!checked.ok) {
        printWorkflowErrors(checked.errors);
        return failResult('WORKFLOW_INVALID', `${checked.errors.length} 个 WorkflowDefinition 错误`, EXIT.VALIDATION, { errors: checked.errors });
      }
      definition = checked.definition;
    } else definition = resolveWorkflow(cwd, ref);
    if (sub === 'show') console.log(JSON.stringify(definition, null, 2));
    else console.log(`WORKFLOW: VALID - ${definition.workflowId}@${definition.version} digest=${definition.digest}`);
    return successResult(sub === 'show' ? 'WORKFLOW_SHOWN' : 'WORKFLOW_VALID', { workflowId: definition.workflowId, version: definition.version, digest: definition.digest, ...(sub === 'show' ? { definition } : {}) });
  } catch (error) {
    if (error.validation) {
      printWorkflowErrors(error.validation.errors);
      return failResult('WORKFLOW_INVALID', `${error.validation.errors.length} 个 WorkflowDefinition 错误`, EXIT.VALIDATION, { errors: error.validation.errors });
    }
    console.log(`✗ ${error.message}`);
    if (error.code === 'ROOTAGENT_WORKFLOW_VERSION_CONFLICT') return failResult('WORKFLOW_VERSION_CONFLICT', error.message, EXIT.CONFLICT);
    return failResult('WORKFLOW_NOT_FOUND', error.message, EXIT.STATE);
  }
}

function executeGraphCommand(cwd, command, context) {
  const policy = loadPolicy(cwd);
  const decision = policyScan(policy, commandDisplay(command));
  if (decision.blocked && !decision.requireApprove) return { ok: false, code: EXIT.POLICY, out: `策略拒绝：${decision.rule}`, failureClass: 'POLICY' };
  if (decision.blocked && decision.requireApprove) {
    const approved = Object.values(context.run.state.nodes || {}).some(value => value?.approved === true);
    if (!approved) return { ok: false, code: EXIT.POLICY, out: `命令需要持久 approval interrupt：${decision.rule}`, failureClass: 'POLICY' };
  }
  const traceContext = createTraceContext(cwd, 'workflow', context.run.runId, `step:${context.run.activeStep?.executionKey || context.node.id}`);
  const extra = {
    ROOTAGENT_RUN_ID: context.run.runId,
    ROOTAGENT_NODE_ID: context.node.id,
    ROOTAGENT_IDEMPOTENCY_KEY: context.idempotencyKey || '',
    ROOTAGENT_COMPENSATION: context.compensation ? '1' : '0',
    ROOTAGENT_TRACE_ID: traceContext.traceId,
    ROOTAGENT_SPAN_ID: traceContext.spanId,
    ROOTAGENT_TRACEPARENT: traceContext.traceparent,
    TRACEPARENT: traceContext.traceparent,
  };
  try {
    const commands = [command];
    const security = prepareSecurity(cwd, commands, 'workflow', false);
    return executeTrusted(cwd, command, security, extra);
  } catch (error) {
    return { ok: false, code: EXIT.POLICY, out: `${error.code || 'SECURITY_ERROR'}: ${error.message}`, failureClass: 'POLICY' };
  }
}
function graphFailureExit(failure) {
  if (failure?.class === 'POLICY') return EXIT.POLICY;
  if (failure?.class === 'CONFLICT') return EXIT.CONFLICT;
  if (failure?.class === 'INFRASTRUCTURE') return EXIT.INTERNAL;
  return EXIT.VALIDATION;
}
function graphStepResult(result) {
  const data = { runId: result.run.runId, workflowId: result.run.workflowId, revision: result.run.revision, recoveredFromEvents: !!result.recoveredFromEvents };
  if (result.interrupt) data.interrupt = result.interrupt;
  if (result.failure) data.failure = result.failure;
  if (result.retryAt) data.retryAt = result.retryAt;
  console.log(`RUN: ${result.status} - ${result.run.runId} revision=${result.run.revision}`);
  if (result.interrupt) console.log(`  interrupt=${result.interrupt.interruptId} kind=${result.interrupt.kind} node=${result.interrupt.nodeId}`);
  if (result.failure) console.log(`  failure=${result.failure.class}: ${result.failure.message}`);
  if (result.status === 'RUNNING' || result.status === 'COMPLETED') return successResult(result.status, data);
  if (result.status === 'WAITING' || result.status === 'WAITING_RETRY' || result.status === 'PAUSED') return failResult(result.status, result.interrupt?.payload?.message || `run ${result.status}`, EXIT.NOT_MET, data);
  if (result.status === 'CANCELLED') return failResult('CANCELLED', result.run.cancelReason || 'run cancelled', EXIT.STATE, data);
  return failResult('FAILED', result.failure?.message || 'run failed', graphFailureExit(result.failure), data);
}
function cmdRun(cwd, args) {
  const [sub, runIdOrRef] = args;
  try {
    if (sub === 'create') {
      if (!runIdOrRef) return failResult('INVALID_ARGUMENT', 'run create 需要 workflow 引用', EXIT.USAGE);
      const rawInput = optionValue(args, '--input');
      const input = rawInput == null ? {} : parseJsonArgument(cwd, rawInput);
      const created = createRun(cwd, runIdOrRef, input);
      console.log(`RUN: CREATED - ${created.run.runId} workflow=${created.run.workflowId}@${created.run.workflowVersion}`);
      return successResult('RUN_CREATED', { runId: created.run.runId, workflowId: created.run.workflowId, workflowDigest: created.run.workflowDigest, duplicate: !!created.duplicate });
    }
    if (!runIdOrRef) return failResult('INVALID_ARGUMENT', `run ${sub || '(空)'} 需要 runId`, EXIT.USAGE);
    if (sub === 'step') return graphStepResult(executeRunStep(cwd, runIdOrRef, {
      once: args.includes('--once'),
      executeCommand: (cmd, context) => executeGraphCommand(cwd, cmd, context),
      crashPoint: process.env.ROOTAGENT_TEST_MODE === '1' ? process.env.ROOTAGENT_TEST_CRASH_POINT : null,
    }));
    if (sub === 'inspect') {
      const inspected = inspectRun(cwd, runIdOrRef);
      console.log(`RUN: ${inspected.run.status} - ${inspected.run.runId} revision=${inspected.run.revision}`);
      const trace = buildExplainableTrace(cwd, runIdOrRef);
      console.log(`  why=${trace.whyStopped.code}: ${trace.whyStopped.message}`);
      console.log(`  trace=${trace.traceId} spans=${trace.spans.length} untested=${trace.untested.length}`);
      return successResult('RUN_INSPECTED', { run: inspected.run, recoveredFromEvents: inspected.recoveredFromEvents, eventCount: inspected.events.length, explanation: { traceId: trace.traceId, whyStopped: trace.whyStopped, actors: trace.actors, changed: trace.changed, untested: trace.untested, cost: trace.cost, evidence: trace.evidence } });
    }
    if (sub === 'pause') {
      const run = pauseRun(cwd, runIdOrRef); console.log(`RUN: PAUSED - ${run.runId}`); return successResult('PAUSED', { runId: run.runId, revision: run.revision });
    }
    if (sub === 'resume') {
      const raw = optionValue(args, '--value'); const value = raw == null ? undefined : parseJsonArgument(cwd, raw);
      const run = resumeRun(cwd, runIdOrRef, value); console.log(`RUN: ${run.status} - ${run.runId} resumed`); return successResult(run.status, { runId: run.runId, revision: run.revision });
    }
    if (sub === 'cancel') {
      const reason = optionValue(args, '--reason') || '';
      const run = cancelRun(cwd, runIdOrRef, reason); console.log(`RUN: CANCELLED - ${run.runId}`); return failResult('CANCELLED', reason || 'run cancelled', EXIT.STATE, { runId: run.runId, revision: run.revision });
    }
    console.log('用法：run create <workflow> [--input JSON|file] | step <runId> [--once] | inspect|pause|resume|cancel <runId>');
    return failResult('INVALID_ARGUMENT', `未知 run 子命令：${sub || '(空)'}`, EXIT.USAGE);
  } catch (error) {
    console.log(`✗ ${error.message}`);
    if (error.validation) return failResult('WORKFLOW_INVALID', `${error.validation.errors.length} 个 WorkflowDefinition 错误`, EXIT.VALIDATION, { errors: error.validation.errors });
    const code = error.code === 'ROOTAGENT_RUN_HISTORY_CORRUPT' ? EXIT.STATE : error instanceof SyntaxError ? EXIT.USAGE : EXIT.STATE;
    return failResult(error.code === 'ROOTAGENT_RUN_HISTORY_CORRUPT' ? 'RUN_HISTORY_CORRUPT' : 'RUN_ERROR', error.message, code);
  }
}

function cmdTrigger(cwd, args) {
  const [sub, workflowRef] = args;
  try {
    if (sub === 'emit') {
      const fireKey = optionValue(args, '--fire-key');
      if (!workflowRef || !fireKey) return failResult('INVALID_ARGUMENT', 'trigger emit 需要 workflow 和 --fire-key', EXIT.USAGE);
      const raw = optionValue(args, '--payload'); const payload = raw == null ? {} : parseJsonArgument(cwd, raw);
      const emitted = emitTrigger(cwd, workflowRef, fireKey, payload);
      console.log(`TRIGGER: ${emitted.duplicate ? 'DEDUPED' : 'CREATED'} - ${emitted.workflowId} fireKey=${fireKey} run=${emitted.runId}`);
      return successResult(emitted.duplicate ? 'TRIGGER_DEDUPED' : 'TRIGGER_CREATED', emitted);
    }
    if (sub === 'list') {
      const events = listTriggerEvents(cwd);
      events.forEach(e => console.log(`  ${e.at} ${e.workflowId} fireKey=${e.fireKey} run=${e.runId}`));
      return successResult('TRIGGERS_LISTED', { events });
    }
    console.log('用法：trigger emit <workflow> --fire-key <key> [--payload JSON|file] | trigger list');
    return failResult('INVALID_ARGUMENT', '未知 trigger 子命令', EXIT.USAGE);
  } catch (error) {
    console.log(`✗ ${error.message}`);
    return failResult('TRIGGER_ERROR', error.message, EXIT.STATE);
  }
}

// ── 大型项目编排（v4 P2）─────────────────────────────────
function orchestrationFailure(error, fallback = 'ORCHESTRATION_ERROR') {
  console.log(`✗ ${error.message}`);
  const conflict = ['RESOURCE_CONFLICT', 'WORKSPACE_EXISTS', 'STALE_WORKSPACE', 'WRITE_SET_VIOLATION', 'INTEGRATION_BUSY', 'DIRTY_TARGET', 'TARGET_MOVED', 'ADAPTER_CONFLICT'].includes(error.code);
  const validation = ['DIRTY_WORKTREE', 'EMPTY_CANDIDATE', 'PROPOSAL_CORRUPT', 'CANDIDATE_CORRUPT', 'INVALID_RESOURCE'].includes(error.code);
  return failResult(error.code || fallback, error.message, conflict ? EXIT.CONFLICT : validation ? EXIT.VALIDATION : EXIT.STATE, error.data || {});
}

function cmdWorkspace(cwd, args) {
  const [sub, ref] = args;
  try {
    if (sub === 'create') {
      const data = loadTasks(cwd); const task = findTask(data, ref || getInProgress(data)?.id);
      if (!task) return failResult('TASK_NOT_FOUND', `任务不存在：${ref || '(当前)'}`, EXIT.STATE);
      const record = createWorkspace(cwd, task, { base: optionValue(args, '--base'), resources: parseFlagList(args, '--resources'), leaseMs: Number(optionValue(args, '--lease-ms') || 0) || undefined });
      console.log(`WORKSPACE: CREATED - ${record.workspaceId} branch=${record.branch}\n  path=${record.path}`);
      return successResult('WORKSPACE_CREATED', { workspace: record });
    }
    if (sub === 'list') {
      const workspaces = listWorkspaces(cwd); workspaces.forEach(ws => console.log(`  ${ws.workspaceId} ${ws.status} task=${ws.taskId} branch=${ws.branch}`));
      return successResult('WORKSPACES_LISTED', { workspaces });
    }
    if (!ref) return failResult('INVALID_ARGUMENT', `workspace ${sub || '(空)'} 需要 workspaceId`, EXIT.USAGE);
    if (sub === 'inspect') { const workspace = loadWorkspace(cwd, ref); console.log(JSON.stringify(workspace, null, 2)); return successResult('WORKSPACE_INSPECTED', { workspace }); }
    if (sub === 'prepare') {
      const ws = loadWorkspace(cwd, ref); const commands = ws.setupCommands || [];
      let security = null;
      if (commands.length) security = prepareSecurity(cwd, commands, 'setup', true);
      const prepared = prepareWorkspaceRuntime(cwd, ref, {
        executeSetup(command, workspaceCwd) { return executeTrusted(workspaceCwd, command, security, {}, { automated: true, setup: true, isolatedWorkspace: true }); },
      });
      console.log(`RUNTIME: ${prepared.status} - ${ref} receipts=${prepared.receipts.length}`);
      return prepared.status === 'READY' || prepared.status === 'NOT_REQUIRED'
        ? successResult('WORKSPACE_RUNTIME_READY', prepared)
        : failResult('WORKSPACE_RUNTIME_FAILED', 'setup 命令未全部通过', EXIT.VALIDATION, prepared);
    }
    if (sub === 'candidate') {
      const ws = loadWorkspace(cwd, ref); const task = findTask(loadTasks(cwd), ws.taskId); const candidate = snapshotWorkspaceCandidate(cwd, ref, task);
      console.log(`CANDIDATE: SNAPSHOTTED - ${candidate.digest} commit=${candidate.headCommit} writes=${candidate.actualWrites.length}`);
      return successResult('CANDIDATE_SNAPSHOTTED', { candidate });
    }
    if (sub === 'release') {
      const released = releaseWorkspace(cwd, ref, { remove: args.includes('--remove') }); console.log(`WORKSPACE: RELEASED - ${ref} locks=${released.releasedLocks}`); return successResult('WORKSPACE_RELEASED', released);
    }
    console.log('用法：workspace create <taskId> [--base ref] [--resources port:3000,db:test] | list | inspect <id> | prepare <id> | candidate <id> | release <id> [--remove]');
    return failResult('INVALID_ARGUMENT', '未知 workspace 子命令', EXIT.USAGE);
  } catch (error) { return orchestrationFailure(error, 'WORKSPACE_ERROR'); }
}

function cmdIntegrate(cwd, args) {
  const [sub, ref] = args;
  try {
    if (sub === 'enqueue') {
      if (!ref) return failResult('INVALID_ARGUMENT', 'integrate enqueue 需要 candidate digest', EXIT.USAGE);
      const queued = enqueueCandidate(cwd, ref); console.log(`INTEGRATION: ${queued.duplicate ? 'DEDUPED' : 'QUEUED'} - ${queued.entry.entryId}`); return successResult(queued.duplicate ? 'INTEGRATION_DEDUPED' : 'INTEGRATION_QUEUED', queued);
    }
    if (sub === 'list') { const queue = listIntegrationQueue(cwd); queue.entries.forEach(e => console.log(`  ${e.entryId} ${e.status} task=${e.taskId}`)); return successResult('INTEGRATION_QUEUE_LISTED', { queue }); }
    if (sub === 'apply') {
      let integrationSecurity = null;
      const integrated = integrateNext(cwd, {
        entryId: ref || undefined,
        crashPoint: process.env.ROOTAGENT_TEST_MODE === '1' ? process.env.ROOTAGENT_TEST_CRASH_POINT : null,
        verifyImprovement(candidate, validationCwd) { verifyImprovementIntegration(cwd, candidate, validationCwd, improvementServices(cwd)); },
        authorizeValidation(candidate) { integrationSecurity = prepareSecurity(cwd, [...(candidate.setupCommands || []), ...(candidate.validationCommands || [])], 'integration', true); },
        executeSetup(command, validationCwd) { return executeTrusted(validationCwd, command, integrationSecurity, {}, { automated: true, setup: true, isolatedWorkspace: true }); },
        executeValidation(command, validationCwd) { return executeTrusted(validationCwd, command, integrationSecurity, {}, { automated: true, validation: true, isolatedWorkspace: true }); },
      }); console.log(`INTEGRATION: ${integrated.status} - ${integrated.entry.entryId}${integrated.receipt ? ` receipt=${integrated.receipt.digest}` : ''}`);
      return integrated.status === 'INTEGRATED' ? successResult('INTEGRATED', integrated) : failResult(integrated.status, integrated.entry.failure?.message || integrated.status, integrated.status === 'CONFLICT' ? EXIT.CONFLICT : EXIT.VALIDATION, integrated);
    }
    console.log('用法：integrate enqueue <candidateDigest> | list | apply [entryId]'); return failResult('INVALID_ARGUMENT', '未知 integrate 子命令', EXIT.USAGE);
  } catch (error) { return orchestrationFailure(error, 'INTEGRATION_ERROR'); }
}

function printProposalErrors(errors) { for (const error of errors || []) console.log(`  ✗ ${error.code}${error.taskId ? ` [${error.taskId}]` : ''}: ${error.message}`); }
function improvementServices(cwd) {
  const services = {
    engineRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    loadTasks,
    enqueue(project, digest, source) { return enqueueApprovedProposal(project, digest, { loadTasks, saveTasks, initializeTaskTrust, source }); },
    execute(command, directory, setup = false, limits = {}) {
      const security = prepareSecurity(cwd, [command], setup ? 'setup' : 'validation', false);
      return executeTrusted(directory, command, security, {}, { automated: true, validation: !setup, setup, isolatedWorkspace: directory !== cwd, ...limits });
    },
    invoke(command, args) {
      let returned;
      withProjectLock(cwd, () => { commandResult = null; returned = dispatchCommand(cwd, command, args); });
      if (returned?.then) throw Object.assign(new Error('Async authority command unsupported'), { code: 'IMPROVE_COMMAND_ASYNC' });
      if (commandResult?.ok === false) throw Object.assign(new Error(commandResult.reason), { code: commandResult.status, data: commandResult.data });
      return commandResult;
    },
  };
  services.driveTasks = session => driveImprovementTasks(cwd, session, services);
  return services;
}
function autoSealCompletedSelfImprovement(cwd, session) {
  if (session?.target !== 'self' || session.status !== 'COMPLETED') return null;
  const adopted = [...(session.decisions || [])].reverse().find(decision => decision.outcome === 'ADOPTED' && Array.isArray(decision.taskIds) && decision.taskIds.length);
  if (!adopted) return null;

  try {
    const existing = verifyAuditSeal(cwd, 'HEAD');
    if (adopted.taskIds.includes(existing.manifest?.taskId) && existing.manifest?.receiptDigest) {
      return { status: 'ALREADY_SEALED', ...existing };
    }
  } catch {
    // HEAD is normally still the Product Commit before the first automatic seal.
  }

  const data = loadTasks(cwd);
  const allTasks = [...(data.features || []), ...(data.archive || []).flatMap(round => round.features || [])];
  const productHead = execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim();
  const task = adopted.taskIds.map(taskId => allTasks.find(item => item.id === taskId)).find(item => item?.receipt?.digest && item?.candidate?.commit === productHead);
  if (!task) {
    const error = new Error('Completed self-improvement has no adopted task Receipt bound to current Product HEAD');
    error.code = 'IMPROVE_SELF_AUDIT_TASK_MISSING';
    throw error;
  }

  const sealed = createAuditSeal(cwd, {
    taskId: task.id,
    taskStatus: task.status,
    stateRevision: data.revision,
    attemptId: task.attempt?.attemptId || null,
    fencingToken: task.attempt?.fencingToken ?? null,
    candidateDigest: task.candidate?.digest || null,
    receiptDigest: task.receipt.digest,
  });
  const verified = verifyAuditSeal(cwd, sealed.auditCommit);
  if (verified.parentHead !== productHead || verified.receiptDigest !== task.receipt.digest) {
    const error = new Error('Automatic self-improvement Audit Seal verification mismatch');
    error.code = 'IMPROVE_SELF_AUDIT_VERIFY_FAILED';
    throw error;
  }
  return { status: 'SEALED', ...verified };
}

async function cmdImprove(cwd, args) {
  const [sub, id] = args;
  try {
    const services = improvementServices(cwd);
    if (args.includes('--chat') && args.includes('--bridge')) return failResult('INVALID_ARGUMENT', 'Choose --chat or --bridge', EXIT.USAGE);
    if (sub === 'drive') {
      if (args.includes('--chat')) enableChatHost(cwd);
      if (args.includes('--bridge')) {
        enableDoubaoBridge(cwd);
        const flag = path.join(cwd, '.rootagent', 'runtime', 'host-chat', 'enabled.json');
        if (fs.existsSync(flag)) fs.unlinkSync(flag);
      }
    }
    if (sub === 'start') {
      const levels = optionValue(args, '--levels');
      const s = startImprovement(cwd, { target: optionValue(args, '--target') || 'project', levels: levels ? levels.split(',').map(Number) : [1], continuous: args.includes('--continuous'), maxCycles: optionValue(args, '--max-cycles') ? Number(optionValue(args, '--max-cycles')) : undefined, maxElapsedMs: optionValue(args, '--max-elapsed-ms') ? Number(optionValue(args, '--max-elapsed-ms')) : undefined, writes: optionValue(args, '--writes')?.split(','), requirePhysicalIsolation: args.includes('--require-physical-isolation') }, services);
      console.log(`IMPROVE: ${s.sessionId} target=${s.target} levels=${s.levels.join(',')} stage=${s.stage}`);
      return successResult('IMPROVE_STARTED', { session: s, supervisorCli: s.supervisor?.cli || null });
    }
    if (sub === 'status') { const session = loadSession(cwd, id); console.log(`IMPROVE: ${id} ${session.status} stage=${session.stage} cycles=${session.cycles}/${session.maxCycles}${session.reason ? ' reason=' + session.reason : ''}`); return successResult('IMPROVE_STATUS', { session }); }
    if (sub === 'report') { const report = improvementReport(cwd, id); console.log(JSON.stringify(report, null, 2)); return successResult('IMPROVE_REPORT', report); }
    if (['pause', 'resume', 'stop'].includes(sub)) return successResult('IMPROVE_' + sub.toUpperCase(), { session: changeSession(cwd, id, sub, { maxElapsedMs: optionValue(args, '--max-elapsed-ms') ? Number(optionValue(args, '--max-elapsed-ms')) : undefined, maxCycles: optionValue(args, '--max-cycles') ? Number(optionValue(args, '--max-cycles')) : undefined }) });
    if (sub === 'verify') {
      const task = loadTasks(cwd).features.find(t => t.id === args[2]);
      const evaluation = verifyImprovementCandidate(cwd, id, task, services, optionValue(args, '--workspace') || cwd);
      return successResult('IMPROVE_VERIFIED', { evaluation });
    }
    if (sub === 'approve') {
      if (!args.includes('--human')) return failResult('IMPROVE_HUMAN_APPROVAL_REQUIRED', 'Explicit --human operator authorization required; Agent role outputs cannot approve', EXIT.POLICY);
      const session = loadSession(cwd, id); const digest = optionValue(args, '--candidate');
      const task = loadTasks(cwd).features.find(t => t.candidate?.digest === digest && t.improvementSource?.sessionId === id);
      if (!task) {
        const candidate = loadCandidate(cwd, digest);
        if (!session.current?.taskIds?.includes(candidate.taskId)) return failResult('IMPROVE_CANDIDATE_REQUIRED', 'Candidate not in this session', EXIT.POLICY);
      }
      const approval = grantImprovementApproval(cwd, id, digest, optionValue(args, '--issuer'));
      if (task?.requiresReview) { cmdReview(cwd, task.id, true); if (commandResult?.ok === false) return false; }
      return successResult('IMPROVE_HUMAN_APPROVED', { approval });
    }
    if (sub === 'drive') {
      const driven = await driveImprovement(cwd, id, services);
      if (driven.failure) return failResult(driven.failure.code, driven.failure.reason, EXIT.STATE, driven);
      const wait = driven.host || driven.development;
      if (wait?.code === 'IMPROVE_HUMAN_APPROVAL_REQUIRED') return successResult('IMPROVE_WAITING_APPROVAL', driven);
      if (wait?.ok === false && !String(wait.code || '').includes('WAITING')) return failResult(wait.code || 'IMPROVE_HOST_FAILED', wait.reason || 'Host failed', EXIT.STATE, driven);
      if (driven.session?.target === 'self' && (driven.session.status === 'COMPLETED' || driven.session.decisions?.some(d => d.outcome === 'ADOPTED'))) {
        try {
          const allTasks = [...(loadTasks(cwd).features || []), ...(loadTasks(cwd).archive || []).flatMap(round => round.features || [])];
          verifySelfImprovementEvidence(cwd, driven.session, allTasks);
          if (driven.session.status === 'COMPLETED') driven.audit = autoSealCompletedSelfImprovement(cwd, driven.session);
        } catch (error) {
          if (['IMPROVE_SELF_EVIDENCE_INCOMPLETE', 'IMPROVE_SELF_AUDIT_TASK_MISSING', 'IMPROVE_SELF_AUDIT_VERIFY_FAILED'].includes(error.code) || String(error.code || '').startsWith('AUDIT_')) {
            return failResult(error.code, error.message, EXIT.STATE, driven);
          }
          throw error;
        }
      }
      console.log(`IMPROVE: ${id} stage=${driven.session.stage} status=${wait?.code || wait?.status || driven.session.status}`);
      return successResult(wait?.code || wait?.status || 'IMPROVE_' + driven.session.status, driven);
    }
    return failResult('INVALID_ARGUMENT', 'improve start|status|drive|pause|resume|stop|report|verify|approve', EXIT.USAGE);
  } catch (error) { return orchestrationFailure(error, 'IMPROVE_ERROR'); }
}

function cmdProposal(cwd, args) {
  const [sub, ref] = args;
  try {
    if (sub === 'validate' || sub === 'submit') {
      if (!ref) return failResult('INVALID_ARGUMENT', `proposal ${sub} 需要 JSON 文件`, EXIT.USAGE);
      const input = parseJsonArgument(cwd, ref); const checked = sub === 'submit' ? submitPlannerProposal(cwd, input) : validatePlannerProposal(input);
      if (!checked.ok) { printProposalErrors(checked.errors); return failResult('PROPOSAL_INVALID', `${checked.errors.length} 个规划错误`, EXIT.VALIDATION, { errors: checked.errors }); }
      console.log(`PROPOSAL: ${sub === 'submit' ? 'SUBMITTED' : 'VALID'} - ${checked.digest}`); return successResult(sub === 'submit' ? 'PROPOSAL_SUBMITTED' : 'PROPOSAL_VALID', { digest: checked.digest, proposal: checked.proposal, path: checked.path });
    }
    if (sub === 'enqueue') {
      const enqueued = enqueueApprovedProposal(cwd, ref, { loadTasks, saveTasks, initializeTaskTrust });
      return successResult(enqueued.duplicate ? 'PROPOSAL_ENQUEUE_DEDUPED' : 'PROPOSAL_ENQUEUED', enqueued);
    }
    if (sub === 'approve') {
      const approval = approvePlannerProposal(cwd, ref, optionValue(args, '--issuer')); console.log(`PROPOSAL: APPROVED - ${ref} by=${approval.issuer}`); return successResult('PROPOSAL_APPROVED', { approval });
    }
    if (sub === 'materialize') {
      const materialized = materializePlannerProposal(cwd, ref); console.log(`PROPOSAL: MATERIALIZED - ${materialized.plan.digest}\n  只生成已批准计划，不直接改任务图：${materialized.path}`); return successResult('PROPOSAL_MATERIALIZED', materialized);
    }
    console.log('用法：proposal validate|submit <proposal.json> | approve <digest> --issuer <reviewer> | materialize <digest>'); return failResult('INVALID_ARGUMENT', '未知 proposal 子命令', EXIT.USAGE);
  } catch (error) { return orchestrationFailure(error, 'PROPOSAL_ERROR'); }
}

function cmdContext(cwd, args) {
  const [sub, role, taskId] = args;
  try {
    if (sub === 'verify') {
      const packet = parseJsonArgument(cwd, role); const checked = verifyContextPacket(packet); console.log(`CONTEXT: ${checked.ok ? 'VALID' : 'INVALID'}${checked.reason ? ` - ${checked.reason}` : ''}`); return checked.ok ? successResult('CONTEXT_VALID', checked) : failResult('CONTEXT_INVALID', checked.reason, EXIT.VALIDATION);
    }
    if (sub !== 'build' || !role) return failResult('INVALID_ARGUMENT', '用法：context build <role> [taskId] [--workspace id] [--candidate digest] | verify <packet.json>', EXIT.USAGE);
    const data = loadTasks(cwd); const task = taskId ? findTask(data, taskId) : getInProgress(data); if (taskId && !task) return failResult('TASK_NOT_FOUND', `任务不存在：${taskId}`, EXIT.STATE);
    const workspaceId = optionValue(args, '--workspace'); const candidateDigest = optionValue(args, '--candidate');
    const workspace = workspaceId ? loadWorkspace(cwd, workspaceId) : null;
    // P0 validate stores its Candidate directly on the task, while P2 workspace
    // candidates live in the orchestration candidate store.  ContextPacket is the
    // stable role boundary for both paths, so accept either identity without
    // weakening unknown-digest fail-closed behavior.
    const p0Candidate = candidateDigest && task?.candidate?.digest === candidateDigest
      ? { ...task.candidate, taskId: task.id, contractDigest: task.contractDigest, actualWrites: task.candidate.changedPaths || [] }
      : null;
    const candidate = candidateDigest ? (p0Candidate || loadCandidate(cwd, candidateDigest)) : null;
    const packet = buildContextPacket(cwd, role, { contract: task ? { id: task.id, name: task.name, description: task.description, acceptanceCriteria: task.acceptanceCriteria, validationCommands: task.validationCommands, setupCommands: task.setupCommands || [], writes: task.writes, resources: task.resources || [], contractDigest: task.contractDigest, requirementCoverage: task.requirementCoverage || null, outcomeContract: deriveOutcomeContract(task.acceptanceCriteria || [], { taskId: task.id, contractDigest: task.contractDigest }), repairFocus: task.repairFocus || null } : null, base: workspace ? { workspaceId, path: workspace.path, branch: workspace.branch, baseCommit: workspace.baseCommit, fencingToken: workspace.fencingToken, runtimeStatus: workspace.runtimeStatus } : task?.attempt || null, candidate, codeMap: candidate?.actualWrites || task?.writes || [], recentFailures: [...(task?.validationHistory?.slice(-2) || []), ...(task?.repairFocus ? [{ at: task.repairFocus.at, notes: 'RootAgent selected repair focus: ' + task.repairFocus.category + ' — ' + task.repairFocus.label, repairFocus: task.repairFocus }] : [])], lessons: recentKeepLessons(cwd), tools: optionValue(args, '--tools')?.split(',').filter(Boolean) || [], budget: loadBudget(cwd), traceContext: task ? createTraceContext(cwd, 'task', task.id) : null });
    console.log(`CONTEXT: BUILT - role=${role} digest=${packet.digest}`); return successResult('CONTEXT_BUILT', { packet });
  } catch (error) { return orchestrationFailure(error, 'CONTEXT_ERROR'); }
}

function cmdAdapter(cwd, args) {
  const [sub, ref, operation] = args;
  try {
    if (sub === 'validate' || sub === 'install') {
      const input = parseJsonArgument(cwd, ref); const checked = sub === 'install' ? installAdapter(cwd, input) : validateAdapterManifest(input);
      if (!checked.ok) { checked.errors.forEach(e => console.log(`  ✗ ${e}`)); return failResult('ADAPTER_INVALID', checked.errors.join('；'), EXIT.VALIDATION, { errors: checked.errors }); }
      console.log(`ADAPTER: ${sub === 'install' ? 'INSTALLED' : 'VALID'} - ${checked.manifest.adapterId} digest=${checked.digest}`); return successResult(sub === 'install' ? 'ADAPTER_INSTALLED' : 'ADAPTER_VALID', { adapter: checked.manifest });
    }
    if (sub === 'list') { const adapters = listAdapters(cwd); adapters.forEach(a => console.log(`  ${a.adapterId} ${a.transport.type} ${a.digest}`)); return successResult('ADAPTERS_LISTED', { adapters }); }
    if (sub === 'request') {
      const payload = optionValue(args, '--payload'); const request = requestAdapterOperation(cwd, ref, operation, payload ? parseJsonArgument(cwd, payload) : {}, optionValue(args, '--context') || null, optionValue(args, '--key') || null);
      console.log(`ADAPTER: ${request.status} - ${request.requestId}`); return request.status === 'FAILED' ? failResult('ADAPTER_FAILED', request.response?.reason || 'adapter failed', EXIT.STATE, { request }) : successResult(request.status === 'COMPLETED' ? 'ADAPTER_COMPLETED' : 'ADAPTER_REQUESTED', { request });
    }
    if (sub === 'respond') { const value = optionValue(args, '--value'); const response = respondAdapterOperation(cwd, ref, value ? parseJsonArgument(cwd, value) : { ok: true }); console.log(`ADAPTER: ${response.status} - ${ref}`); return successResult('ADAPTER_RESPONDED', { request: response }); }
    if (sub === 'inspect') { const request = inspectAdapterRequest(cwd, ref); console.log(JSON.stringify(request, null, 2)); return successResult('ADAPTER_REQUEST_INSPECTED', { request }); }
    console.log('用法：adapter validate|install <manifest.json> | list | request <id> <start|status|send|wait|cancel|resume> [--payload JSON] [--context digest] [--key idempotencyKey] | respond <requestId> --value JSON | inspect <requestId>'); return failResult('INVALID_ARGUMENT', '未知 adapter 子命令', EXIT.USAGE);
  } catch (error) { return orchestrationFailure(error, 'ADAPTER_ERROR'); }
}

// ── P3：外部信任、真实沙箱、受信 Verifier 与类型化证据 ────
function parseCommandOption(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return value;
  try {
    const parsed = JSON.parse(trimmed);
    return isCommandSpec(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function currentSecurityCommands(cwd, args = []) {
  const explicit = optionValue(args, '--command');
  if (explicit) {
    const parsed = parseCommandOption(explicit);
    return isCommandSpec(parsed)
      ? [{ ...parsed, level: Number(optionValue(args, '--level') || parsed.level || 1), ladder: parsed.ladder || 'V' }]
      : [{ cmd: explicit, level: Number(optionValue(args, '--level') || 1), ladder: 'V' }];
  }
  const data = loadTasks(cwd); const task = getInProgress(data);
  if (task) return taskSecurityCommands(cwd, task);
  const def = data.goalDefinition || {};
  return [...(def.probes || []), ...(def.invariants || [])].map(item => ({ cmd: item.cmd, level: 1, ladder: 'V' }));
}
function cmdSecurity(cwd, args) {
  const [sub] = args;
  try {
    if (sub === 'init') {
      const writes = optionValue(args, '--write');
      const created = initSecurity(cwd, { sandboxMode: optionValue(args, '--sandbox') || undefined, network: optionValue(args, '--network') || undefined, writePaths: writes ? writes.split(',').filter(Boolean) : undefined });
      console.log(`SECURITY: INITIALIZED - sandbox=${created.policy.sandbox.mode} network=${created.policy.sandbox.network}`);
      return successResult('SECURITY_INITIALIZED', created);
    }
    if (sub === 'show' || sub === 'doctor') {
      const policy = loadSecurityPolicy(cwd); const sandbox = detectSandboxBackend(); const trust = inspectProjectTrust(cwd);
      if (!policy) return failResult('SECURITY_NOT_INITIALIZED', '尚未执行 security init', EXIT.STATE, { sandbox });
      console.log(JSON.stringify({ policy, sandbox, approvals: trust.approvals }, null, 2));
      if (sub === 'doctor' && policy.sandbox.mode === 'required' && !sandbox.available) return failResult('SANDBOX_UNAVAILABLE', '策略要求 OS 沙箱，但当前不可用', EXIT.POLICY, { sandbox });
      return successResult('SECURITY_INSPECTED', { policy, sandbox, trust });
    }
    if (sub === 'exec') {
      const rawCommand = optionValue(args, '--command'); if (!rawCommand) return failResult('INVALID_ARGUMENT', 'security exec 需要 --command', EXIT.USAGE);
      const command = parseCommandOption(rawCommand);
      const commands = isCommandSpec(command)
        ? [{ ...command, level: Number(optionValue(args, '--level') || command.level || 1), ladder: command.ladder || 'V' }]
        : [{ cmd: rawCommand, level: Number(optionValue(args, '--level') || 1), ladder: 'V' }];
      const security = prepareSecurity(cwd, commands, 'workflow', true); const executed = executeTrusted(cwd, command, security);
      if (executed.out) process.stdout.write(executed.out);
      return executed.ok ? successResult('SECURE_EXECUTED', { receipt: executed.receipt }) : failResult('SECURE_EXECUTION_FAILED', `exit=${executed.code}`, EXIT.VALIDATION, { receipt: executed.receipt });
    }
    return failResult('INVALID_ARGUMENT', '用法：security init|show|doctor|exec --command <cmd>', EXIT.USAGE);
  } catch (error) { return securityFailure(error); }
}
function cmdTrust(cwd, args) {
  const [sub] = args;
  try {
    if (sub === 'grant') {
      const issuer = optionValue(args, '--issuer'); const scopes = (optionValue(args, '--scopes') || 'validation,hooks,workflow,setup,integration').split(',').filter(Boolean);
      const granted = grantProjectTrust(cwd, issuer, currentSecurityCommands(cwd, args), scopes);
      console.log(`TRUST: GRANTED - ${granted.approval.approvalId} digest=${granted.approval.configDigest}`); return successResult('TRUST_GRANTED', granted);
    }
    if (sub === 'inspect') { const trust = inspectProjectTrust(cwd); console.log(JSON.stringify(trust, null, 2)); return successResult('TRUST_INSPECTED', { trust }); }
    if (sub === 'revoke') { const revoked = revokeProjectTrust(cwd); console.log(`TRUST: ${revoked ? 'REVOKED' : 'ABSENT'}`); return successResult(revoked ? 'TRUST_REVOKED' : 'TRUST_ABSENT'); }
    return failResult('INVALID_ARGUMENT', '用法：trust grant --issuer <human> [--scopes ...] [--command cmd] | inspect | revoke', EXIT.USAGE);
  } catch (error) { return securityFailure(error); }
}
function cmdVerifier(cwd, args) {
  const [sub, verifierPath] = args;
  try {
    if (sub === 'lock') {
      if (!verifierPath) return failResult('INVALID_ARGUMENT', 'verifier lock 需要项目内文件路径', EXIT.USAGE);
      const command = optionValue(args, '--negative'); const exitRaw = optionValue(args, '--negative-exit'); const evidenceMarker = optionValue(args, '--negative-evidence');
      const expectedExitCode = Number(exitRaw);
      if (!command || !Number.isInteger(expectedExitCode) || expectedExitCode <= 0 || [70, 124, 126, 127].includes(expectedExitCode) || !evidenceMarker) return failResult('INVALID_ARGUMENT', 'verifier lock 必须提供 --negative <cmd> --negative-exit <非 70/124/126/127 的正整数> --negative-evidence <marker>', EXIT.USAGE);
      const locked = lockTrustedVerifier(cwd, verifierPath, { command, expectedExitCode, evidenceMarker });
      console.log(`VERIFIER: LOCKED - ${locked.path} digest=${locked.digest}`); return successResult('VERIFIER_LOCKED', locked);
    }
    if (sub === 'check') { const checked = checkTrustedVerifiers(cwd, currentSecurityCommands(cwd, args)); console.log('VERIFIER: PASS'); return successResult('VERIFIER_CHECKED', checked); }
    return failResult('INVALID_ARGUMENT', '用法：verifier lock <path> --negative <cmd> --negative-exit <N> --negative-evidence <marker> | check [--command cmd --level N]', EXIT.USAGE);
  } catch (error) { return securityFailure(error); }
}
function cmdEvidence(cwd, args) {
  const [sub, ref] = args;
  try {
    const data = loadTasks(cwd); const task = findTask(data, optionValue(args, '--task') || '') || getInProgress(data);
    if (sub === 'list') { const values = listTypedEvidence(cwd, ref || task?.id || ''); console.log(JSON.stringify(values, null, 2)); return successResult('EVIDENCE_LISTED', { evidence: values }); }
    if (sub === 'add') {
      if (!ref || !task?.candidate) return failResult('INVALID_ARGUMENT', 'evidence add 需要 JSON 文件及已验证 candidate', EXIT.USAGE);
      const value = JSON.parse(fs.readFileSync(path.resolve(cwd, ref), 'utf-8')); value.taskId = task.id; value.candidateDigest = task.candidate.digest;
      const stored = storeTypedEvidence(cwd, value); if (!stored.ok) return failResult('EVIDENCE_INVALID', stored.errors.join('；'), EXIT.VALIDATION, { errors: stored.errors });
      console.log(`EVIDENCE: STORED - ${stored.evidence.type} ${stored.evidence.digest}`); return successResult('EVIDENCE_STORED', stored);
    }
    return failResult('INVALID_ARGUMENT', '用法：evidence add <json> [--task tNNN] | list [taskId]', EXIT.USAGE);
  } catch (error) { return securityFailure(error, 'EVIDENCE_ERROR'); }
}
function cmdChecker(cwd, args) {
  const [sub, ref] = args;
  try {
    if (sub !== 'calibrate' || !ref) return failResult('INVALID_ARGUMENT', '用法：checker calibrate <dataset.json> --issuer <id>', EXIT.USAGE);
    const dataset = JSON.parse(fs.readFileSync(path.resolve(cwd, ref), 'utf-8')); const calibrated = calibrateChecker(cwd, optionValue(args, '--issuer'), dataset);
    console.log(`CHECKER: CALIBRATED - ${calibrated.report.verdict} FAR=${calibrated.report.falseAcceptRate} FRR=${calibrated.report.falseRejectRate}`);
    return calibrated.report.verdict === 'PASS' ? successResult('CHECKER_CALIBRATED', calibrated) : failResult('CHECKER_CALIBRATION_FAILED', 'Checker 校准未达阈值', EXIT.VALIDATION, calibrated);
  } catch (error) { return securityFailure(error, 'CHECKER_ERROR'); }
}
function cmdTrace(cwd, args) {
  const [sub, ref] = args;
  try {
    if (sub === 'list') {
      const traces = listExplainableTraces(cwd); traces.forEach(item => console.log(`  ${item.kind}:${item.id} ${item.status}${item.updatedAt ? ` ${item.updatedAt}` : ''}`));
      return successResult('TRACES_LISTED', { traces });
    }
    if (!ref) return failResult('INVALID_ARGUMENT', '用法：trace show|explain|verify <runId|taskId|integrationId> | list', EXIT.USAGE);
    const trace = buildExplainableTrace(cwd, ref); const checked = verifyExplainableTrace(trace);
    if (!checked.ok) return failResult('TRACE_INVALID', checked.errors.join('；'), EXIT.VALIDATION, { errors: checked.errors });
    if (sub === 'show') { console.log(JSON.stringify(trace, null, 2)); return successResult('TRACE_SHOWN', { trace }); }
    if (sub === 'explain') {
      console.log(`TRACE: ${trace.status} - ${trace.subject.kind}:${trace.subject.id}`);
      console.log(`  为什么停：${trace.whyStopped.code} - ${trace.whyStopped.message}`);
      console.log(`  谁参与：${trace.actors.join(', ') || '无可验证身份记录'}`);
      console.log(`  改了什么：${trace.changed.join(', ') || '无路径级变更记录'}`);
      console.log(`  未验证：${trace.untested.length ? trace.untested.map(item => `#${item.index ?? '?'} ${item.criterion || item.path}`).join('；') : '无'}`);
      console.log(`  成本：${JSON.stringify(trace.cost)}`);
      console.log(`  证据：${trace.evidence.map(item => `${item.type}:${item.digest}`).join(', ')}`);
      return successResult('TRACE_EXPLAINED', { traceId: trace.traceId, traceparent: trace.traceparent, status: trace.status, whyStopped: trace.whyStopped, actors: trace.actors, changed: trace.changed, changeAttribution: trace.changeAttribution || [], untested: trace.untested, cost: trace.cost, evidence: trace.evidence, spans: trace.spans.length, digest: trace.digest });
    }
    if (sub === 'verify') { console.log(`TRACE: VALID - ${trace.traceId} spans=${trace.spans.length} digest=${trace.digest}`); return successResult('TRACE_VALID', { traceId: trace.traceId, spans: trace.spans.length, digest: trace.digest }); }
    return failResult('INVALID_ARGUMENT', '用法：trace show|explain|verify <ref> | list', EXIT.USAGE);
  } catch (error) {
    console.log(`✗ ${error.message}`); return failResult(['ROOTAGENT_RUN_HISTORY_CORRUPT', 'ROOTAGENT_TRACE_SOURCE_CORRUPT'].includes(error.code) ? 'TRACE_SOURCE_CORRUPT' : 'TRACE_ERROR', error.message, EXIT.STATE);
  }
}

function cmdAudit(cwd, args) {
  const [sub, ref] = args;
  try {
    if (sub === 'seal') {
      if (!ref) return failResult('INVALID_ARGUMENT', 'audit seal 需要 taskId', EXIT.USAGE);
      const data = loadTasks(cwd);
      const task = findTask(data, ref);
      if (!task) return failResult('TASK_NOT_FOUND', `任务不存在：${ref}`, EXIT.STATE);
      if (!(task.status === 'completed' || task.status === 'blocked' || task.blocked)) {
        return failResult('AUDIT_TASK_NOT_SEALABLE', `任务 ${task.id} 状态为 ${task.status}，仅 completed/blocked 可封印`, EXIT.STATE);
      }
      const sealed = createAuditSeal(cwd, {
        taskId: task.id,
        taskStatus: task.status,
        stateRevision: data.revision,
        attemptId: task.attempt?.attemptId || null,
        fencingToken: task.attempt?.fencingToken ?? null,
        candidateDigest: task.candidate?.digest || null,
        receiptDigest: task.receipt?.digest || null,
      });
      console.log(`AUDIT: SEALED - task=${task.id} commit=${sealed.auditCommit} parent=${sealed.parentHead}`);
      return successResult('AUDIT_SEALED', sealed);
    }
    if (sub === 'verify') {
      const verified = verifyAuditSeal(cwd, ref || 'HEAD');
      console.log(`AUDIT: VERIFIED - commit=${verified.auditCommit} parent=${verified.parentHead} portability=${verified.portability.status}`);
      return successResult('AUDIT_VERIFIED', verified);
    }
    return failResult('INVALID_ARGUMENT', '用法：audit seal <taskId> | audit verify [commit]', EXIT.USAGE);
  } catch (error) {
    const stateCodes = new Set(['AUDIT_NOTHING_TO_SEAL', 'AUDIT_GIT_REQUIRED', 'AUDIT_COMMIT_NOT_FOUND', 'AUDIT_PARENT_MISSING']);
    console.log(`✗ ${error.message}`);
    return failResult(error.code || 'AUDIT_ERROR', error.message, stateCodes.has(error.code) ? EXIT.STATE : EXIT.CONFLICT, error.data || {});
  }
}

// ── 入口 ──────────────────────────────────────────────────
const usage = () => console.log(`用法（项目根目录运行）：
  管理   init "<目标>" | status | snapshot | progress | ledger | report [--save <path>]
  任务   add "<任务名>" | next | start | validate | attest checker ... | pass/accept | fail "<原因>" | clear <id>
  规划   plan [--apply]
  目标   goal "<目标>" [--count N] [--probe <cmd>] [--invariant <cmd>] | goal check
  探针   probe（真实运行产品可玩性、输入控制响应与非阻塞体验深度体检）
  品类   archetype "<诉求描述>"（获取品类技术基线与体验契约）
  预算   budget [<key> <value>]
  依赖   graph | add "<名>" --depends t001,t002
  并行   start --parallel t002,t003 [--isolation auto|lightweight|worktree] | join <父id> | add --writes/--parent
  教训   lesson add "<教训>" [--evidence <证据>] | keep|discard <id> | list [--keep]
  观测   cost | trend
  策略   policy [deny/approve/envRestricted <值>] | validate --dry-run（只报不跑）
  hooks  hooks [<stage> <cmd1;cmd2> | clear <stage>]（before_validate/after_validate/before_pass/on_blocked）
  自举   selftest [--deep] [--workers N]（默认最多 4 worker；--deep 包含递归 dogfood）
  分解   decompose "<父任务名>" [--count N]（契约均分入队，join 自动归档）
  调度   cron add "<分 时 日 月 周>" <workflowId> | cron run | cron list | cron remove <id>
  双模型 config checkerModel <模型名>（Checker 用独立模型，不让同一 agent 自批）
  检查   review <id> [--approve]（[审批] 门 + [证据] 附件）
  恢复   doctor | resume
  工作流 workflow validate|install|show <definition.json|workflowId>
  运行图 run create <workflow> | step <runId> [--once] | inspect|pause|resume|cancel <runId>
  触发器 trigger emit <workflow> --fire-key <key> [--payload JSON|file] | trigger list
  编排   workspace create|list|inspect|candidate|release | integrate enqueue|list|apply
  优化   improve start|status|drive|pause|resume|stop|report|verify|approve
  规划   proposal validate|submit|approve|materialize|enqueue
  角色   context build|verify | adapter validate|install|list|request|respond|inspect
  Host   host drive <runId> [--chat] | host chat pending|inspect|respond | host reconcile run <runId> [taskId] | host capabilities attest [taskId] --record <json> | host attest <role> [taskId] --record <json> | host verify [taskId]
  安全   security init|show|doctor|exec | trust grant|inspect|revoke | verifier lock|check
  证据   evidence add|list | checker calibrate（attest checker --report <json>）
  Trace  trace list | show|explain|verify <runId|taskId|integrationId>
  审计   audit seal <taskId> | audit verify [commit]
  项目   project <名> <路径> | project list
  全部命令支持 --project <名> 切换项目、--json 输出稳定结构化 Result`);

// isMain：直接运行判定（import 时只导出纯函数）。用 realpath 规范化 argv[1]——
// macOS /var/folders、/tmp 及安装软链都是符号链接，不 realpath 会导致 main 静默不执行
const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

function dispatchCommand(cwd, cmd, args) {
  switch (cmd) {
    case 'init': return cmdInit(cwd, args[0] || '');
    case 'add': return cmdAdd(cwd, args[0] || '未命名任务', args.slice(1));
    case 'next': return cmdNext(cwd);
    case 'start': return cmdStart(cwd, args);
    case 'validate': {
      const rest = args.filter(a => a !== '--dry-run');
      const taskId = rest.find(a => /^t\d+$/i.test(a)) || '';
      return cmdValidate(cwd, taskId, args.includes('--dry-run'), leaseFromArgs(args));
    }
    case 'attest': return cmdAttest(cwd, args);
    case 'pass':
    case 'accept': return cmdPass(cwd, args.find(a => /^t\d+$/i.test(a)) || '', leaseFromArgs(args));
    case 'policy': return cmdPolicy(cwd, args);
    case 'hooks': return cmdHooks(cwd, args);
    case 'selftest': return cmdSelftest(cwd, args)
      ? successResult('SELFTEST_PASSED')
      : failResult('SELFTEST_FAILED', '一个或多个测试套件失败', EXIT.VALIDATION);
    case 'decompose': return cmdDecompose(cwd, args[0] || '未命名任务', args.includes('--count') ? args[args.indexOf('--count') + 1] : 5);
    case 'config': return cmdConfig(cwd, args);
    case 'cron': return cmdCron(cwd, args);
    case 'fail': {
      const idArg = args.find(a => /^t\d+$/i.test(a)) || '';
      const reasonParts = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === idArg) continue;
        if (args[i] === '--attempt' || args[i] === '--fence') { i++; continue; }
        reasonParts.push(args[i]);
      }
      return cmdFail(cwd, idArg, reasonParts.join(' ') || '未说明原因', leaseFromArgs(args));
    }
    case 'clear': return cmdClear(cwd, args[0] || '');
    case 'join': return cmdJoin(cwd, args[0] || '');
    case 'lesson': return cmdLesson(cwd, args);
    case 'cost': return cmdCost(cwd);
    case 'trend': return cmdTrend(cwd);
    case 'review': return cmdReview(cwd, args[0] || '', args.includes('--approve'));
    case 'status': return cmdStatus(cwd);
    case 'snapshot': return cmdSnapshot(cwd);
    case 'progress': return cmdProgress(cwd);
    case 'ledger': return cmdLedger(cwd);
    case 'report': return cmdReport(cwd, args.includes('--save') ? args[args.indexOf('--save') + 1] : null);
    case 'plan': return cmdPlan(cwd, args.includes('--apply'));
    case 'goal': return cmdGoal(cwd, args);
    case 'verify': return cmdVerify(cwd, args);
    case 'budget': return cmdBudget(cwd, args);
    case 'graph': return cmdGraph(cwd);
    case 'doctor': return cmdDoctor(cwd);
    case 'resume': return cmdResume(cwd, args.includes('--force'));
    case 'workflow': return cmdWorkflow(cwd, args);
    case 'run': return cmdRun(cwd, args);
    case 'trigger': return cmdTrigger(cwd, args);
    case 'workspace': return cmdWorkspace(cwd, args);
    case 'integrate': return cmdIntegrate(cwd, args);
    case 'proposal': return cmdProposal(cwd, args);
    case 'improve': return cmdImprove(cwd, args);
    case 'context': return cmdContext(cwd, args);
    case 'adapter': return cmdAdapter(cwd, args);
    case 'host': return cmdHost(cwd, args);
    case 'security': return cmdSecurity(cwd, args);
    case 'trust': return cmdTrust(cwd, args);
    case 'verifier': return cmdVerifier(cwd, args);
    case 'evidence': return cmdEvidence(cwd, args);
    case 'checker': return cmdChecker(cwd, args);
    case 'trace': return cmdTrace(cwd, args);
    case 'audit': return cmdAudit(cwd, args);
    case 'probe': {
      const probeRes = runPlayabilityProbe(cwd);
      console.log(formatProbeReport(probeRes));
      return probeRes.ok
        ? successResult('PROBE_PASSED', probeRes)
        : failResult('PROBE_FAILED', probeRes.summary, EXIT.VALIDATION, probeRes);
    }
    case 'archetype': {
      const q = args.join(' ');
      const matched = detectArchetypes(q);
      console.log(`\n🎯 RootAgent 品类雷达推荐基线 (Query: "${q}"):`);
      matched.forEach(m => {
        console.log(`\n📌 [品类画像] ${m.name}`);
        if (m.baselineStack?.length) {
          console.log(`  强制技术基线 (Baseline Stack):`);
          m.baselineStack.forEach(b => console.log(`    • ${b}`));
        }
        if (m.antiLazyRules?.length) {
          console.log(`  严禁偷懒路径 (Anti-Lazy Constraints):`);
          m.antiLazyRules.forEach(r => console.log(`    ✕ ${r}`));
        }
      });
      console.log('\n' + generateExperienceContract(q));
      return successResult('ARCHETYPE_RESOLVED', { archetypes: matched });
    }
    case 'project': return cmdProject(args);
    default:
      usage();
      return failResult('USAGE', cmd ? `未知命令：${cmd}` : '缺少命令', EXIT.USAGE);
  }
}

function mutatesState(cmd, args) {
  if (['init', 'add', 'start', 'validate', 'attest', 'pass', 'accept', 'fail', 'clear', 'join', 'decompose', 'resume'].includes(cmd)) return true;
  if (cmd === 'budget' || cmd === 'policy' || cmd === 'hooks' || cmd === 'config' || cmd === 'lesson') return args.length > 0 && !args.includes('list');
  if (cmd === 'goal') return args[0] !== 'check';
  if (cmd === 'review') return args.includes('--approve');
  if (cmd === 'plan') return args.includes('--apply') || args.length === 0;
  if (cmd === 'report') return args.includes('--save');
  if (cmd === 'cron') return ['add', 'remove', 'run'].includes(args[0]);
  if (cmd === 'project') return args[0] !== 'list';
  if (cmd === 'workflow') return args[0] === 'install';
  if (cmd === 'run') return args[0] === 'create';
  if (cmd === 'trigger') return ['emit', 'list'].includes(args[0]);
  if (cmd === 'workspace') return ['create', 'prepare', 'candidate', 'release'].includes(args[0]);
  if (cmd === 'integrate') return ['enqueue', 'apply'].includes(args[0]);
  if (cmd === 'proposal') return ['submit', 'approve', 'materialize', 'enqueue'].includes(args[0]);
  if (cmd === 'improve') return !['drive', 'status', 'report'].includes(args[0]);
  if (cmd === 'context') return args[0] === 'build';
  if (cmd === 'adapter') return ['install', 'request', 'respond'].includes(args[0]);
  if (cmd === 'host') return args[0] === 'attest' || (args[0] === 'capabilities' && args[1] === 'attest') || (args[0] === 'reconcile' && args[1] === 'run') || (args[0] === 'chat' && args[1] === 'respond');
  if (cmd === 'security') return ['init', 'exec'].includes(args[0]);
  if (cmd === 'trust') return ['grant', 'revoke'].includes(args[0]);
  if (cmd === 'verifier') return args[0] === 'lock';
  if (cmd === 'evidence') return args[0] === 'add';
  if (cmd === 'checker') return args[0] === 'calibrate';
  if (cmd === 'audit') return args[0] === 'seal';
  if (cmd === 'doctor') return true;
  return false;
}

if (isMain) {
  // 注册 Agent Host runtime provider：宿主桥（external worker / native subagent 宿主）可用时，
  // driveAgentHostRun 会自动解析到 NATIVE_MULTI_AGENT 并用 SubAgent 执行角色。
  try { registerDoubaoBridgeProvider(); } catch { /* 重复注册等场景不影响 CLI 其他命令 */ }
  // cooperative chat transport：普通聊天宿主无法创建 SubAgent 时，经 host chat pending|inspect|respond
  // 在同一个 Durable Run 上接力执行；只有 host chat 显式启用（enabled.json 存在）才会匹配。
  try { registerChatHostProvider(); } catch { /* 同上：未启用或重复注册都不影响其他命令 */ }
  (async () => {
  const parsed = parseArgs(process.argv.slice(2));
  const [cmd, ...args] = parsed.rest;
  const captured = [];
  const originalLog = console.log;
  const originalError = console.error;
  if (parsed.json) {
    console.log = (...items) => captured.push(items.map(String).join(' '));
    console.error = (...items) => captured.push(items.map(String).join(' '));
  }
  let cwd = process.cwd();
  commandResult = null;
  try {
    if (parsed.project) {
      const map = loadProjects();
      if (!map[parsed.project]) {
        console.error(`未注册项目：${parsed.project}（用 rootagent project <名> <路径> 注册）`);
        failResult('PROJECT_NOT_FOUND', `未注册项目：${parsed.project}`, EXIT.STATE);
      } else cwd = map[parsed.project];
    }
    if (!commandResult) {
      // A self session is controlled by the accepted frozen engine, including
      // task acceptance commands. The candidate cannot replace its own judge.
      const sessionsDir = path.join(cwd, '.rootagent', 'improvement', 'sessions');
      const activeSelf = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).filter(name => name.endsWith('.json')).flatMap(name => {
        try { return [loadSession(cwd, name.slice(0, -5))]; }
        catch (error) {
          // Audit history is intentionally committed, so a checkout can contain sealed
          // sessions created at a different absolute path. Those sessions cannot govern
          // this checkout; skip only this explicit target mismatch and keep every other
          // corruption/supervisor error fail-closed.
          if (error?.code === 'IMPROVE_TARGET_MISMATCH') return [];
          throw error;
        }
      }).find(s => s.supervisor && !['COMPLETED', 'NO_OPPORTUNITY', 'NO_BENEFIT'].includes(s.status)) : null;
      if (activeSelf && !(cmd === 'improve' && args[0] === 'start')) {
        verifySupervisor(activeSelf.supervisor);
        if (realpathSync(fileURLToPath(import.meta.url)) !== realpathSync(activeSelf.supervisor.cli)) {
          const delegated = spawnSync(process.execPath, [activeSelf.supervisor.cli, ...parsed.rest, '--json'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
          if (delegated.error) throw delegated.error;
          try { commandResult = JSON.parse(delegated.stdout.trim()); }
          catch { throw Object.assign(new Error('Pinned supervisor did not return a valid Result: ' + delegated.stderr), { code: 'IMPROVE_SUPERVISOR_FAILED' }); }
          if (!parsed.json) console.log(commandResult.output || JSON.stringify(commandResult.data));
        }
      }
    }
    if (!commandResult) {
      const invoke = () => dispatchCommand(cwd, cmd, args);
      const pendingRecovery = fs.existsSync(path.join(cwd, '.rootagent', 'runtime', 'transaction.json'));
      const needsLock = mutatesState(cmd, args) || pendingRecovery;
      const lockRoot = cmd === 'project' ? HOME : cwd;
      let returned;
      if (needsLock) {
        // 现有同步锁语义；host drive 不进 mutatesState（其 run 状态机由
        // executeRunStep / resumeRun 内部短锁保护），避免双重加锁
        returned = withProjectLock(lockRoot, invoke);
      } else {
        returned = invoke();
      }
      if (returned && typeof returned.then === 'function') {
        // 异步命令（host drive）：内部通过 failResult/successResult 设置 commandResult，
        // 返回值仅作同步兼容（failResult 返回 false），避免覆盖已设置的结果。
        const value = await returned;
        if (!commandResult && value === false) failResult('FAILED', `${cmd || 'command'} 失败`, EXIT.STATE);
        else if (!commandResult && value && typeof value === 'object') commandResult = value;
        else if (!commandResult) successResult('OK');
      } else {
        if (!commandResult && returned === false) failResult('FAILED', `${cmd || 'command'} 失败`, EXIT.STATE);
        if (!commandResult) successResult('OK');
      }
    }
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      console.error(`✗ ${error.message}`);
      failResult('LOCK_TIMEOUT', error.message, EXIT.CONFLICT, { owner: error.owner });
    } else if (error?.code === 'ROOTAGENT_REVISION_CONFLICT') {
      console.error(`✗ ${error.message}`);
      failResult('REVISION_CONFLICT', error.message, EXIT.CONFLICT, { expected: error.expectedRevision, actual: error.actualRevision });
    } else {
      console.error(`ROOTAGENT INTERNAL ERROR: ${error?.stack || error}`);
      failResult('INTERNAL_ERROR', error?.message || String(error), EXIT.INTERNAL);
    }
  } finally {
    if (parsed.json) {
      console.log = originalLog;
      console.error = originalError;
      const payload = { ...commandResult, output: captured.join('\n') };
      process.stdout.write(JSON.stringify(payload) + '\n');
    }
    process.exitCode = commandResult?.code ?? EXIT.INTERNAL;
  }
  })();
} // end isMain

export { cronMatch, cronFieldMatch };
