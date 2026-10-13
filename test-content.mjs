import { readFileSync } from "fs";

const SRC = readFileSync(new URL("./content.js", import.meta.url), "utf8");

const LABEL = "拉黑该作者";

// 真实 DOM 的 rect 同时有 left/top/width/height/right/bottom，桩里补齐，免得逻辑各写一套
const norm = (r) => {
  const left = r.left ?? 0;
  const top = r.top ?? 0;
  const width = r.width ?? (r.right != null ? r.right - left : 0);
  const height = r.height ?? (r.bottom != null ? r.bottom - top : 0);
  return { left, top, width, height, right: left + width, bottom: top + height };
};

// 最小 DOM 桩：够跑 content.js 用到的那几样（dataset / children / rect / computed style / querySelector）
const el = (
  {
    text = "",
    rect = { left: 0, top: 0, width: 0, height: 0 },
    position = "",
    href = "",
    title = "",
    attrs = {},
    img = null,
    children = [],
  } = {}
) => {
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
    title,
    _handlers: {},
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    getBoundingClientRect: () => norm(rect),
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
      if (sel === "img") return img;
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

// 播放中的视频元素：vidKey 模拟 data-e2e-vid（抖音改名时它就没了）
const mkVideo = ({ vidKey = "V1", src = "", rect = { left: 0, top: 0, right: 400, bottom: 700 }, paused = false } = {}, holder) => ({
  nodeType: 1,
  paused,
  ended: false,
  readyState: 3,
  currentSrc: src,
  parentElement: holder || null,
  closest: (sel) => (sel === "[data-e2e-vid]" && vidKey ? { getAttribute: () => vidKey } : null),
  getBoundingClientRect: () => norm(rect),
});

const boot = (initialSync, { loginButtons = [], feedMirror = null } = {}) => {
  const syncData = { ...initialSync };
  const localData = {};
  const lsStore = {};
  if (feedMirror) lsStore["dyfilter-feed"] = JSON.stringify(feedMirror);
  const toasts = [];
  const bodyEvents = [];
  const handlers = { message: [], play: [], contextmenu: [] };
  const msgHandlers = [];
  const changedHandlers = [];
  const intervals = [];
  const timeouts = [];
  const userLinks = [];
  let observerCb = null;
  let pointStack = [];

  const cardHolder = el({ text: "" });
  let videos = [mkVideo({}, cardHolder)];

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
    innerWidth: 800,
    innerHeight: 800,
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
    querySelectorAll: (sel) => {
      if (sel === "video") return videos;
      if (sel.includes("button")) return loginButtons;
      if (sel.includes("/user/")) return userLinks;
      return [];
    },
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
    mkVideo,
    setVideos: (list) => {
      videos = list;
    },
    setLoginButtons: (list) => {
      loginButtons.length = 0;
      for (const b of list) loginButtons.push(el(b));
    },
    // 页面上作者链接的数量（诊断信息里会带上）；parent 用来模拟"链接和视频同属一张卡片"
    setUserLinks: (list) => {
      userLinks.length = 0;
      for (const b of list) {
        const node = el(b);
        if (b.parent) b.parent.appendChild(node);
        userLinks.push(node);
      }
    },
    // 接口元数据镜像：hook.js 落到 localStorage 的那份（首页响应早于 content 监听器）
    seedFeedMirror: (metas) => {
      lsStore["dyfilter-feed"] = JSON.stringify(metas);
    },
    // 播放卡片里的作者链接：a[href*="/user/<sec_uid>"]，文字就是昵称
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

// 2. data-e2e-vid 没了：靠播放地址把 video 对回接口卡片
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  ctx.setVideos([ctx.mkVideo({ vidKey: "", src: "https://v26-web.douyin.com/aaa/video/tos-cn-p-0015/abc123?sign=xyz" }, null)]);
  ctx.feed([{ id: "V9", desc: "d", nick: "地址博主", sec: "SEC_URL", ct: 1, live: 0, url: "https://v26-web.douyin.com/aaa/video/tos-cn-p-0015/abc123?a=1" }]);
  ctx.tick();
  ctx.blockViaMenu();
  ok(JSON.stringify(ctx.syncData.blocked) === JSON.stringify([{ sec: "SEC_URL", nick: "地址博主" }]), "无 vid 键时按播放地址认出作者");
}

// 3. 接口元数据完全对不上：退回页面上离在播视频最近的作者链接
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  ctx.setVideos([ctx.mkVideo({ vidKey: "", src: "" })]);
  ctx.setUserLinks([{ text: "链接博主", href: "https://www.douyin.com/user/MS4wLjABAAAAx?from_nav=1", rect: { left: 20, top: 600, width: 120, height: 24 } }]);
  ctx.tick();
  ctx.blockViaMenu();
  ok(JSON.stringify(ctx.syncData.blocked) === JSON.stringify([{ sec: "MS4wLjABAAAAx", nick: "链接博主" }]), "从页面链接认出 sec_uid+昵称");
}

// 3.1 播放器用 blob（MSE）时不硬套地址索引，退回页面链接
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  ctx.feed([{ id: "V8", desc: "d", nick: "接口博主", sec: "SEC_V8", ct: 1, live: 0, url: "https://v26-web.douyin.com/aaa/video/tos-cn-p-0015/abc123?a=1" }]);
  ctx.setVideos([ctx.mkVideo({ vidKey: "", src: "blob:https://www.douyin.com/7d9f-1" })]);
  ctx.setUserLinks([{ text: "链接博主", href: "https://www.douyin.com/user/SEC_BLOB", rect: { left: 20, top: 600, width: 120, height: 24 } }]);
  ctx.tick();
  ctx.blockViaMenu();
  ok(JSON.stringify(ctx.syncData.blocked) === JSON.stringify([{ sec: "SEC_BLOB", nick: "链接博主" }]), "blob 播放源时按页面链接认出作者，不被地址索引误判");
}

// 3.2 头像那种 <a><img></a> 没有文字，昵称从 alt / 接口元数据里补，sec_uid 照样拿得到
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  ctx.setVideos([ctx.mkVideo({ vidKey: "", src: "" })]);
  ctx.setUserLinks([
    { href: "https://www.douyin.com/user/SEC_AVATAR", rect: { left: 20, top: 620, width: 44, height: 44 }, img: { _img: true, alt: "头像博主" } },
  ]);
  ctx.tick();
  ctx.blockViaMenu();
  ok(JSON.stringify(ctx.syncData.blocked) === JSON.stringify([{ sec: "SEC_AVATAR", nick: "头像博主" }]), "无文字头像链接取 img.alt 当昵称");

  const ctx2 = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  ctx2.feed([{ id: "V7", desc: "d", nick: "元数据昵称", sec: "SEC_META_ONLY", ct: 1, live: 0 }]);
  ctx2.setVideos([ctx2.mkVideo({ vidKey: "NOPE", src: "" })]);
  ctx2.setUserLinks([{ href: "https://www.douyin.com/user/SEC_META_ONLY", rect: { left: 20, top: 620, width: 44, height: 44 } }]);
  ctx2.tick();
  ctx2.blockViaMenu();
  ok(JSON.stringify(ctx2.syncData.blocked) === JSON.stringify([{ sec: "SEC_META_ONLY", nick: "元数据昵称" }]), "链接无文字时按 sec_uid 回查接口昵称");
}

// 3.3 同一张卡片里两条不同作者的链接同样近：认不准就不写，绝不拉错人
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  const card = el({ text: "" });
  ctx.setVideos([ctx.mkVideo({ vidKey: "", src: "" }, card)]);
  ctx.setUserLinks([
    { text: "甲博主", href: "https://www.douyin.com/user/SEC_X", rect: { left: 20, top: 600, width: 120, height: 24 }, parent: card },
    { text: "乙博主", href: "https://www.douyin.com/user/SEC_Y", rect: { left: 150, top: 600, width: 120, height: 24 }, parent: card },
  ]);
  ctx.tick();
  ctx.blockViaMenu();
  ok(ctx.syncData.blocked.length === 0, "同卡片同距时不写黑名单");
  const diag = ctx.toasts.find((t) => t.includes("没认出手上这条的作者"));
  ok(/同距\(SEC_X@0\/SEC_Y@0px\)/.test(diag), `诊断里点明是哪两条链接打架：${diag}`);
}

// 3.4 压在视频画面上的链接优先于只是靠近的；都没压住时要求明显更近才算数
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  ctx.setVideos([ctx.mkVideo({ vidKey: "", src: "" })]);
  ctx.setUserLinks([
    { text: "隔壁卡片", href: "https://www.douyin.com/user/SEC_FAR", rect: { left: 20, top: 760, width: 120, height: 24 } },
    { text: "本条作者", href: "https://www.douyin.com/user/SEC_OVER", rect: { left: 20, top: 600, width: 120, height: 24 } },
  ]);
  ctx.tick();
  ctx.blockViaMenu();
  ok(JSON.stringify(ctx.syncData.blocked) === JSON.stringify([{ sec: "SEC_OVER", nick: "本条作者" }]), "压住画面的作者链接胜出，不被相邻卡片抢走");

  const ctx2 = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  ctx2.setVideos([ctx2.mkVideo({ vidKey: "", src: "" })]);
  ctx2.setUserLinks([
    { text: "甲", href: "https://www.douyin.com/user/SEC_G60", rect: { left: 20, top: 760, width: 120, height: 24 } },
    { text: "乙", href: "https://www.douyin.com/user/SEC_G100", rect: { left: 20, top: 800, width: 120, height: 24 } },
  ]);
  ctx2.tick();
  ctx2.blockViaMenu();
  ok(ctx2.syncData.blocked.length === 0, "两条都没压住画面且距离接近时判为认不准");
}

// 3.5 顶栏头像那种 /user/self 也压在画面上：它不是任何作品的作者，要排除
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  const card = el({ text: "" });
  ctx.setVideos([ctx.mkVideo({ vidKey: "", src: "" }, card)]);
  ctx.setUserLinks([
    { text: "我的头像", href: "https://www.douyin.com/user/self?from_tab_name=main", rect: { left: 20, top: 10, width: 44, height: 44 } },
    { text: "本条作者", href: "https://www.douyin.com/user/SEC_REAL", rect: { left: 20, top: 600, width: 120, height: 24 }, parent: card },
  ]);
  ctx.tick();
  ctx.blockViaMenu();
  ok(JSON.stringify(ctx.syncData.blocked) === JSON.stringify([{ sec: "SEC_REAL", nick: "本条作者" }]), "排除 /user/self，认卡片里的作者");
}

// 3.6 结构归属优先于像素距离：不在同一张卡片里的链接再近也不认
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  const card = el({ text: "" });
  ctx.setVideos([ctx.mkVideo({ vidKey: "", src: "" }, card)]);
  ctx.setUserLinks([
    { text: "别处的链接", href: "https://www.douyin.com/user/SEC_OUTSIDE", rect: { left: 20, top: 300, width: 120, height: 24 } },
    { text: "同卡片作者", href: "https://www.douyin.com/user/SEC_INSIDE", rect: { left: 20, top: 600, width: 120, height: 24 }, parent: card },
  ]);
  ctx.tick();
  ctx.blockViaMenu();
  ok(JSON.stringify(ctx.syncData.blocked) === JSON.stringify([{ sec: "SEC_INSIDE", nick: "同卡片作者" }]), "按共同祖先判定归属，取同卡片那条");
}

// 3.7 首页响应早于 content 的监听器：从 hook 落在 localStorage 的镜像里补读元数据
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [] }, {
    feedMirror: [{ id: "V50", desc: "d", nick: "镜像博主", sec: "SEC_MIRROR", ct: 1, live: 0, url: "https://v26-web.douyin.com/a/video/tos-cn/zz11223344556677?a=1" }],
  });
  ctx.setVideos([ctx.mkVideo({ vidKey: "V50", src: "" })]);
  ctx.blockViaMenu();
  ok(JSON.stringify(ctx.syncData.blocked) === JSON.stringify([{ sec: "SEC_MIRROR", nick: "镜像博主" }]), "没收到 postMessage 也能靠镜像认出作者");

  const ctx2 = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  ctx2.seedFeedMirror([{ id: "V51", desc: "d", nick: "后落镜像的博主", sec: "SEC_LATE", ct: 1, live: 0, url: "https://x.com/a/b/uniq-tail-99887766" }]);
  ctx2.setVideos([ctx2.mkVideo({ vidKey: "V51", src: "" })]);
  ctx2.blockViaMenu();
  ok(JSON.stringify(ctx2.syncData.blocked) === JSON.stringify([{ sec: "SEC_LATE", nick: "后落镜像的博主" }]), "拉黑前再回读一次镜像，拿到刚写入的那页");
}

// 4. 预加载的下一条也在播：取视口里占面积最大的那个视频，作者链接按它就近取
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  ctx.setUserLinks([
    { text: "预加载的这条", href: "https://www.douyin.com/user/SEC_OFF", rect: { left: 100, top: -700, width: 120, height: 24 } },
    { text: "在播的这条", href: "https://www.douyin.com/user/SEC_ON", rect: { left: 100, top: 400, width: 120, height: 24 } },
  ]);
  ctx.setVideos([
    ctx.mkVideo({ vidKey: "", src: "" }, null), // DOM 里排在前面的预加载卡片，视口外
    ctx.mkVideo({ vidKey: "", src: "" }),
  ]);
  ctx.setVideos([
    Object.assign(ctx.mkVideo({ vidKey: "", src: "" }, null), { getBoundingClientRect: () => ({ left: 0, top: -800, right: 400, bottom: -100, width: 400, height: 700 }) }),
    ctx.mkVideo({ vidKey: "", src: "" }),
  ]);
  ctx.tick();
  ctx.blockViaMenu();
  ok(JSON.stringify(ctx.syncData.blocked) === JSON.stringify([{ sec: "SEC_ON", nick: "在播的这条" }]), "选中的是视口里在播的那条而不是预加载卡片");
}

// 4.1 地址末两段对不上（CDN 路径深度不同）时，退一步只认最后一段，且要求全页唯一
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  ctx.feed([
    { id: "V88", desc: "d", nick: "尾段博主", sec: "SEC_TAIL", ct: 1, live: 0, url: "https://v26-web.douyin.com/aaa/video/tos-cn-p-0015/abcdef0123456789?a=1" },
    { id: "V89", desc: "d", nick: "另一条", sec: "SEC_OTHER", ct: 1, live: 0, url: "https://v26-web.douyin.com/bbb/video/tos-cn-p-0015/zzz999888777666?a=1" },
  ]);
  ctx.setVideos([ctx.mkVideo({ vidKey: "NOPE", src: "https://v95-web.douyin.com/deeper/path/prefix/abcdef0123456789?sign=x" })]);
  ctx.tick();
  ctx.blockViaMenu();
  ok(JSON.stringify(ctx.syncData.blocked) === JSON.stringify([{ sec: "SEC_TAIL", nick: "尾段博主" }]), "两段路径不同也能按末段唯一尾缀对上");

  const ctx2 = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  ctx2.feed([
    { id: "VA", desc: "d", nick: "甲", sec: "SEC_A1", ct: 1, live: 0, url: "https://x.com/a/playlist-shared" },
    { id: "VB", desc: "d", nick: "乙", sec: "SEC_B1", ct: 1, live: 0, url: "https://y.com/b/playlist-shared" },
  ]);
  ctx2.setVideos([ctx2.mkVideo({ vidKey: "NOPE", src: "https://z.com/c/playlist-shared" })]);
  ctx2.setUserLinks([{ text: "页面博主", href: "https://www.douyin.com/user/SEC_PAGE", rect: { left: 20, top: 600, width: 120, height: 24 } }]);
  ctx2.tick();
  ctx2.blockViaMenu();
  ok(ctx2.syncData.blocked[0] && ctx2.syncData.blocked[0].sec === "SEC_PAGE", "末段撞名时作废地址索引，改走页面链接");
}

// 5. 三条路都认不出：提示里带上各环节计数，并写进诊断
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  ctx.setVideos([ctx.mkVideo({ vidKey: "", src: "" }, null)]);
  ctx.setUserLinks([]);
  ctx.tick();
  ctx.blockViaMenu();
  const diag = ctx.toasts.find((t) => t.includes("没认出手上这条的作者"));
  ok(!!diag, "认不出作者时给出提示");
  ok(/元数据0/.test(diag) && /vid=无/.test(diag) && /作者链接0/.test(diag), `提示里含各环节计数：${diag}`);
  ok(/附近无作者链接/.test(diag), `提示里说明页面链接这条为什么断：${diag}`);
  ok(typeof ctx.localData.authorDbg === "string" && ctx.localData.authorDbg.includes("元数据0"), "诊断写入 storage.local 供弹窗展示");
  ok(ctx.syncData.blocked.length === 0, "认不出作者时不写 blocked");
}

// 6. 重复拉黑去重（按 sec_uid）
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [{ sec: "SEC_A", nick: "旧名字" }] });
  ctx.feed([{ id: "V1", desc: "d", nick: "新名字", sec: "SEC_A", ct: 1, live: 0 }]);
  ctx.tick();
  ctx.blockViaMenu();
  ok(ctx.syncData.blocked.length === 1, "同一 sec_uid 不重复拉黑");
  ok(ctx.toasts.some((t) => t.includes("已经拉黑了")), "重复拉黑给出提示");
}

// 7. 登录态：只在顶栏有「登录」按钮时才当作未登录（判不准就给入口）
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  ctx.setLoginButtons([{ text: "登录", rect: { left: 1200, top: 20, width: 64, height: 32 } }]);
  ctx.contextmenu();
  let menu = ctx.makeMenu();
  ctx.fireMutation(menu);
  ok(!ctx.injectedRow(menu), "顶栏有登录按钮时不注入拉黑行");

  ctx.setLoginButtons([{ text: "登录", rect: { left: 0, top: 0, width: 0, height: 0 } }]);
  ctx.contextmenu();
  menu = ctx.makeMenu();
  ctx.fireMutation(menu);
  ok(!!ctx.injectedRow(menu), "登录按钮被隐藏时视为已登录，照常注入");

  ctx.setLoginButtons([{ text: "登录其他账号", rect: { left: 100, top: 100, width: 120, height: 32 } }]);
  ctx.contextmenu();
  menu = ctx.makeMenu();
  ctx.fireMutation(menu);
  ok(!!ctx.injectedRow(menu), "文案不是纯「登录」的按钮不算未登录");

  // 登录墙盖在页面中间时也有可见的「登录」按钮，但它不在顶栏，不能据此判定未登录
  ctx.setLoginButtons([{ text: "登录", rect: { left: 500, top: 600, width: 64, height: 32 } }]);
  ctx.contextmenu();
  menu = ctx.makeMenu();
  ctx.fireMutation(menu);
  ok(!!ctx.injectedRow(menu), "顶栏以外的登录按钮不影响给入口");
}

// 8. 菜单节点被复用（只切 display）时，走鼠标点元素栈兜住
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

// 9. 不像菜单的浮层不乱注入
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

// 10. 没有右键锚点时，页面上冒出来的浮层不认作菜单
{
  const ctx = boot({ enabled: true, hours: 720, keywords: [], blocked: [] });
  const menu = ctx.makeMenu();
  ctx.fireMutation(menu);
  ok(!ctx.injectedRow(menu), "没有右键锚点时不注入");
  ok(menu.children.length === 2, "没有右键锚点时菜单保持原样");
}

// 11. 拉黑名单随配置广播给 hook.js
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
