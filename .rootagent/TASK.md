### Genesis Slice：AEGIS DRIFT JEV 3D 战术竞技场
描述：用一个连续上下文交付完整但受控的 3D 可玩切片。玩家驾驶悬浮战机守卫能量核心；敌人每轮战术决策必须通过 JEV bounded choice 在 CHASE、STRAFE、RETREAT、ATTACK、GUARD 中选择，成功响应必须真实改变敌人移动/攻击；网络、Key 或 CORS 不可用时必须无缝切换本地策略。GitHub Pages 版本不得嵌入真实 Key，只允许玩家把 Key 放入当前页面内存；本地 server.mjs 可从服务端环境变量读取 Key。第一轮不再拆 Player/Enemy/UI/Audio 子任务。
写目标：index.html, styles.css, game.js, server.mjs, package.json, tests/smoke.mjs, scripts/rootagent-ci.mjs, .github/workflows/rootagent-pages.yml, README.md, runtime-config.js
依赖：
审批：否

验收标准：
- [工程] npm test 必须退出码为 0，且 game.js、server.mjs、scripts/rootagent-ci.mjs 语法检查全部通过
- [体验] 玩家进入页面即可使用 WASD 移动、Space 射击、Shift 闪避，角色、相机和战斗反馈必须即时且连续可观察
- [功能] 敌人战术必须由 JEV 在 CHASE、STRAFE、RETREAT、ATTACK、GUARD 五个有限候选中选择并真实改变敌人移动/攻击行为；JEV 不可用时自动切换本地 fallback 且游戏不中断
- [体验] 玩家能够击毁敌人、推进波次、看到得分与生命变化，并在失败后立即重新开始新一局
- [安全] 仓库、静态页面和日志不得包含真实 JEV API Key；GitHub Pages 只能使用当前页面内存凭据，本地代理只能从环境变量读取
- [质量] 必须使用真实 WebGL 3D 渲染，RootAgent Headless Scenario Playtest 无致命异常、无模块 404，并提供 journey、outcome、feel 与阶段截图证据

验证命令：
- [L2] npm test
