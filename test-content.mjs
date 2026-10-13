import { readFileSync } from "fs";

const SRC = readFileSync(new URL("./content.js", import.meta.url), "utf8");

// 最小 DOM 桩：够跑 content.js 用到的那几样（dataset / children / rect / computed style）
const el = ({ text = "", rect = { left: 0, top: 0, width: 0, height: 0 }, position = "", children = [] } = {}) => {
  const node = {
    nodeType: 1,
    dataset: {},
    style: {},
    textContent: text,
    children: [],
    parentNode: null,
    parentElement: null,
    _position: position,
    _rect: rect,
    _handlers: {},
    getBoundingClientRect: () => rect,
    addEventListener(type, fn) {
      (node._handlers[type] = node._handlers[type] || []).push(fn);
    },
    dispatch(type, evt = {}) {
      for (const fn of node._handlers[type] || []) fn(evt);
    },
    setAttribute: () => {},
    appendChild(child) {
      child.parentNode = node;
      child.parentElement = node;
      node.children.push(child);
      return child;
    },
    cloneNode() {
      return el({ text: node.textContent, rect: node._rect, position: node._position });
    },
  };
  for (const c of children) node.appendChild(c);
  return node;
};

const boot = (initialSync) => {
  const syncData = { ...initialSync };
  const localData = {};
  const lsStore = {};
  const toasts = [];
  const bodyEvents = [];
  const handlers = { message: [], play: [], contextmenu: [] };
  const msgHandlers = [];
  const changedHandlers = [];
  const intervals = [];
  const timeouts = [];
  let observerCb = null;
  let pointStack = [];

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

  const windowStub = {
    addEventListener: (t, fn) => handlers.message.push(fn),
    MutationObserver: class {
      constructor(cb) {
        observerCb = cb;
      }
      observe() {}
    },
    getComputedStyle: (node) => ({ position: node._position || "" }),
  };

  const root = el({ position: "" });
  const body = el({ position: "" });
  body.dispatchEvent = (evt) => bodyEvents.push(evt.type);
  const documentStub = {
    documentElement: Object.assign(root, { dataset: { dyMainHook: "1", dyPatchMode: "proto" } }),
    body,
    addEventListener: (t, fn) => (handlers[t] || handlers.message).push(fn),
    dispatchEvent: () => {},
    elementsFromPoint: () => pointStack,
    querySelectorAll: (sel) => (sel === "video" ? [video] : []),
    createElement: () => {
      const node = el();
      Object.defineProperty(node, "textContent", {
        get: () => node._t || "",
        set: (v) => {
          node._t = v;
          toasts.push(v);
        },
      });
      return node;
    },
  };

  new Function(
    "window", "document", "chrome", "localStorage", "setInterval", "clearInterval",
    "setTimeout", "clearTimeout", "HTMLVideoElement", "KeyboardEvent", "MouseEvent",
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
    (fn) => {
      timeouts.push(fn);
      return timeouts.length;
    },
    () => {},
    function HTMLVideoElement() {},
    class KeyboardEvent {},
    class MouseEvent {}
  );

  return {
    syncData,
    localData,
    lsStore,
    toasts,
    bodyEvents,
    el,
    // 页面自绘菜单：贴着鼠标位置弹出的 fixed 容器 + 两行菜单项
    makeMenu({ x = 300, y = 200, position = "fixed", rows = 2 } = {}) {
      const kids = [];
      for (let i = 0; i < rows; i++) {
        kids.push(el({ text: `菜单项${i}`, rect: { left: x, top: y + i * 32, width: 160, height: 32 }, position: "static" }));
      }
      return el({ position, rect: { left: x, top: y, width: 160, height: rows * 32 }, children: kids });
    },
    contextmenu(x = 300, y = 200) {
      for (const fn of handlers.contextmenu) fn({ clientX: x, clientY: y });
    },
    fireMutation(node) {
      if (observerCb) observerCb([{ addedNodes: [node] }]);
    },
    setPointStack(stack) {
      pointStack = stack;
    },
    runTimeouts() {
      for (const fn of timeouts.splice(0)) fn();
    },
    feed(metas) {
      for (const fn of handlers.message) fn({ data: { source: "dyfilter", type: "feed", metas } });
    },
    tick() {
      for (const fn of intervals) fn();
    },
    blockViaMenu() {
      for (const fn of msgHandlers) fn({ type: "dyfilter-block-author" }, {}, () => {});
    },
    injectedRow(menu) {
      return menu.children.find((c) => c.textContent === "屏蔽这个博主");
    },
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

// 1. 抖音自绘菜单弹出后补一行，点它 = 屏蔽当前博主
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [] });
  ctx.feed([{ id: "V1", desc: "d", nick: "某博主", ct: Math.floor(Date.now() / 1000), live: 0 }]);
  ctx.tick();
  ctx.contextmenu(300, 200);
  const menu = ctx.makeMenu();
  ctx.fireMutation(menu);
  const row = ctx.injectedRow(menu);
  ok(!!row, "抖音自绘菜单里补进了「屏蔽这个博主」");
  ok(menu.children.length === 3, "原有菜单项没被动过");
  row && row.dispatch("click", { preventDefault() {}, stopPropagation() {} });
  ok(JSON.stringify(ctx.syncData.keywords) === JSON.stringify(["某博主"]), "点注入行写入黑名单");
  ok(ctx.toasts.some((t) => t.includes("已屏蔽博主：某博主")), "点注入行给出提示");
  ok(ctx.bodyEvents.length >= 2, "点击后把菜单交给页面自己关闭");
  ctx.fireMutation(menu);
  ok(menu.children.filter((c) => c.textContent === "屏蔽这个博主").length === 1, "同一菜单不重复注入");
}

// 2. 菜单节点被复用（只切 display）时，走鼠标点元素栈兜住
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [] });
  ctx.feed([{ id: "V1", desc: "d", nick: "复用博主", ct: 1, live: 0 }]);
  ctx.tick();
  ctx.contextmenu(300, 200);
  const menu = ctx.makeMenu();
  ctx.setPointStack([menu.children[0]]);
  ctx.runTimeouts();
  ok(!!ctx.injectedRow(menu), "复用菜单也能被元素栈找到");
}

// 3. 不像菜单的东西不乱注入
{
  const ctx = boot({ enabled: true, hours: 720, keywords: ["已有"] });
  ctx.feed([{ id: "V1", desc: "d", nick: "某博主", ct: 1, live: 0 }]);
  ctx.tick();
  ctx.contextmenu(300, 200);
  const notMenus = [
    ctx.makeMenu({ position: "static" }), // 非定位元素
    ctx.makeMenu({ x: 900, y: 900 }), // 离鼠标太远
    ctx.makeMenu({ rows: 1 }), // 只有一行
    ctx.el({ text: "刚插入的视频卡片", position: "fixed", rect: { left: 300, top: 200, width: 400, height: 600 } }),
  ];
  for (const node of notMenus) ctx.fireMutation(node);
  ok(notMenus.every((n) => !ctx.injectedRow(n)), "非菜单节点不会被注入");
  const menu = ctx.makeMenu();
  ctx.fireMutation(menu);
  ok(!!ctx.injectedRow(menu), "真菜单仍被识别");
  ok(ctx.syncData.keywords.length === 1 && ctx.syncData.keywords[0] === "已有", "注入本身不写黑名单，只有点击才写");
}

// 4. 没发生右键时，页面上冒出来的浮层不认作菜单
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [] });
  const menu = ctx.makeMenu();
  ctx.fireMutation(menu);
  ok(!ctx.injectedRow(menu), "没有右键锚点时不注入");
  ok(menu.children.length === 2, "没有右键锚点时菜单保持原样");
}

// 5. 浏览器原生右键菜单入口仍在（播放器以外的区域可用）
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [] });
  ctx.feed([{ id: "V1", desc: "d", nick: "原生入口博主", ct: 1, live: 0 }]);
  ctx.tick();
  ctx.blockViaMenu();
  ok(ctx.syncData.keywords.includes("原生入口博主"), "runtime 消息入口仍可用");
}

console.log(fail === 0 ? `ALL PASS (${pass} 条断言)` : `${fail} 条失败 / ${pass} 条通过`);
process.exit(fail === 0 ? 0 : 1);
