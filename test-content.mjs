import { readFileSync } from "fs";

const SRC = readFileSync(new URL("./content.js", import.meta.url), "utf8");

// content.js 是单个 IIFE，靠桩环境注入它依赖的全局对象
const boot = (initialSync) => {
  const syncData = { ...initialSync };
  const localData = {};
  const lsStore = {};
  const toasts = [];
  const messageHandlers = [];
  const playHandlers = [];
  const msgHandlers = [];
  const changedHandlers = [];

  const video = {
    paused: false,
    ended: false,
    readyState: 3,
    closest: () => ({ getAttribute: () => "V1" }),
  };

  const chrome = {
    runtime: {
      id: "ext",
      lastError: null,
      onMessage: { addListener: (fn) => msgHandlers.push(fn) },
    },
    storage: {
      sync: {
        get: (def, cb) => cb({ ...def, ...syncData }),
        set: (obj, cb) => {
          Object.assign(syncData, obj);
          cb && cb();
          for (const fn of changedHandlers) fn({}, "sync");
        },
      },
      local: {
        set: (obj) => Object.assign(localData, obj),
        get: (def, cb) => cb({ ...def, ...localData }),
      },
      onChanged: { addListener: (fn) => changedHandlers.push(fn) },
    },
  };

  const windowStub = { addEventListener: (t, fn) => t === "message" && messageHandlers.push(fn) };
  const documentStub = {
    documentElement: { dataset: { dyMainHook: "1", dyPatchMode: "proto" } },
    body: { appendChild: () => {} },
    addEventListener: (t, fn) => t === "play" && playHandlers.push(fn),
    dispatchEvent: () => {},
    querySelectorAll: (sel) => (sel === "video" ? [video] : []),
    createElement: () => {
      const el = { style: { cssText: "" }, textContent: "" };
      Object.defineProperty(el, "textContent", {
        get: () => el._t || "",
        set: (v) => {
          el._t = v;
          toasts.push(v);
        },
      });
      return el;
    },
  };

  const intervals = [];

  new Function(
    "window", "document", "chrome", "localStorage", "setInterval", "clearInterval",
    "setTimeout", "clearTimeout", "HTMLVideoElement", "KeyboardEvent",
    SRC
  )(
    windowStub,
    documentStub,
    chrome,
    { setItem: (k, v) => (lsStore[k] = v), getItem: (k) => lsStore[k] ?? null },
    (fn) => {
      intervals.push(fn);
      return intervals.length;
    },
    () => {},
    () => 2,
    () => {},
    function HTMLVideoElement() {},
    class KeyboardEvent {}
  );

  return {
    syncData,
    localData,
    lsStore,
    toasts,
    // 跑一遍 400ms 轮询：content.js 靠它确认「当前在播的是哪张卡片」
    tick() {
      for (const fn of intervals) fn();
    },
    feed(metas) {
      for (const fn of messageHandlers) fn({ data: { source: "dyfilter", type: "feed", metas } });
    },
    blockViaMenu() {
      for (const fn of msgHandlers) fn({ type: "dyfilter-block-author" }, {}, () => {});
    },
    sendOtherMessage() {
      for (const fn of msgHandlers) fn({ type: "无关消息" }, {}, () => {});
    },
    playHandlerCount: () => playHandlers.length,
  };
};

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.error("FAIL " + label);
  }
};

// 1. 没收到 feed 元数据时右键：提示识别不到博主，不污染关键字
{
  const ctx = boot({ enabled: true, hours: 720, keywords: ["广告"] });
  ctx.tick();
  ctx.blockViaMenu();
  ok(ctx.toasts.some((t) => t.includes("没识别出当前博主")), "无元数据时给出提示");
  ok(ctx.syncData.keywords.length === 1, "无元数据时不写关键字");
}

// 2. 正常屏蔽：昵称入黑名单 + 当前卡片立刻被跳过 + 配置广播给 hook
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [] });
  ctx.feed([{ id: "V1", desc: "今天的天空", nick: "测试博主", ct: Math.floor(Date.now() / 1000), live: 0 }]);
  ctx.tick();
  ctx.blockViaMenu();
  ok(JSON.stringify(ctx.syncData.keywords) === JSON.stringify(["测试博主"]), "昵称被追加进关键字黑名单");
  ok(ctx.toasts.some((t) => t.includes("已屏蔽博主：测试博主")), "屏蔽成功提示");
  ok(ctx.toasts.some((t) => t.includes("已过滤：命中关键字")), "当前视频立即被兜底跳过");
  ok(ctx.localData.skippedCount === 1, "skippedCount 计入");
  ok(ctx.localData.capturedCount === 1, "capturedCount 计入");
  const cfg = JSON.parse(ctx.lsStore["dyfilter-cfg"]);
  ok(cfg.keywords.includes("测试博主"), "新配置已广播到 localStorage 供 hook.js 读取");
}

// 3. 重复屏蔽同一博主：不产生重复条目
{
  const ctx = boot({ enabled: true, hours: 720, keywords: ["测试博主"] });
  ctx.feed([{ id: "V1", desc: "d", nick: "测试博主", ct: 1, live: 0 }]);
  ctx.blockViaMenu();
  ok(ctx.syncData.keywords.length === 1, "已在黑名单时不重复追加");
  ok(ctx.toasts.some((t) => t.includes("已经在黑名单里")), "重复屏蔽给出提示");
}

// 4. 直播卡片同样可以屏蔽（主播在 owner/user，走同一份 nick）
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [] });
  ctx.feed([{ id: "R1", desc: "正在直播", nick: "某主播", ct: 0, live: 1 }]);
  // 直播卡片 id 与当前播放元素不一致时，用当前 vid 命中不了，这里补一条同 id 的
  ctx.feed([{ id: "V1", desc: "正在直播", nick: "某主播", ct: 0, live: 1 }]);
  ctx.blockViaMenu();
  ok(ctx.syncData.keywords.includes("某主播"), "直播主播可屏蔽");
  ok(ctx.toasts.some((t) => t.includes("已屏蔽博主：某主播")), "直播屏蔽成功提示");
}

// 5. 其它扩展消息不受影响
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [] });
  ctx.sendOtherMessage();
  ok(ctx.syncData.keywords.length === 0, "无关消息不写黑名单");
}

// 6. play 事件监听确实挂上了（capture 阶段兜底判定的入口）
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [] });
  ok(ctx.playHandlerCount() === 1, "注册了 play 监听");
}

console.log(fail === 0 ? `ALL PASS (${pass} 条断言)` : `${fail} 条失败 / ${pass} 条通过`);
process.exit(fail === 0 ? 0 : 1);
