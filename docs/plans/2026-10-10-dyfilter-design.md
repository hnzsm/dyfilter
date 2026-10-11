# 抖音推荐流过滤器 · 设计

2026-10-10

## 需求
Chrome 扩展（MV3），只作用于 douyin.com 首页推荐流（全屏沉浸流）：
- 发布日期：隐藏（跳过）发布超过 N 天的视频，N 可调，默认 30 天
- 关键字：标题（desc）或作者名（nickname）命中任一关键字即跳过，屏蔽制，不区分大小写
- 设置界面：扩展弹窗，存 chrome.storage.sync

## 关键技术结论（已实地核实）
- 推荐流卡片 DOM 无发布日期；日期只能从 feed 接口取
- feed 接口：`/aweme/v1/web/tab/feed/`（另兼容 general/feed、multi/aweme），响应 `aweme_list[]` 含 `aweme_id / create_time / desc / author.nickname`
- 当前播放视频：`video` 元素（paused=false）向上 `closest('[data-e2e-vid]')` 取 vid
- 自动跳过：document 上派发合成 keydown/keyup ArrowDown 可切换视频（已实测生效）
- hook 位于 MAIN world（document_start），通过 CustomEvent `dyfilter:feed` 传给隔离世界 content script

## 判定与边界
1. 无元信息 → 放行（不误伤）
2. 超 N 天 → 跳过；命中关键字 → 跳过
3. 两次跳过间隔 ≥800ms；连续跳过 10 个 → 15s 冷却并提示"当前没有符合条件的视频"
4. 直播/无 create_time 条目放行
5. 设置变更立即重判当前视频
6. popup 显示已捕获/已过滤计数作为接口健康指标

## 文件
manifest.json / hook.js（MAIN）/ content.js（isolated）/ popup.html+css+js
