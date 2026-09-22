### JEV 3D 战术竞技场
描述：交付一个完整可玩的 3D 浏览器战斗切片。玩家通过 WASD 移动、Space/鼠标射击、Shift 闪避；敌人战术由 JEV 的有限 Choice 决策驱动，并在 JEV 网络/Key 不可用时平滑降级到本地策略。产品必须具备真实 WebGL 渲染、Web Audio、粒子反馈、生命值、得分、波次、死亡与重新开始，同时安全隔离 JEV Key。
写目标：index.html, game.js, server.mjs, package.json, README.md, tests/smoke.mjs, .github/workflows/pages.yml
依赖：
审批：否

验收标准：
- [工程] node --check game.js、node --check server.mjs 与 node tests/smoke.mjs 全部退出码为 0
- [体验] 玩家使用 WASD 移动、Space 或鼠标射击、Shift 闪避后，角色状态与 HUD 都产生即时可观察反馈
- [功能] JEV 决策只允许从 CHASE、STRAFE、RETREAT、ATTACK、GUARD 中选择并实际改变敌人战术；JEV 不可用时本地 fallback 仍保持游戏可玩
- [安全] JEV API Key 只允许从服务端环境变量或当前浏览器会话内存读取，仓库和前端静态源码不得包含真实 Key
- [体验] 玩家能够完成战斗波次、获得得分结果，生命值归零后可以重新开始新一局

验证命令：
- [L1] node --check game.js
- [L1] node --check server.mjs
- [L2] node tests/smoke.mjs
