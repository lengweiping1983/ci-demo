/**
 * RootAgent 无头浏览器运行时探针 (Headless Browser Runtime & ESM Integrity Probe)
 * 
 * 作用：
 * 1. 深度扫描前端模块依赖树（ESM Import Integrity），静态检测悬空相对引用与 404 缺失模块
 * 2. 调度真实 Headless Chrome/Chromium 通过 CDP (Chrome DevTools Protocol) 启动微型沙箱
 * 3. 实时捕获真实浏览器的未捕获 JavaScript 异常、致命 Console Error、模块加载失败与 404 资源缺失
 * 彻底消除“正则匹配全绿但浏览器控制台 404 死锁崩溃”的虚假繁荣。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { GAME_PLAYTEST_SCENARIO, selectHeadlessPlaytestAction } from './game-playtest-decision.mjs';

const __filename = fileURLToPath(import.meta.url);

async function acquireHeadlessChromeLock(options = {}) {
  const lockPath = path.join(os.tmpdir(), 'rootagent-headless-chrome.lock');
  const timeoutMs = Number(options.timeoutMs || 45000);
  const staleMs = Number(options.staleMs || 90000);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      return () => {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(lockPath); } catch {}
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  }
  throw new Error('Headless Chrome probe lock timeout');
}


function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function observePlaytestState(sendCdp) {
  const expression = `(() => {
    try {
      const canvas = document.querySelector('canvas');
      const hook = globalThis.__ROOTAGENT_PLAYTEST__;
      let custom = null;
      if (hook && typeof hook.observe === 'function') {
        try { custom = hook.observe(); } catch (error) { custom = { observeError: String(error?.message || error) }; }
      }
      return JSON.stringify({
        title: document.title || '',
        readyState: document.readyState,
        hasCanvas: !!canvas,
        canvasWidth: canvas?.width || null,
        canvasHeight: canvas?.height || null,
        activeElement: document.activeElement?.tagName || null,
        custom,
      });
    } catch (error) {
      return JSON.stringify({ observeError: String(error?.message || error) });
    }
  })()`;
  const evaluated = await sendCdp('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
  });
  const value = evaluated?.result?.value;
  try { return JSON.parse(value || '{}'); } catch { return { raw: value || null }; }
}

function keyParams(action) {
  return {
    key: action.key,
    code: action.code,
    windowsVirtualKeyCode: action.keyCode,
    nativeVirtualKeyCode: action.keyCode,
  };
}

async function dispatchPlaytestAction(sendCdp, action) {
  if (!action?.key) {
    await new Promise(resolve => setTimeout(resolve, action?.holdMs || 120));
    return;
  }
  const params = keyParams(action);
  await sendCdp('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
  await new Promise(resolve => setTimeout(resolve, action.holdMs || 80));
  await sendCdp('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}

function feelState(observed) {
  const feel = observed?.custom?.feel;
  if (!feel || typeof feel !== 'object') return null;
  const player = feel.playerPosition;
  const camera = feel.cameraPosition;
  const attackCount = Number(feel.attackCount);
  if (!player || !camera) return null;
  if (![player.x, player.z, camera.x, camera.z, attackCount].every(v => Number.isFinite(Number(v)))) return null;
  return {
    playerPosition: { x: Number(player.x), z: Number(player.z) },
    cameraPosition: { x: Number(camera.x), z: Number(camera.z) },
    attackCount,
  };
}

function distance2(a, b) {
  if (!a || !b) return null;
  return Math.hypot(Number(a.x) - Number(b.x), Number(a.z) - Number(b.z));
}

function startBrowserFeelResponseProbe(sendCdp, { kind, baseline, timeoutMs = 700 }) {
  const safeTimeout = Math.max(100, Math.min(Number(timeoutMs) || 700, 1500));
  const baselineJson = JSON.stringify(baseline || {});
  const kindJson = JSON.stringify(kind);
  const expression = `(() => new Promise(resolve => {
    const startedAt = performance.now();
    const baseline = ${baselineJson};
    const timeoutMs = ${safeTimeout};
    const kind = ${kindJson};
    const sample = () => {
      let feel = null;
      try { feel = globalThis.__ROOTAGENT_PLAYTEST__?.observe?.()?.feel || null; } catch {}
      let changed = false;
      if (feel && kind === 'movement') {
        const p = feel.playerPosition;
        if (p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.z))) {
          changed = Math.hypot(Number(p.x) - Number(baseline.x), Number(p.z) - Number(baseline.z)) > 0.005;
        }
      } else if (feel && kind === 'attack') {
        changed = Number(feel.attackCount) > Number(baseline.attackCount || 0);
      }
      if (changed) return resolve(performance.now() - startedAt);
      if (performance.now() - startedAt >= timeoutMs) return resolve(null);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }))()`;
  return sendCdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }).then(result => {
    const value = result?.result?.value;
    return Number.isFinite(Number(value)) ? Number(value) : null;
  }).catch(() => null);
}

async function startFrameSampler(sendCdp) {
  await sendCdp('Runtime.evaluate', {
    expression: `(() => {
      const probe = { active: true, last: performance.now(), times: [] };
      globalThis.__ROOTAGENT_FRAME_PROBE__ = probe;
      function tick(now) {
        if (!probe.active) return;
        const dt = now - probe.last;
        probe.last = now;
        if (dt > 0 && dt < 1000) probe.times.push(dt);
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
      return true;
    })()`,
    returnByValue: true,
  });
}

async function stopFrameSampler(sendCdp) {
  const evaluated = await sendCdp('Runtime.evaluate', {
    expression: `(() => {
      const probe = globalThis.__ROOTAGENT_FRAME_PROBE__;
      if (!probe) return [];
      probe.active = false;
      return probe.times.slice(-240);
    })()`,
    returnByValue: true,
  });
  return Array.isArray(evaluated?.result?.value) ? evaluated.result.value : [];
}

async function runContinuousGameFeelScenario(sendCdp) {
  const initialObserved = await observePlaytestState(sendCdp);
  const initial = feelState(initialObserved);
  if (!initial) {
    return {
      enabled: true,
      available: false,
      reason: 'observe().feel telemetry missing or invalid',
      frameTimesMs: [],
    };
  }

  await startFrameSampler(sendCdp);
  const movementAction = { key: 'w', code: 'KeyW', keyCode: 87 };
  const movementParams = keyParams(movementAction);
  let lastMovement = initial;
  const movementSamples = [];
  const movementProbe = startBrowserFeelResponseProbe(sendCdp, {
    kind: 'movement',
    baseline: initial.playerPosition,
  });

  await sendCdp('Input.dispatchKeyEvent', { type: 'keyDown', ...movementParams });
  const movementSampleStart = Date.now();
  for (let i = 0; i < 14; i++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    const observed = await observePlaytestState(sendCdp);
    const feel = feelState(observed);
    if (!feel) continue;
    movementSamples.push({ atMs: Date.now() - movementSampleStart, ...feel });
    lastMovement = feel;
  }
  const movementResponseMs = await movementProbe;
  await sendCdp('Input.dispatchKeyEvent', { type: 'keyUp', ...movementParams });

  const releaseObserved = await observePlaytestState(sendCdp);
  const releaseState = feelState(releaseObserved) || lastMovement;
  await new Promise(resolve => setTimeout(resolve, 260));
  const stoppedObserved = await observePlaytestState(sendCdp);
  const stoppedState = feelState(stoppedObserved) || releaseState;
  const postReleaseDrift = distance2(releaseState?.playerPosition, stoppedState?.playerPosition);

  const attackStartState = feelState(await observePlaytestState(sendCdp)) || stoppedState;
  const attackStartCount = attackStartState?.attackCount ?? 0;
  const attackParams = keyParams({ key: ' ', code: 'Space', keyCode: 32 });
  const attackProbe = startBrowserFeelResponseProbe(sendCdp, {
    kind: 'attack',
    baseline: { attackCount: attackStartCount },
  });
  await sendCdp('Input.dispatchKeyEvent', { type: 'keyDown', ...attackParams });
  await new Promise(resolve => setTimeout(resolve, 35));
  await sendCdp('Input.dispatchKeyEvent', { type: 'keyUp', ...attackParams });
  const attackResponseMs = await attackProbe;

  const frameTimesMs = await stopFrameSampler(sendCdp);
  return {
    enabled: true,
    available: true,
    movementResponseMs,
    attackResponseMs,
    postReleaseDrift,
    frameTimesMs,
    movementSamples,
  };
}

function scenarioPhaseForPlaytestStep(index) {
  if (index === 0) return GAME_PLAYTEST_SCENARIO[0];
  if (index <= 2) return GAME_PLAYTEST_SCENARIO[1];
  if (index <= 4) return GAME_PLAYTEST_SCENARIO[2];
  if (index === 5) return GAME_PLAYTEST_SCENARIO[3];
  if (index <= 8) return GAME_PLAYTEST_SCENARIO[4];
  return GAME_PLAYTEST_SCENARIO[5];
}

function journeySnapshot(state) {
  const journey = state?.custom?.journey;
  if (!journey || typeof journey !== 'object') return null;
  const progress = Number(journey.progress);
  return {
    id: typeof journey.id === 'string' ? journey.id : null,
    status: typeof journey.status === 'string' ? journey.status : null,
    progress: Number.isFinite(progress) ? progress : null,
    milestone: typeof journey.milestone === 'string' ? journey.milestone : null,
  };
}

function safeEvidenceName(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

function pruneVisualEvidenceRuns(cwd, keep = 4) {
  const root = path.join(cwd, '.rootagent', 'runtime', 'visual-evidence');
  if (!fs.existsSync(root)) return;
  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const full = path.join(root, entry.name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(full).mtimeMs; } catch {}
      return { full, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of dirs.slice(Math.max(0, keep))) {
    try { fs.rmSync(stale.full, { recursive: true, force: true }); } catch {}
  }
}

async function captureVisualEvidence(cwd, sendCdp, runId, step, phase) {
  const dir = path.join(cwd, '.rootagent', 'runtime', 'visual-evidence', safeEvidenceName(runId));
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `step-${String(step).padStart(2, '0')}-${safeEvidenceName(phase?.id)}.png`;
  const absolutePath = path.join(dir, fileName);
  const captured = await sendCdp('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const data = captured?.data;
  if (typeof data !== 'string' || !data) throw new Error('Page.captureScreenshot returned no image data');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length) throw new Error('Page.captureScreenshot returned an empty image');
  fs.writeFileSync(absolutePath, bytes);
  return {
    step,
    phaseId: phase?.id || null,
    relativePath: path.relative(cwd, absolutePath).replace(/\\/g, '/'),
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
}

async function runBoundedGamePlaytest(cwd, sendCdp, options = {}) {
  const history = [];
  const visualEvidence = [];
  const visualWarnings = [];
  pruneVisualEvidenceRuns(cwd, 4);
  const visualRunId = `scenario-${Date.now()}-${process.pid}`;
  const requestedSteps = Number(options.playtestSteps ?? process.env.ROOTAGENT_JEV_PLAYTEST_STEPS ?? 1);
  const steps = Number.isInteger(requestedSteps) ? Math.max(1, Math.min(requestedSteps, 12)) : 1;

  for (let index = 0; index < steps; index++) {
    const phase = scenarioPhaseForPlaytestStep(index);
    const state = await observePlaytestState(sendCdp);
    const journeyBefore = journeySnapshot(state);
    const decision = await selectHeadlessPlaytestAction({
      cwd,
      state,
      history,
      scenarioPhase: phase,
      env: options.playtestEnv || process.env,
      fetchImpl: options.playtestFetchImpl || globalThis.fetch,
    });
    await dispatchPlaytestAction(sendCdp, decision.action);
    await new Promise(resolve => setTimeout(resolve, 120));
    const stateAfter = await observePlaytestState(sendCdp);
    const journeyAfter = journeySnapshot(stateAfter);
    const beforeCustom = state?.custom ?? null;
    const afterCustom = stateAfter?.custom ?? null;
    const phaseFirstVisit = !history.some(item => item.phaseId === phase.id);
    let screenshot = null;
    if (options.visualEvidence !== false && phaseFirstVisit) {
      try {
        screenshot = await captureVisualEvidence(cwd, sendCdp, visualRunId, index + 1, phase);
        visualEvidence.push(screenshot);
      } catch (error) {
        visualWarnings.push({
          step: index + 1,
          phaseId: phase.id,
          reason: error.message,
        });
      }
    }

    history.push({
      step: index + 1,
      phaseId: phase.id,
      phaseObjective: phase.objective,
      actionId: decision.action.id,
      selection: decision.selection,
      observedBefore: state,
      observedAfter: stateAfter,
      journeyBefore,
      journeyAfter,
      journeyProgressDelta: Number.isFinite(journeyBefore?.progress) && Number.isFinite(journeyAfter?.progress)
        ? journeyAfter.progress - journeyBefore.progress
        : null,
      effectObserved: beforeCustom != null || afterCustom != null
        ? JSON.stringify(beforeCustom) !== JSON.stringify(afterCustom)
        : null,
      visualEvidence: screenshot,
    });

    if (journeyAfter?.status === 'succeeded' || journeyAfter?.progress >= 0.999) {
      break;
    }
  }

  const feelScenario = options.feelProbe
    ? await runContinuousGameFeelScenario(sendCdp)
    : { enabled: false };

  const visitedPhases = [...new Set(history.map(step => step.phaseId).filter(Boolean))];
  const journeyProgress = history
    .map(step => step.journeyAfter?.progress)
    .filter(Number.isFinite);

  return {
    enabled: true,
    bounded: true,
    mode: 'scenario',
    scenario: {
      id: 'CORE_USER_JOURNEY_V1',
      visitedPhases,
      completed: history.some(step => step.journeyAfter?.status === 'succeeded' || step.journeyAfter?.progress >= 0.999),
      maxJourneyProgress: journeyProgress.length ? Math.max(...journeyProgress) : null,
    },
    visualEvidence: {
      enabled: options.visualEvidence !== false,
      runId: visualRunId,
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      captures: visualEvidence,
      warnings: visualWarnings,
    },
    steps: history,
    feelScenario,
  };
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

/**
 * 探测宿主机上的 Chrome / Chromium 可执行文件路径
 */
export function findChromeBinary() {
  const envCandidates = [
    process.env.CHROME_BIN,
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
  ].filter(Boolean);

  for (const bin of envCandidates) {
    if (fs.existsSync(bin)) return bin;
  }

  const platform = process.platform;
  const home = os.homedir();

  if (platform === 'darwin') {
    const macPaths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      path.join(home, 'Applications/Chromium.app/Contents/MacOS/Chromium'),
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    for (const p of macPaths) {
      if (fs.existsSync(p)) return p;
    }
  } else if (platform === 'win32') {
    const winPaths = [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    ];
    for (const p of winPaths) {
      if (fs.existsSync(p)) return p;
    }
  } else {
    // Linux
    const linuxBins = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ];
    for (const p of linuxBins) {
      if (fs.existsSync(p)) return p;
    }
  }

  return null;
}

/**
 * 第一层：静态模块引用与 ESM 依赖图完整性校验 (Fast Static Check)
 * 检查代码中所有的 import/export 相对引用和绝对静态资源是否真实存在于磁盘
 */
export function validateModuleImports(cwd) {
  const violations = [];
  const publicDir = path.join(cwd, 'public');
  const webRoot = fs.existsSync(publicDir) ? publicDir : cwd;

  function scan(dir) {
    if (!fs.existsSync(dir)) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          scan(full);
        } else if (/\.(js|mjs)$/i.test(ent.name)) {
          checkJsFile(full);
        } else if (/\.html$/i.test(ent.name)) {
          checkHtmlFile(full);
        }
      }
    } catch {}
  }

  function checkJsFile(filePath) {
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return;
    }

    const relSrc = path.relative(cwd, filePath);
    // 匹配 import ... from '...' 以及 export ... from '...' 以及 dynamic import('...')
    const importRegex = /(?:(?:import|export)\s+(?:[\s\S]*?from\s+)?|import\s*\()\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const specifier = match[1];

      // 忽略 http(s):// 或 data:
      if (/^(https?:|data:|\/\/)/.test(specifier)) continue;

      // 相对路径导入 ./ 或 ../
      if (specifier.startsWith('.')) {
        const target = path.resolve(path.dirname(filePath), specifier);
        const exists = fs.existsSync(target)
          || fs.existsSync(target + '.js')
          || fs.existsSync(target + '.mjs')
          || fs.existsSync(path.join(target, 'index.js'));
        if (!exists) {
          violations.push(`[ESM 模块缺失 404] ${relSrc} 引用了相对路径 '${specifier}'，但物理文件不存在于磁盘 (${path.relative(cwd, target)})！`);
        }
      } else if (specifier.startsWith('/')) {
        // 绝对路径（针对 Web 根目录）
        const target = path.join(webRoot, specifier.slice(1));
        const exists = fs.existsSync(target)
          || fs.existsSync(target + '.js')
          || fs.existsSync(target + '.mjs');
        if (!exists) {
          violations.push(`[Web 静态资源 404] ${relSrc} 引用了绝对路径 '${specifier}'，但在 Web 根目录不存在！`);
        }
      }
    }
  }

  function checkHtmlFile(filePath) {
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return;
    }
    const relSrc = path.relative(cwd, filePath);

    // 检查 <script src="...">
    const scriptSrcRegex = /<script\b[^>]*\bsrc=['"]([^'"]+)['"][^>]*>/gi;
    let sMatch;
    while ((sMatch = scriptSrcRegex.exec(content)) !== null) {
      const src = sMatch[1];
      if (/^(https?:|data:|\/\/)/.test(src)) continue;
      let target;
      if (src.startsWith('/')) {
        target = path.join(webRoot, src.slice(1));
      } else {
        target = path.resolve(path.dirname(filePath), src);
      }
      if (!fs.existsSync(target)) {
        violations.push(`[HTML Script 丢失 404] ${relSrc} 引入了 <script src="${src}">，但目标文件不存在！`);
      }
    }

    // 检查 <script type="importmap">
    const importmapMatch = content.match(/<script\b[^>]*type=['"]importmap['"][^>]*>([\s\S]*?)<\/script>/i);
    if (importmapMatch && importmapMatch[1]) {
      try {
        const parsed = JSON.parse(importmapMatch[1]);
        const imports = parsed.imports || {};
        for (const [key, mapPath] of Object.entries(imports)) {
          if (typeof mapPath === 'string' && (mapPath.startsWith('/') || mapPath.startsWith('.'))) {
            let target;
            if (mapPath.startsWith('/')) {
              target = path.join(webRoot, mapPath.slice(1));
            } else {
              target = path.resolve(path.dirname(filePath), mapPath);
            }
            if (!fs.existsSync(target)) {
              violations.push(`[ImportMap 悬空映射 404] ${relSrc} 的 importmap 映射 "${key}": "${mapPath}" 指向了不存在的文件！`);
            }
          }
        }
      } catch {}
    }
  }

  scan(cwd);
  return {
    ok: violations.length === 0,
    violations,
  };
}

/**
 * 第二层：真实 Headless Chrome CDP 运行时探针 (Real Browser Sandbox)
 * 启动临时 HTTP 服务，驱动无头 Chrome 访问页面，捕获真实 JS 报错与网络 404
 */
async function runHeadlessChromeProbeOnce(cwd, options = {}) {
  const timeoutMs = options.timeoutMs || 2500;
  const chromeBin = findChromeBinary();

  if (!chromeBin) {
    return {
      ok: true,
      skipped: true,
      reason: '未在系统检测到 Chrome/Chromium 浏览器二进制，跳过无头真机执行，依托静态依赖校验守护',
      errors: [],
      warnings: [],
    };
  }

  // 寻找 HTML 入口
  const publicDir = path.join(cwd, 'public');
  let htmlRel = '';
  let serveDir = cwd;

  if (fs.existsSync(path.join(publicDir, 'index.html'))) {
    serveDir = publicDir;
    htmlRel = 'index.html';
  } else if (fs.existsSync(path.join(cwd, 'index.html'))) {
    serveDir = cwd;
    htmlRel = 'index.html';
  } else {
    // 没有 HTML 前端文件，无需启动无头浏览器
    return {
      ok: true,
      skipped: true,
      reason: '未检测到 index.html 前端入口文件',
      errors: [],
      warnings: [],
    };
  }

  // 1. 启动零依赖微型本地 HTTP 静态服务器
  const server = http.createServer((req, res) => {
    let reqPath = req.url.split('?')[0];
    if (reqPath === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (reqPath === '/') reqPath = '/' + htmlRel;

    let fullPath = path.join(serveDir, reqPath);
    // 如果在 serveDir 找不到，尝试在 cwd 找
    if (!fs.existsSync(fullPath) && serveDir !== cwd) {
      fullPath = path.join(cwd, reqPath);
    }

    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(fullPath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      fs.createReadStream(fullPath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Not Found: ${reqPath}`);
    }
  });

  const serverPort = await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(server.address().port);
    });
    server.on('error', reject);
  });

  const tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-headless-chrome-'));
  const cdpPort = await getFreePort();

  let chromeProcess = null;
  let ws = null;
  let releaseHeadlessLock = null;
  const capturedErrors = [];
  const capturedWarnings = [];
  let playtestTrace = options.playtest ? { enabled: true, bounded: true, steps: [], pending: true } : { enabled: false };

  try {
    // 多个 selftest worker / 并行任务同时启动 Chrome 会导致 CI CDP 偶发失联。
    // 用 OS 临时目录原子锁串行化真实浏览器探针；stale lock 会自动回收。
    releaseHeadlessLock = await acquireHeadlessChromeLock();

    // 2. 启动 Headless Chrome
    chromeProcess = spawn(chromeBin, [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${tempUserDataDir}`,
      ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--mute-audio',
      '--hide-scrollbars',
      'about:blank',
    ], { stdio: 'ignore' });

    // 3. 轮询等待 CDP 就绪并获取 WebSocket 地址
    let wsUrl = '';
    const pollStart = Date.now();
    const cdpReadyTimeoutMs = process.platform === 'linux' ? 12000 : 5000;
    while (Date.now() - pollStart < cdpReadyTimeoutMs) {
      await new Promise(r => setTimeout(r, 80));
      try {
        const list = await fetch(`http://127.0.0.1:${cdpPort}/json`).then(r => r.json());
        const page = list.find(t => t.type === 'page');
        if (page && page.webSocketDebuggerUrl) {
          wsUrl = page.webSocketDebuggerUrl;
          break;
        }
      } catch {}
    }

    if (!wsUrl) {
      throw new Error(`无法连接到 Headless Chrome CDP 端口 (${cdpPort})`);
    }

    // 4. 通过 WebSocket 接入 CDP 事件监听
    await new Promise((resolve) => {
      ws = new WebSocket(wsUrl);
      const effectiveTimeoutMs = options.feelProbe
        ? Math.max(timeoutMs, 15000)
        : options.playtest
          ? Math.max(timeoutMs, 12000)
          : Math.max(timeoutMs, process.platform === 'linux' ? 4000 : timeoutMs);
      const pending = new Map();
      let nextCdpId = 100;
      let playtestStarted = false;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        if (options.playtest && !playtestStarted) {
          capturedWarnings.push('[PLAYTEST_START_TIMEOUT] Page did not become ready before the bounded startup deadline');
        } else if (options.playtest && playtestTrace?.pending) {
          capturedWarnings.push('[PLAYTEST_COMPLETION_TIMEOUT] Scenario playtest did not finish before the bounded runtime deadline');
        }
        finish();
      }, effectiveTimeoutMs);

      const sendCdp = (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
        const id = nextCdpId++;
        const requestTimer = setTimeout(() => {
          pending.delete(id);
          rejectRequest(new Error(`CDP request timed out: ${method}`));
        }, options.feelProbe || options.playtest ? 3000 : 1800);
        pending.set(id, {
          resolve(value) { clearTimeout(requestTimer); resolveRequest(value); },
          reject(error) { clearTimeout(requestTimer); rejectRequest(error); },
        });
        ws.send(JSON.stringify({ id, method, params }));
      });

      const startPlaytest = () => {
        if (!options.playtest || playtestStarted) return;
        playtestStarted = true;
        setTimeout(async () => {
          try {
            playtestTrace = await runBoundedGamePlaytest(cwd, sendCdp, options);
          } catch (error) {
            playtestTrace = {
              enabled: true,
              bounded: true,
              steps: playtestTrace.steps || [],
              error: error.message,
            };
            capturedWarnings.push(`[JEV 有界试玩未完成] ${error.message}`);
          } finally {
            finish();
          }
        }, 120);
      };

      ws.onopen = async () => {
        try {
          await sendCdp('Runtime.enable');
          await sendCdp('Log.enable');
          await sendCdp('Page.enable');
          await sendCdp('Network.enable');
          if (options.playtest && options.visualEvidence !== false) {
            await sendCdp('Emulation.setDeviceMetricsOverride', {
              width: 1280,
              height: 720,
              deviceScaleFactor: 1,
              mobile: false,
            });
          }
          await sendCdp('Page.addScriptToEvaluateOnNewDocument', {
            source: `
              addEventListener('error', event => {
                console.error('[ROOTAGENT_UNCAUGHT]', event.message || String(event.error || 'unknown error'));
              });
              addEventListener('unhandledrejection', event => {
                console.error('[ROOTAGENT_UNHANDLED_REJECTION]', String(event.reason || 'unknown rejection'));
              });
            `,
          });
          await sendCdp('Page.navigate', { url: `http://127.0.0.1:${serverPort}/${htmlRel}` });
          // loadEventFired is the primary trigger; this delayed idempotent fallback
          // covers very fast pages / CI scheduling races where the event is missed.
          if (options.playtest) setTimeout(startPlaytest, 350);
        } catch (error) {
          capturedErrors.push(`[CDP 初始化失败] ${error.message}`);
          finish();
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.id && pending.has(msg.id)) {
            const request = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) request.reject(new Error(msg.error.message || 'CDP request failed'));
            else request.resolve(msg.result);
            return;
          }
          if (msg.method === 'Page.loadEventFired' && options.playtest) {
            startPlaytest();
          }
          // 未捕获的运行时异常（SyntaxError, ReferenceError, TypeError 等）
          if (msg.method === 'Runtime.exceptionThrown') {
            const details = msg.params.exceptionDetails;
            const desc = details.exception?.description || details.text;
            capturedErrors.push(`[JS 未捕获异常] ${desc}`);
          }
          // console.error 调用
          else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
            const text = msg.params.args.map(a => a.value || a.description || '').join(' ');
            capturedErrors.push(`[控制台致命报错 (console.error)] ${text}`);
          }
          // 浏览器日志级错误
          else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
            const entryText = msg.params.entry.text || '';
            const entryUrl = msg.params.entry.url || '';
            if (!entryUrl.endsWith('/favicon.ico') && !entryText.includes('favicon.ico')) {
              capturedErrors.push(`[浏览器致命日志] ${entryText}`);
            }
          }
          // 网络加载失败（HTTP 4xx / 5xx，特别是模块 404）
          else if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
            const url = msg.params.response.url;
            const status = msg.params.response.status;
            if (!url.endsWith('/favicon.ico')) {
              capturedErrors.push(`[网络资源请求失败 ${status}] ${url}`);
            }
          }
        } catch {}
      };

      ws.onerror = () => finish();
    });
  } catch (err) {
    capturedErrors.push(`[无头浏览器运行探测发生异常] ${err.message}`);
  } finally {
    // 5. 优雅清理资源
    try { if (ws) ws.close(); } catch {}
    try { if (chromeProcess) chromeProcess.kill('SIGKILL'); } catch {}
    try { server.close(); } catch {}
    try { fs.rmSync(tempUserDataDir, { recursive: true, force: true }); } catch {}
    try { if (releaseHeadlessLock) releaseHeadlessLock(); } catch {}
  }

  // 去重错误信息
  const uniqueErrors = Array.from(new Set(capturedErrors));

  return {
    ok: uniqueErrors.length === 0,
    errors: uniqueErrors,
    warnings: capturedWarnings,
    browserAvailable: true,
    playtest: playtestTrace,
  };
}

export async function runHeadlessChromeProbe(cwd, options = {}) {
  const attempts = Math.max(1, Math.min(Number(options.startupAttempts || 2), 3));
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await runHeadlessChromeProbeOnce(cwd, options);
    const startupOnlyFailure = !last.ok
      && Array.isArray(last.errors)
      && last.errors.length > 0
      && last.errors.every(error =>
        error.includes('无法连接到 Headless Chrome CDP 端口')
        || error.includes('Headless Chrome probe lock timeout')
      );
    if (!startupOnlyFailure || attempt === attempts) return last;
    await new Promise(resolve => setTimeout(resolve, 300 * attempt));
  }
  return last;
}

/**
 * 综合审计无头浏览器运行时健全性（双层防御：静态完整性 + 真实无头浏览器）
 */
export async function auditHeadlessRuntime(cwd, options = {}) {
  const violations = [];

  // 1. 静态 ESM 导入完整性校验
  const staticRes = validateModuleImports(cwd);
  if (!staticRes.ok) {
    violations.push(...staticRes.violations);
  }

  // 2. 真实无头 Chrome 运行时沙箱校验
  const probeRes = await runHeadlessChromeProbe(cwd, options);
  if (!probeRes.ok) {
    violations.push(...probeRes.errors);
  }

  return {
    ok: violations.length === 0,
    violations,
    details: {
      static: staticRes,
      runtime: probeRes,
    },
  };
}

/**
 * 同步运行无头运行时审计（适合集成入同步的 validate / auditProjectExperience / check）
 */
export function runHeadlessRuntimeAuditSync(cwd, options = {}) {
  const violations = [];
  let runtime = null;

  // 1. 同步静态 ESM 导入与资源完整性扫描 (毫秒级)
  const staticRes = validateModuleImports(cwd);
  if (!staticRes.ok) {
    violations.push(...staticRes.violations);
  }

  // 2. 如果存在前端 HTML 且系统具备 Chrome，通过轻量独立进程同步拉起 Headless Chrome
  const hasHtml = fs.existsSync(path.join(cwd, 'public/index.html')) || fs.existsSync(path.join(cwd, 'index.html'));
  const chromeBin = findChromeBinary();

  if (hasHtml && chromeBin) {
    try {
      const childArgs = [__filename, '--internal-run', cwd];
      if (options.playtest) childArgs.push('--playtest');
      if (options.feelProbe) childArgs.push('--feel-probe');
      if (Number.isInteger(options.playtestSteps)) childArgs.push('--playtest-steps', String(options.playtestSteps));
      const out = execFileSync(process.execPath, childArgs, {
        timeout: options.feelProbe ? 24000 : (options.playtest ? 18000 : 12000),
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const parsed = JSON.parse(out.trim());
      runtime = parsed;
      if (!parsed.ok && parsed.errors?.length) {
        violations.push(...parsed.errors);
      }
    } catch (err) {
      // 若子进程超时或异常，保留已有 violations 并安全降级
    }
  }

  const uniqueViolations = Array.from(new Set(violations));
  return {
    ok: uniqueViolations.length === 0,
    violations: uniqueViolations,
    details: { static: staticRes, runtime },
  };
}

// 内部命令行入口支持
if (process.argv[2] === '--internal-run') {
  const targetDir = process.argv[3] || process.cwd();
  const playtest = process.argv.includes('--playtest');
  const feelProbe = process.argv.includes('--feel-probe');
  const stepsIndex = process.argv.indexOf('--playtest-steps');
  const playtestSteps = stepsIndex >= 0 ? Number(process.argv[stepsIndex + 1]) : undefined;
  runHeadlessChromeProbe(targetDir, { timeoutMs: feelProbe ? 9000 : (playtest ? 6000 : 3000), playtest, playtestSteps, feelProbe })
    .then(res => {
      process.stdout.write(JSON.stringify(res));
      process.exit(0);
    })
    .catch(err => {
      process.stdout.write(JSON.stringify({ ok: false, errors: [err.message] }));
      process.exit(0);
    });
}

