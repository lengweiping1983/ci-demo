# TASK — JEV 3D Arena

## Description
使用 RootAgent 开发并验证一个可部署到 GitHub Pages 的 3D 游戏。敌方战术由 JEV 在固定候选动作中决策；JEV 不可用时必须自动降级到本地策略。API Key 不得写入静态站点或 Git 历史。

## Acceptance Criteria
- 使用真实 WebGL / Three.js 3D 渲染，不使用 Canvas2D 假 3D。
- WASD 移动、鼠标瞄准、点击或 Space 射击、Shift 闪避均有实际反馈。
- 敌方战术候选至少包含 CHASE / STRAFE / RETREAT / ATTACK / GUARD。
- JEV 网络调用失败、超时、CORS 或未配置 Key 时游戏仍可继续。
- 包含生命值、得分、波次、死亡与重新开始闭环。
- 包含 Web Audio 打击/射击反馈、动态光源、粒子效果。
- 暴露 `window.__ROOTAGENT_PLAYTEST__.observe()` 供 RootAgent Headless 试玩读取状态。
- 仓库中不得出现任何 `apikey_*` 明文。
- GitHub Pages 部署成功且页面可直接打开。

## Validation Commands
- `node tests/smoke.mjs`
- RootAgent `auditProjectExperience(cwd, '使用 JEV 决策的 3D 游戏程序')`
- GitHub Pages deployment workflow
