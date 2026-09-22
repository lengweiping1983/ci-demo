/**
 * RootAgent 领域品类档案与技术选型雷达 (Domain Archetype & Quality Radar)
 * 
 * 作用：
 * 根据用户 Prompt 与项目上下文，自动推导最匹配的项目 Archetype（品类画像），
 * 输出强制技术基线（Baseline Stack）、反偷懒负向约束（Anti-Lazy Constraints）
 * 以及必须通过的体验门禁检查项（Experience Quality Assertions）。
 */

import fs from 'fs';
import path from 'path';
import { collectGameSourceFiles, detectSyncFetchInRenderLoop } from './playability-probe.mjs';
import { runHeadlessRuntimeAuditSync } from './headless-runtime-probe.mjs';
import { buildProductQualityFindings, selectProductQualityFindingSync, formatProductQualityFinding } from './product-quality-findings.mjs';
import { buildUserJourneyFindings, validateJourneyObservation } from './user-journey-quality.mjs';
import { buildUserOutcomeFindings, validateOutcomeObservation } from './user-outcome-evidence.mjs';
import { buildOutcomeContractFindings } from './outcome-contract.mjs';
import { buildGameFeelFindings, validateFeelObservation, summarizeGameFeel } from './game-feel-quality.mjs';

export const ARCHETYPES = {
  '3d-game-interactive': {
    name: '3D 互动游戏与沉浸式体验 (3D Game & Interactive Visualization)',
    keywords: ['3d', '游戏', 'game', '机甲', '太空', '射击', '战斗', 'three', 'webgl', '渲染'],
    baselineStack: [
      '使用真实 3D 渲染管线；允许 Three.js、Babylon.js、PlayCanvas、Godot Web 或原生 WebGL 等合适实现，不把特定框架、PBR、灯光类型当作质量代理',
      '视角系统必须服务核心玩法并保持可控、可读、稳定；允许第三人称、第一人称、固定/轨道或其它符合设计目标的相机方案',
      '只有当用户目标或产品设计需要声音时才要求音频；音频验收关注反馈是否可感知、时机是否正确，不强制 Web Audio、振荡器或特定合成方式',
      '动作与反馈必须形成真实可观察闭环：输入后角色/世界状态发生合理变化，攻击、受击、移动等核心动作不得只修改隐藏计数器来冒充体验',
      '核心玩法与操作响应性优先：键盘/鼠标控制必须即时平滑，主游戏循环稳定流畅（≥30 FPS）',
      '主渲染循环非阻塞：严禁在 requestAnimationFrame 内部同步阻塞等待远程网络请求或重度计算',
      '无头真机运行时零报错：页面在真实浏览器环境中必须无未捕获异常、无模块 404 缺失与控制台致命错误',
      '开发态可观察性：强交互产品必须暴露只读 window.__ROOTAGENT_PLAYTEST__.observe()，让 RootAgent 能验证真实输入前后的产品状态变化',
      '核心旅程可观察性：observe() 必须返回 journey={id,status,progress,milestone}，其中 progress 为 0..1，用于验证真实操作是否推进核心用户目标',
      '最终结果可观察性：observe() 必须返回 outcome={id,status,criteria[]}；每个必需 criteria 都要显式标记 met，防止“旅程完成但用户最终结果未交付”',
      '连续手感可观察性：observe() 必须返回 feel={playerPosition,cameraPosition,attackCount}，RootAgent 会在真实浏览器中持续采样输入响应与帧时间，而不是只验证一次状态变化'
    ],
    antiLazyRules: [
      '【严禁偷懒】用户明确要求真实 3D 时，严禁使用 HTML5 Canvas 2D 软件透视投影冒充 3D',
      '【严禁偷懒】严禁单纯文本打印、隐藏计数变化或静态模型冒充真实交互反馈',
      '【严禁偷懒】严禁为了满足检查项机械添加与产品目标无关的音效、粒子、计分、生命值、固定相机类型或其它装饰性功能',
      '【严禁偷懒】严禁在主游戏渲染循环中直接阻塞等待网络',
      '【严禁偷懒】严禁依赖缺失的未打包模块或产生未捕获的运行时 JS 报错'
    ],
    requiredExperienceAssertions: [
      { name: '真实 3D 管线断言', check: '必须存在浏览器可实际运行的 3D 渲染管线；不得用 Canvas 2D 软件投影冒充 3D，但不强制特定引擎、材质或灯光实现' },
      { name: '端到端可操作闭环断言', check: '必须绑定真实输入控制并形成操作→可见状态变化→反馈的核心闭环；胜负、计分、音频、粒子等仅在产品目标需要时才成为硬要求' },
      { name: '无头真机运行时零错误断言', check: '必须通过 Headless 真实浏览器沙箱运行且无控制台致命报错或 404 模块丢失' },
      { name: '真实交互可观察性断言', check: '开发态必须提供 window.__ROOTAGENT_PLAYTEST__.observe() 只读状态快照，供 Headless 比较真实输入前后效果' },
      { name: '核心用户旅程推进断言', check: 'observe().journey 必须提供 id/status/progress/milestone；连续有效用户操作不得使核心旅程长期停滞或无故倒退' },
      { name: '最终用户结果一致性断言', check: 'observe().outcome 必须提供 id/status/criteria；journey 成功后 outcome 必须 satisfied，且 satisfied 时所有必需 criteria 必须 met=true' },
      { name: '连续交互手感断言', check: '真实浏览器连续按键/攻击场景必须证明输入响应及时、帧时间稳定，并提供 player/camera/attack 遥测用于独立分析' }
    ],
    validateExperience(cwd, context = {}) {
      const violations = [];
      const files = collectGameSourceFiles(cwd);
      const allSource = Object.values(files).join('\n');
      if (!allSource.includes('__ROOTAGENT_PLAYTEST__') || !allSource.includes('observe')) {
        violations.push('缺少开发态 window.__ROOTAGENT_PLAYTEST__.observe() 只读状态 Hook，RootAgent 无法用真实输入验证核心操作是否产生产品状态反馈。');
      }
      for (const [rel, content] of Object.entries(files)) {
        // 仅当文件既拿 2D context 又包含典型 3D 投影/计算（且未引入真正 WebGL 管线）时拦截
        const has2D = content.includes("getContext('2d')");
        const hasSoftware3D = (content.includes('project(') || content.includes('project =')) && (content.includes('/ z') || content.includes('/ (z'));
        if (has2D && hasSoftware3D && !content.includes('WebGLRenderer')) {
          violations.push(`${rel} 中发现 Canvas 2D 透视投影模拟 (getContext('2d'))，违反 3D 品类必须基于真实 WebGL 管线的质量底线！`);
        }
        // 检查是否在动画循环中阻塞调用 fetch（使用精准函数作用域分析，避免跨函数贪婪污染）
        if (detectSyncFetchInRenderLoop(content)) {
          violations.push(`${rel} 中在主渲染循环 (animate/render/loop) 内部直接同步 await fetch，会导致帧率严重掉帧假死，必须异步解耦！`);
        }
      }

      // 执行无头运行时、静态 ESM 完整性与高置信交互质量检查。
      // V1 只在产品暴露可观察状态且真实非 WAIT 输入后状态明确不变时产生 Finding，
      // 没有观察 Hook 时不做主观猜测。
      const headlessRes = runHeadlessRuntimeAuditSync(cwd, { playtest: true, playtestSteps: 8, feelProbe: true });
      if (!headlessRes.ok) {
        violations.push(...headlessRes.violations);
      }

      const playtest = headlessRes.details?.runtime?.playtest || null;
      const steps = Array.isArray(playtest?.steps) ? playtest.steps : [];
      const firstObservedState = steps[0]?.observedBefore || steps[0]?.observedAfter || null;
      if (headlessRes.ok && steps.length && !validateJourneyObservation(firstObservedState)) {
        violations.push('缺少有效 observe().journey={id,status,progress,milestone} 核心旅程状态，RootAgent 无法验证真实操作是否推进用户目标。');
      }
      if (headlessRes.ok && steps.length && !validateOutcomeObservation(firstObservedState)) {
        violations.push('缺少有效 observe().outcome={id,status,criteria[]} 最终用户结果状态，RootAgent 无法证明核心旅程完成后用户真正得到承诺结果。');
      }
      if (headlessRes.ok && steps.length && !validateFeelObservation(firstObservedState?.custom)) {
        violations.push('缺少有效 observe().feel={playerPosition,cameraPosition,attackCount} 连续手感遥测，RootAgent 无法验证输入延迟、相机跟随与帧时间稳定性。');
      }

      const interactionFindings = headlessRes.ok
        ? buildProductQualityFindings(playtest)
        : [];
      const journeyFindings = headlessRes.ok
        ? buildUserJourneyFindings(playtest)
        : [];
      const outcomeFindings = headlessRes.ok
        ? buildUserOutcomeFindings(playtest)
        : [];
      const latestValidOutcome = [...steps]
        .reverse()
        .flatMap(step => [step?.observedAfter, step?.observedBefore])
        .map(state => validateOutcomeObservation(state))
        .find(Boolean) || validateOutcomeObservation(firstObservedState);
      const boundOutcome = latestValidOutcome;
      const contractFindings = headlessRes.ok && context.outcomeContract?.criteria?.length
        ? buildOutcomeContractFindings(boundOutcome, context.outcomeContract)
        : [];
      const feelFindings = headlessRes.ok
        ? buildGameFeelFindings(playtest?.feelScenario)
        : [];
      const qualityFindings = [...feelFindings, ...contractFindings, ...outcomeFindings, ...journeyFindings, ...interactionFindings];
      const selectedQualityFinding = qualityFindings.length
        ? selectProductQualityFindingSync(cwd, qualityFindings, { goal: context.goal || null, archetype: '3d-game-interactive' })
        : null;
      if (selectedQualityFinding) {
        violations.push(formatProductQualityFinding(selectedQualityFinding));
      }

      return {
        ok: violations.length === 0,
        violations,
        qualityFindings,
        selectedQualityFinding,
        runtimeEvidence: playtest,
        visualEvidence: playtest?.visualEvidence || null,
        gameFeel: summarizeGameFeel(playtest?.feelScenario),
      };
    }
  },

  'ai-decision-showcase': {
    name: 'AI 决策驱动应用与算法集成 (AI Decision Driven System)',
    keywords: ['jev', '决策', 'decision', 'system one', 'choice', 'score', 'noul', 'agent', '遥测', 'hud'],
    baselineStack: [
      '决策驱动核心实体行为：AI 决策（Choice/Score/Noul 等）必须切实转化为直观的实体动作、战术切换或物理反应，绝非单纯文本打印',
      '异步解耦与非阻塞架构：AI 决策请求必须异步轮询或事件驱动，严禁阻塞前端主交互/渲染循环',
      '网络故障与超时优雅降级：遇网络异常、API Key 无效或请求超时，必须自动降级为本地预设规则/启发式行为，保证应用/游戏平滑可运行',
      '安全代理架构：后端必须中继隔离真实 API Key，严禁前端明文暴露敏感凭证',
      '可选轻量状态指示：决策状态（如当前战术、置信度）可作为轻量指示，但绝不能喧宾夺主挤占核心业务/游戏主画面'
    ],
    antiLazyRules: [
      '【严禁偷懒】严禁假决策：AI 返回结果不得只存不行动，必须驱动具体行为或状态流转',
      '【严禁偷懒】严禁主循环同步阻塞等待网络决策',
      '【严禁偷懒】严禁无异常捕获和无本地降级兜底导致应用冻结或崩溃',
      '【严禁偷懒】严禁前端明文暴露真实 API Key'
    ],
    requiredExperienceAssertions: [
      { name: '决策驱动行为断言', check: 'AI 决策输出必须实际驱动实体状态机或行为变迁' },
      { name: '异常降级与非阻塞断言', check: '必须包含 API 请求超时/失败降级逻辑，且主循环不发生阻塞卡死' }
    ],
    validateExperience(cwd) {
      const violations = [];
      const files = collectGameSourceFiles(cwd);
      for (const [rel, content] of Object.entries(files)) {
        // 检查明文真实 API Key 泄露到前端静态文件
        if (content.includes('apikey_') && (rel.startsWith('public/') || rel === 'index.html')) {
          violations.push(`${rel} 中直接明文硬编码了 API Key (apikey_*)，违反安全中继与凭证隔离底线！`);
        }
        // 检查是否在动画循环中阻塞调用 fetch
        if (detectSyncFetchInRenderLoop(content)) {
          violations.push(`${rel} 中在主循环内直接同步 await fetch，会导致主线程严重挂起卡顿，必须采用异步解耦！`);
        }
      }

      // 执行无头运行时与静态 ESM 模块完整性真实校验
      const headlessRes = runHeadlessRuntimeAuditSync(cwd);
      if (!headlessRes.ok) {
        violations.push(...headlessRes.violations);
      }

      return { ok: violations.length === 0, violations };
    }
  },

  'enterprise-dashboard': {
    name: '企业级数据看板与管理台 (Enterprise Dashboard & Portal)',
    keywords: ['dashboard', '看板', '管理后台', '报表', 'crm', 'erp', '表格', '图表'],
    baselineStack: [
      '现代响应式流式布局，深浅主题自适应',
      '专业图表可视化 (ECharts / Chart.js / SVG 矢量微图)',
      '骨架屏 (Skeleton)、Loading 态及异常友好兜底'
    ],
    antiLazyRules: [
      '【严禁偷懒】严禁纯原生未美化的原始 HTML 表格',
      '【严禁偷懒】严禁缺少加载与错误状态处理'
    ],
    requiredExperienceAssertions: [
      { name: '数据可视化断言', check: '必须包含现代图表渲染组件' }
    ],
    validateExperience(cwd) {
      return { ok: true, violations: [] };
    }
  },

  'developer-cli-tool': {
    name: '开发者 CLI 与系统工具 (Developer Tooling & CLI)',
    keywords: ['cli', 'tool', '工具', '命令行', 'terminal', 'compiler', 'generator'],
    baselineStack: [
      '标准化 POSIX 命令行参数解析 (--help, --version, --json)',
      '友好的终端色彩排版与 ANSI 样式指示',
      '规范的退出码标准 (Exit Code 0 成功，非 0 语义化错误)'
    ],
    antiLazyRules: [
      '【严禁偷懒】严禁吞掉报错堆栈',
      '【严禁偷懒】严禁无 --help 帮助文档输出'
    ],
    requiredExperienceAssertions: [
      { name: '帮助文档断言', check: '执行 --help 必须返回格式化使用说明' }
    ],
    validateExperience(cwd) {
      return { ok: true, violations: [] };
    }
  }
};

/**
 * 根据 Prompt 与项目上下文推导匹配的品类雷达
 * @param {string} prompt 用户诉求或目标描述
 * @returns {Array<typeof ARCHETYPES[keyof typeof ARCHETYPES]>}
 */
export function detectArchetypes(prompt = '') {
  const text = prompt.toLowerCase();
  const matched = [];

  for (const [key, profile] of Object.entries(ARCHETYPES)) {
    const hits = profile.keywords.filter(k => text.includes(k.toLowerCase()));
    if (hits.length >= 1) {
      matched.push({ key, ...profile, hits });
    }
  }

  // 默认兜底
  if (matched.length === 0) {
    matched.push({ key: 'general-app', name: '通用应用 (General Application)', baselineStack: [], antiLazyRules: [], requiredExperienceAssertions: [] });
  }

  return matched;
}

/**
 * 格式化输出为可注入到 PLAN.md 契约中的高标准规范文本
 */
export function generateExperienceContract(prompt = '') {
  const matched = detectArchetypes(prompt);
  let out = `## 体验基准与技术契约 (Experience & Quality Contract)\n\n`;

  matched.forEach(p => {
    out += `### 🎯 品类标杆画像：${p.name}\n`;
    if (p.baselineStack?.length) {
      out += `#### 强制技术基线 (Baseline Stack):\n`;
      p.baselineStack.forEach(b => out += `- ${b}\n`);
    }
    if (p.antiLazyRules?.length) {
      out += `#### 严禁采用的偷懒路径 (Anti-Lazy Constraints):\n`;
      p.antiLazyRules.forEach(r => out += `- ${r}\n`);
    }
    if (p.requiredExperienceAssertions?.length) {
      out += `#### 体验门禁硬断言 (Quality Assertions):\n`;
      p.requiredExperienceAssertions.forEach(a => out += `- [${a.name}] ${a.check}\n`);
    }
    out += `\n`;
  });

  return out;
}

/**
 * 运行时体验审计：针对当前目录执行反偷懒与质量检查
 */
export function auditProjectExperience(cwd, goal = '', context = {}) {
  const archetypes = detectArchetypes(goal);
  const allViolations = [];
  const qualityFindings = [];
  const runtimeEvidence = [];

  for (const arc of archetypes) {
    if (typeof arc.validateExperience === 'function') {
      const res = arc.validateExperience(cwd, context);
      if (!res.ok) {
        allViolations.push(...res.violations);
      }
      if (Array.isArray(res.qualityFindings)) {
        qualityFindings.push(...res.qualityFindings.map(item => ({ archetype: arc.key, ...item })));
      }
      if (res.runtimeEvidence) {
        runtimeEvidence.push({ archetype: arc.key, evidence: res.runtimeEvidence });
      }
    }
  }

  return {
    ok: allViolations.length === 0,
    archetypes: archetypes.map(a => a.name),
    violations: allViolations,
    qualityFindings,
    runtimeEvidence,
  };
}
