# JEV // Neon Arena

一个由 RootAgent 约束开发的浏览器 3D 竞技场游戏。

## 操作
- WASD：移动
- 鼠标：瞄准
- 左键 / Space：射击
- Shift：闪避

## JEV 决策
敌方战术指挥器只允许从以下动作中选择：
- CHASE
- STRAFE
- RETREAT
- ATTACK
- GUARD

页面允许玩家在当前会话中临时输入 JEV API Key。Key 仅保存在 JavaScript 内存中，不写入 localStorage、仓库或 GitHub Pages 产物。JEV 调用失败或浏览器 CORS 不允许时，会自动切换到本地 fallback 策略。

## RootAgent 可观测接口
游戏暴露：

```js
window.__ROOTAGENT_PLAYTEST__.observe()
```

返回 HP、分数、波次、敌人数、最近敌人距离、玩家位置、当前战术和 AI 模式，供最新 RootAgent Headless Playtest 读取动作前后状态。

## 部署
main 分支由 `.github/workflows/deploy-pages.yml` 自动发布到 GitHub Pages。
