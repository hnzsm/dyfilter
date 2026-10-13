import { readFileSync } from "fs";

const SRC = readFileSync(new URL("./content.js", import.meta.url), "utf8");

const LABEL = "拉黑该作者";

// 最小 DOM 桩：够跑 content.js 用到的那几样（dataset / children / rect / computed style / querySelector）
const el = ({ text = "", rect = { left: 0, top: 0, width: 0, height: 0 }, position = "", href = "", children = [] } = {}) => {
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
    _href: href,
    href,
    _handlers: {},
    getBoundingClientRect: () => rect,
    addEventListener(type, fn) {
      (node._handlers[type] = node._handlers[type] || []).push(fn);
    },
    dispatch(type, evt = {}) {
      for (const fn of node._handlers[type] || []) fn(evt);
    },
    appendChild(child) {
      child.parentNode = node;
      child.parentElement = node;
      node.children.push(child);
      return child;
    },
    querySelector(sel) {
      if (!sel.includes("/user/")) return null;
      for (const c of node.children) {
        if (c._href && c._href.includes("/user/")) return c;
        const deeper = c.querySelector && c.querySelector(sel);
        if (deeper) return deeper;
      }
      return null;
    },
    cloneNode() {
      return el({ text: node.textContent, rect: node._rect, position: node._position });
    },
  };
  for (const c of children) node.appendChild(c);
  return node;
};

const LOGGED_IN_COOKIE = "ttwid=1; sessionid=abcdef; sid_guard=xyz";
const LOGGED_OUT_COOKIE = "ttwid=1; __ac_nonce=0123456";

const boot = (initialSync, { cookie = LOGGED_IN_COOKIE } = {}) => {
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

  // 播放中的视频：默认挂在 cardHolder 下，cardHolder 里可以放作者链接
  const cardHolder = el({ text: "" });
  const video = {
    nodeType: 1,
    paused: false,
    ended: false,
    readyState: 3,
    parentElement: cardHolder,
    closest: (sel) => (sel === "[data-e2e-vid]" ? { getAttribute: () => "V1" } : null),
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
    cookie,
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
    setCookie: (v) => {
      documentStub.cookie = v;
    },
    // 页面上的作者链接：a[href*="/user/<sec_uid>"]，文字就是昵称
    setDomAuthor: (href, text) => {
      cardHolder.children.length = 0;
      cardHolder.appendChild(el({ text, href }));
    },
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
      return menu.children.find((c) => c.textContent === LABEL);
    },
    clickRow(menu) {
      const row = this.injectedRow(menu);
      row && row.dispatch("click", { preventDefault() {}, stopPropagation() {} });
      return !!row;
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

// 1. 接口元数据认得出作者：写进独立的 blocked 列表，不碰关键字
{
  const ctx = boot({ enabled: true, hours: 720, keywords: ["广告"], blocked: [] });
  ctx.feed([{ id: "V1", desc: "d", nick: "某博主", sec: "SEC_A", ct: Math.floor(Date.now() / 1000), live: 0 }]);
  ctx.tick();
  ctx.contextmenu();
  const menu = ctx.makeMenu();
  ctx.fireMutation(menu);
  ok(!!ctx.injectedRow(menu), `菜单里补进了「${LABEL}」`);
  ctx.clickRow(menu);
  ok(JSON.stringify(ctx.syncData.blocked) === JSON.stringify([{ sec: "SEC_A", nick: "某博主" }]), "拉黑写入 blocked（含 sec_uid）");
  ok(JSON.stringify(ctx.syncData.keywords) === JSON.stringify(["广告"]), "关键字列表没被污染");
  ok(ctx.toasts.some((t) => t.includes("已拉黑：某博主")), "给出拉黑提示");
  ok(ctx.toasts.some((t) => t.includes("已过滤：已拉黑「某博主」")), "当前视频立刻被跳过");
  ctx.fireMutation(menu);
  ok(menu.children.filter((c) => c.textContent === LABEL).length === 1, "同一菜单不重复注入");
}

// 2. 接口元数据缺失时退回页面 DOM 的作者链接
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  ctx.setDomAuthor("https://www.douyin.com/user/MS4wLjABAAAAx?from_nav=1", "链接博主");
  ctx.tick();
  ctx.blockViaMenu();
  ok(JSON.stringify(ctx.syncData.blocked) === JSON.stringify([{ sec: "MS4wLjABAAAAx", nick: "链接博主" }]), "从页面链接认出 sec_uid+昵称");
}

// 3. 两条路都认不出：只提示，不写坏配置
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  ctx.tick();
  ctx.blockViaMenu();
  ok(ctx.toasts.some((t) => t.includes("没认出手上这条的作者")), "认不出作者时给出提示");
  ok(ctx.syncData.blocked.length === 0, "认不出作者时不写 blocked");
}

// 4. 重复拉黑去重（按 sec_uid）
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [{ sec: "SEC_A", nick: "旧名字" }] });
  ctx.feed([{ id: "V1", desc: "d", nick: "新名字", sec: "SEC_A", ct: 1, live: 0 }]);
  ctx.tick();
  ctx.blockViaMenu();
  ok(ctx.syncData.blocked.length === 1, "同一 sec_uid 不重复拉黑");
  ok(ctx.toasts.some((t) => t.includes("已经拉黑了")), "重复拉黑给出提示");
}

// 5. 未登录时不往抖音菜单里塞这一行
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [] }, { cookie: LOGGED_OUT_COOKIE });
  ctx.contextmenu();
  const menu = ctx.makeMenu();
  ctx.fireMutation(menu);
  ok(!ctx.injectedRow(menu), "未登录时不注入拉黑行");
  ctx.setCookie(LOGGED_IN_COOKIE);
  const later = ctx.makeMenu();
  ctx.fireMutation(later);
  ok(!!ctx.injectedRow(later), "登录态恢复后重新右键即可注入");
}

// 6. 菜单节点被复用（只切 display）时，走鼠标点元素栈兜住
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  ctx.feed([{ id: "V1", desc: "d", nick: "复用博主", sec: "SEC_R", ct: 1, live: 0 }]);
  ctx.tick();
  ctx.contextmenu();
  const menu = ctx.makeMenu();
  ctx.setPointStack([menu.children[0]]);
  ctx.runTimeouts();
  ok(!!ctx.injectedRow(menu), "复用菜单也能被元素栈找到");
}

// 7. 不像菜单的浮层不乱注入
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  ctx.feed([{ id: "V1", desc: "d", nick: "某博主", sec: "SEC_A", ct: 1, live: 0 }]);
  ctx.tick();
  ctx.contextmenu();
  const notMenus = [
    ctx.makeMenu({ position: "static" }),
    ctx.makeMenu({ x: 900, y: 900 }),
    ctx.makeMenu({ rows: 1 }),
    ctx.el({ text: "刚插入的视频卡片", position: "fixed", rect: { left: 300, top: 200, width: 400, height: 600 } }),
  ];
  for (const node of notMenus) ctx.fireMutation(node);
  ok(notMenus.every((n) => !ctx.injectedRow(n)), "非菜单节点不会被注入");
  const menu = ctx.makeMenu();
  ctx.fireMutation(menu);
  ok(!!ctx.injectedRow(menu), "真菜单仍被识别");
  ok(ctx.syncData.blocked.length === 0, "注入本身不写黑名单，只有点击才写");
}

// 8. 没有右键锚点时，页面上冒出来的浮层不认作菜单
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  const menu = ctx.makeMenu();
  ctx.fireMutation(menu);
  ok(!ctx.injectedRow(menu), "没有右键锚点时不注入");
  ok(menu.children.length === 2, "没有右键锚点时菜单保持原样");
}

// 9. 浏览器原生右键菜单入口仍在（播放器以外的区域可用）
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  ctx.feed([{ id: "V1", desc: "d", nick: "原生入口博主", sec: "SEC_N", ct: 1, live: 0 }]);
  ctx.tick();
  ctx.blockViaMenu();
  ok(ctx.syncData.blocked.some((b) => b.sec === "SEC_N"), "runtime 消息入口仍可用");
}

// 10. 拉黑名单随配置广播给 hook.js
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  ctx.feed([{ id: "V1", desc: "d", nick: "广播博主", sec: "SEC_B", ct: 1, live: 0 }]);
  ctx.tick();
  ctx.blockViaMenu();
  const cfg = JSON.parse(ctx.lsStore["dyfilter-cfg"]);
  ok(cfg.blocked && cfg.blocked[0] && cfg.blocked[0].sec === "SEC_B", "blocked 已广播到 localStorage 供 hook.js 读取");
}

console.log(fail === 0 ? `ALL PASS (${pass} 条断言)` : `${fail} 条失败 / ${pass} 条通过`);
process.exit(fail === 0 ? 0 : 1);
