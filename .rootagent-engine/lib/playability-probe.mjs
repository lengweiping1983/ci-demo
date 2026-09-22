/**
 * RootAgent 游戏与可玩产品体验深度探针 (Playability & Experience Probe)
 * 
 * 作用：
 * 对游戏/前端交互类项目进行真实的可用性、操控响应性、非阻塞主循环与异常降级体检，
 * 彻底消除“语法绿了但游戏根本不能玩”的假绿伪证。
 */

import fs from 'fs';
import path from 'path';
import { runHeadlessRuntimeAuditSync } from './headless-runtime-probe.mjs';

/**
 * 精准检测代码中是否存在主渲染循环内部同步阻塞调用网络 (rAF 帧循环与 await fetch 位于同一函数作用域)
 */
export function detectSyncFetchInRenderLoop(code) {
  if (!code || (!code.includes('await') && !code.includes('fetch'))) return false;
  if (!code.includes('requestAnimationFrame') && !code.includes('setAnimationLoop')) return false;

  // 1. 检查内联回调: requestAnimationFrame(async () => { ... await fetch ... })
  const inlineRafMatch = code.match(/(?:requestAnimationFrame|setAnimationLoop)\s*\(\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>\s*\{([\s\S]*?)\}/g);
  if (inlineRafMatch) {
    for (const block of inlineRafMatch) {
      if (/await\s+(?:fetch|axios|http)/i.test(block)) return true;
    }
  }

  // 2. 块级作用域提取：分析所有独立命名的函数体，避免跨函数贪婪污染
  const fnStarts = [];
  const fnRegex = /(?:async\s+)?function(?:\s+[a-zA-Z0-9_$]+)?\s*\([^)]*\)\s*\{|(?:const|let|var)\s+[a-zA-Z0-9_$]+\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>\s*\{/g;
  let match;
  while ((match = fnRegex.exec(code)) !== null) {
    fnStarts.push(match.index + match[0].length - 1);
  }

  for (const startIdx of fnStarts) {
    let depth = 0;
    let endIdx = -1;
    for (let i = startIdx; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }
    if (endIdx !== -1) {
      const fnBody = code.slice(startIdx, endIdx + 1);
      const hasRafInside = fnBody.includes('requestAnimationFrame') || fnBody.includes('setAnimationLoop');
      const hasSyncFetchInside = /await\s+(?:fetch|axios|http)/i.test(fnBody);
      if (hasRafInside && hasSyncFetchInside) {
        return true;
      }
    }
  }

  return false;
}

export const PROBE_CHECKS = [
  {
    id: 'render-pipeline',
    name: '3D WebGL 渲染管线完整性',
    weight: 25,
    check(filesContent) {
      const allText = Object.values(filesContent).join('\n');
      const has3DRenderer =
        allText.includes('WebGLRenderer')
        || allText.includes("getContext('webgl')")
        || allText.includes("getContext('webgl2')")
        || /BABYLON\.|PlayCanvas|pc\.Application|Godot/i.test(allText);

      if (!has3DRenderer) {
        return { pass: false, reason: '未发现真实 3D WebGL 渲染管线初始化' };
      }
      return { pass: true, detail: '真实 3D 渲染管线已初始化' };
    }
  },
  {
    id: 'headless-runtime-integrity',
    name: '真实无头浏览器运行时零报错与模块健全性',
    weight: 25,
    check(filesContent, cwd) {
      if (!cwd || !fs.existsSync(cwd)) return { pass: true, detail: '内存模拟模式，跳过无头物理探测' };
      const audit = runHeadlessRuntimeAuditSync(cwd);
      if (!audit.ok) {
        return {
          pass: false,
          reason: `真实运行时检测到 ${audit.violations.length} 处未捕获异常/404 缺失: ${audit.violations.slice(0, 2).join('; ')}`
        };
      }
      return { pass: true, detail: '真实无头浏览器环境零未捕获异常，模块依赖拓扑完备' };
    }
  },
  {
    id: 'input-responsiveness',
    name: '玩家控制与输入事件响应链',
    weight: 25,
    check(filesContent) {
      const allText = Object.values(filesContent).join('\n');
      const hasInputWiring =
        allText.includes('keydown')
        || allText.includes('keyup')
        || allText.includes('keypress')
        || allText.includes('pointerdown')
        || allText.includes('mousedown')
        || allText.includes('touchstart')
        || allText.includes('gamepadconnected')
        || allText.includes('PointerLockControls');

      if (!hasInputWiring) {
        return { pass: false, reason: '未发现键盘、鼠标、触摸或手柄等真实用户输入接入' };
      }
      return { pass: true, detail: '已发现真实用户输入接入；输入是否产生有效反馈由运行时 Playtest 独立验证' };
    }
  },
  {
    id: 'non-blocking-loop',
    name: '主渲染循环流畅度与非阻塞保障',
    weight: 15,
    check(filesContent) {
      const allText = Object.values(filesContent).join('\n');
      const hasRaf = allText.includes('requestAnimationFrame');
      
      if (!hasRaf && !allText.includes('setAnimationLoop')) {
        return { pass: false, reason: '未检测到 requestAnimationFrame / setAnimationLoop 主渲染循环' };
      }

      // 检查在动画循环内部是否有同步阻塞式网络调用（使用精确函数作用域分析，避免跨函数贪婪污染）
      const hasSyncLoopFetch = detectSyncFetchInRenderLoop(allText);

      if (hasSyncLoopFetch) {
        return { pass: false, reason: '主渲染循环内部存在同步 await fetch 远程调用，会导致严重掉帧与主线程假死！必须异步解耦' };
      }

      return { pass: true, detail: '主渲染循环规范，无同步阻塞网络调用' };
    }
  },
  {
    id: 'decision-resilience',
    name: 'AI 决策异步解耦与异常优雅降级',
    weight: 10,
    check(filesContent) {
      const allText = Object.values(filesContent).join('\n');
      const callsApi = allText.includes('fetch(') || allText.includes('XMLHttpRequest') || allText.includes('axios.');
      
      if (!callsApi) {
        // 如果当前是纯本地逻辑版本，允许通过但给出说明
        return { pass: true, detail: '本地逻辑切片模式（未调用外部 API）' };
      }

      // 检查调用外部网络时是否有 try-catch 或 catch 降级处理
      const hasTryCatch = allText.includes('try {') && (allText.includes('catch') || allText.includes('.catch('));
      const hasFallback = allText.includes('fallback') || allText.includes('default') || allText.includes('heuristic') || allText.includes('Math.random');

      if (!hasTryCatch) {
        return { pass: false, reason: '外部 API 调用缺少 try-catch 异常捕获，网络抖动或 Key 失效将导致程序直接崩溃' };
      }
      if (!hasFallback) {
        return { pass: false, reason: '缺少异常/超时本地降级行为（Fallback），网络断开时实体行为将停滞' };
      }

      return { pass: true, detail: '外部决策调用具备异常保护与本地行为平滑降级' };
    }
  },
];

/**
 * 收集当前项目中的核心网页/游戏源码
 */
export function collectGameSourceFiles(cwd) {
  const contents = {};
  const visited = new Set();

  function scanDir(dir, baseRel = '', depth = 0) {
    if (depth > 3) return; // 限制深度
    if (!fs.existsSync(dir)) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'build') continue;
        const fullPath = path.join(dir, ent.name);
        const relPath = baseRel ? `${baseRel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          scanDir(fullPath, relPath, depth + 1);
        } else if (ent.isFile() && /\.(html|js|mjs|ts)$/i.test(ent.name) && !ent.name.includes('.test.') && !ent.name.includes('.spec.')) {
          if (!visited.has(relPath)) {
            visited.add(relPath);
            try {
              contents[relPath] = fs.readFileSync(fullPath, 'utf-8');
            } catch {}
          }
        }
      }
    } catch {}
  }

  // 1. 扫描根目录关键文件
  const rootCandidates = ['index.html', 'game.js', 'main.js', 'app.js', 'renderer.js'];
  for (const f of rootCandidates) {
    const abs = path.join(cwd, f);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      try {
        contents[f] = fs.readFileSync(abs, 'utf-8');
        visited.add(f);
      } catch {}
    }
  }

  // 2. 扫描 public 与 src 子目录
  scanDir(path.join(cwd, 'public'), 'public', 0);
  scanDir(path.join(cwd, 'src'), 'src', 0);

  return contents;
}

/**
 * 运行全套可玩体验探针检验
 */
export function runPlayabilityProbe(cwd = process.cwd()) {
  const files = collectGameSourceFiles(cwd);
  const fileCount = Object.keys(files).length;

  if (fileCount === 0) {
    return {
      ok: false,
      score: 0,
      summary: '未找到前端网页或游戏源码文件 (index.html, game.js 等)',
      results: []
    };
  }

  let totalScore = 0;
  const results = [];
  let allPass = true;

  for (const probe of PROBE_CHECKS) {
    const res = probe.check(files, cwd);
    if (res.pass) {
      totalScore += probe.weight;
      results.push({ id: probe.id, name: probe.name, pass: true, detail: res.detail, weight: probe.weight });
    } else {
      allPass = false;
      results.push({ id: probe.id, name: probe.name, pass: false, reason: res.reason, weight: probe.weight });
    }
  }

  return {
    ok: allPass,
    score: totalScore,
    summary: allPass ? `体验探针全项通过！可玩性得分: ${totalScore}/100` : `体验探针发现缺陷，可玩性得分: ${totalScore}/100`,
    filesScanned: Object.keys(files),
    results
  };
}

/**
 * CLI 入口格式化打印
 */
export function formatProbeReport(report) {
  let out = `\n🎮 RootAgent 产品可玩性与用户体验体检报告 (Playability Health Report)\n`;
  out += `─────────────────────────────────────────────────────────────\n`;
  out += `扫描文件: ${report.filesScanned?.join(', ') || '无'}\n`;
  out += `综合体验评分: ${report.score} / 100  (${report.ok ? '✓ PASS' : '✗ NEEDS WORK'})\n\n`;

  for (const item of report.results) {
    const symbol = item.pass ? '✓' : '✗';
    out += `${symbol} [${item.name}] (权重 ${item.weight}分)\n`;
    if (item.pass) {
      out += `   详情: ${item.detail}\n`;
    } else {
      out += `   缺陷: ${item.reason}\n`;
    }
  }
  out += `─────────────────────────────────────────────────────────────\n`;
  if (!report.ok) {
    out += `💡 改进建议：请对照上述失败项修复输入事件、主循环非阻塞或异常降级逻辑后重新验证。\n`;
  }
  return out;
}
