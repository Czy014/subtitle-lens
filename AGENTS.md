# AGENTS.md — 字幕透镜 (Subtitle Lens)

给 AI 编码代理的工作指南。人类贡献者也可参考。

## 项目是什么

Chrome 扩展（Manifest V3，纯静态文件，**无构建链、无框架、无 npm 依赖**）：在 YouTube / Bilibili 播放器上注入可拖动、可缩放的"透镜"，遮挡烧录在画面里的中文字幕。领域词汇见 `GLOSSARY.md`。

## 硬约束（违反即架构性错误）

1. **CORS 是天条**：任何读像素的方案（canvas/OCR/取色/经典 CV）在浏览器内都不可行。效果只能走合成器层 CSS/SVG 滤镜（`backdrop-filter`），它不需要 JS 读像素。
2. **纯静态**：不引入打包器/TypeScript/框架。`shared.js` 用全局对象 `window.SBM` 共享（popup 与 content 两侧），不用 ES modules（content script 单上下文限制）。
3. **权限红线**：绝不申请网络类权限（fetch/xhr/hosts）。当前仅 `storage` / `scripting` / `activeTab`。
4. **注入文件清单两处同步**：`manifest.json` 的 `content_scripts.js` 与 `popup.js` 中 `chrome.scripting.executeScript` 的 `files` 必须一致（`['shared.js', 'content.js']`）。新增 content 侧文件时两处都要改——历史上漏改过一次，导致补注入后 `window.SBM` 未定义。

## 冻结决策（用户逐项确认过，不要重新讨论）

- 透镜**几何（位置/尺寸）绝不持久化**，刷新回到默认位 `{x:0.30, y:0.84, w:0.40, h:0.07}`；可见态同样不持久化，**默认隐藏**，由 popup 开启
- 持久化仅 `{mode, strength}` 两键（`chrome.storage.local`，key `sbm:settings`）
- 单透镜；无键盘快捷键；无锁定穿透；无位置记忆
- 效果仅两档：模糊（保底）/ 形态学开运算（腐蚀→膨胀→blur σ1，特性检测失败自动回退模糊档）。曾试过并否决：交替滤波链（残留全白）、阈值掩码+背景填充（Chromium backdrop 环境不支持 feComposite/feMerge 双路合成，静默失效——无头 Chrome 像素实验证实）、高光抑制档（可用但用户不要了）。**不要再提议这些**
- Chromium `backdrop-filter: url()` 只可靠支持单输入逐像素链——新效果方案先写 `filtertest/` 页面用无头 Chrome 截图像素验证，再进扩展

## 代码地图

```
manifest.json   # MV3；declarative 注入 shared.js + content.js
shared.js       # 单一事实源：normalizeSettings/effectiveMode/morphRadius/isSupportedUrl/MSG
content.js      # Host(挂载保活) / Lens(几何拖拽) / fx(效果引擎,CHAIN 数据驱动) / main(消息路由)
popup.html/css  # 三控件平铺：显示透镜(默认关) / 遮挡模式 / 强度滑杆
popup.js        # probeTab() 探测+补注入+状态分流
filtertest/     # 效果链实验页（无头 Chrome 像素验证用，非扩展组成部分）
```

## 修改守则

- **站点改版失效** → 只改 `content.js` 顶部 `CONTAINER_SELECTORS` / `CONTROL_SELECTORS`，别动其他
- **调效果链** → 只改 `fx` 里的 `CHAIN` 数据（结构即数据），构建代码勿动
- **设置逻辑** → 一律走 `shared.js` 的 `normalizeSettings`，两侧不许自写校验/回退/半径映射
- 透镜 z-index 是动态的（控制条 z-index − 1），不要写死
- 双实例并存由代际令牌（`window.__SBM_GEN__`）仲裁：`teardown` 只拆自己的层；旧实例的定时器自杀
- `bindDrag` 在事件触发时取 `state.host`，不要捕获容器引用进闭包（SPA 重挂载会失效）
- 改完跑 `node --check shared.js content.js popup.js` + `python3 -m json.tool manifest.json`；效果改动加跑 filtertest 像素验证
- 手测验收清单见交接文档 §6（YouTube/B站、全屏、SPA、两档效果、控制台无报错）
