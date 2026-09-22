# NEON TACTICS — RootAgent + JEV 3D Game

这是一次 **RootAgent 真正驱动开发** 的产物。任务契约在代码生成前由 RootAgent 冻结，游戏随后按 Maker Context 实现，再由 RootAgent 进行真实 Headless Playtest、Outcome Contract、Checker、Receipt 与 Audit Seal 验证。

## 玩什么

- **WASD**：移动
- **Space / 鼠标点击**：射击
- **Shift**：闪避
- 敌人战术严格限制在 **CHASE / STRAFE / RETREAT / ATTACK / GUARD**
- JEV 在线时由 System One Choice 选择战术；网络、额度或 Key 不可用时自动切换本地 fallback，主循环不阻塞
- 真实 WebGL 3D、Web Audio、粒子反馈、HP / Score / Wave / Game Over / Restart

## 安全使用 JEV

仓库 **不保存任何真实 API Key**。

推荐本地方式：

```bash
JEV_API_KEY="<your-key>" node server.mjs
```

打开 http://localhost:4173 后点击 **Local Proxy**。Key 只存在于 Node 进程环境。

页面也提供 **Direct JEV** 输入框用于临时浏览器会话调试；输入值只保存在当前页面内存，不写入 localStorage/sessionStorage/仓库。是否可直接请求取决于服务端 CORS 策略。

GitHub Pages 可以直接运行游戏和 fallback 模式，但静态 Pages 无法安全保存服务端密钥。

## RootAgent 运行时契约

`window.__ROOTAGENT_PLAYTEST__.observe()` 暴露只读状态、Journey 与 Outcome。Outcome criterion IDs 来自开发前冻结的 RootAgent Maker Context，而不是游戏自行发明。
