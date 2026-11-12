import { readFileSync } from "fs";

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) {
    pass += 1;
    console.log(`PASS ${name}${extra ? " | " + extra : ""}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}${extra ? " | " + extra : ""}`);
  }
};

const H = 3600;
// 可控时钟：evaluate 有 800ms 节流，断言"不跳"必须先跨过这个窗口，
// 否则测到的只是节流、不是回看豁免
const realNow = Date.now.bind(Date);
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
const now = () => Math.floor(Date.now() / 1000);

class HTMLVideoElement {
  constructor(vid, { paused = false, ended = false, readyState = 4 } = {}) {
    this._vid = vid;
    this.paused = paused;
    this.ended = ended;
    this.readyState = readyState;
  }
  closest() {
    return this._vid ? { getAttribute: () => this._vid } : null;
  }
}

class KeyboardEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.key = init.key || "";
    this.code = init.code || "";
    this.keyCode = init.keyCode || 0;
    this.bubbles = !!init.bubbles;
    this.cancelable = !!init.cancelable;
    this.isTrusted = false; // 合成事件一律不可信；真实用户事件由测试显式置 true
  }
}

function boot(opts = {}) {
  clockOffset = 0;
  const syncData = { enabled: true, hours: 720, keywords: [], ...opts };
  const localData = {};
  const lsStore = {};
  const docListeners = {};
  const winListeners = {};
  const intervals = [];
  const dispatched = [];
  const toasts = [];
  let videos = [];

  global.KeyboardEvent = KeyboardEvent;
  global.HTMLVideoElement = HTMLVideoElement;
  global.chrome = {
    runtime: { id: "test-ext" },
    storage: {
      sync: { get: (defaults, cb) => cb({ ...defaults, ...syncData }) },
      local: { set: (o) => Object.assign(localData, o) },
      onChanged: null,
    },
  };
  global.localStorage = {
    getItem: (k) => (k in lsStore ? lsStore[k] : null),
    setItem: (k, v) => {
      lsStore[k] = String(v);
    },
  };
  global.document = {
    documentElement: { dataset: {} },
    body: { appendChild() {} },
    createElement: () => {
      const node = { style: {} };
      Object.defineProperty(node, "textContent", {
        set: (v) => toasts.push(String(v)),
        get: () => "",
      });
      return node;
    },
    addEventListener: (type, fn) => {
      (docListeners[type] = docListeners[type] || []).push(fn);
    },
    dispatchEvent: (ev) => {
      dispatched.push(ev);
      return true;
    },
    querySelectorAll: (sel) => (sel === "video" ? videos : []),
  };
  global.window = {
    addEventListener: (type, fn) => {
      (winListeners[type] = winListeners[type] || []).push(fn);
    },
  };
  global.setInterval = (fn, ms) => {
    intervals.push({ fn, ms });
    return intervals.length;
  };
  global.clearInterval = () => {};
  global.setTimeout = () => 0;
  global.clearTimeout = () => {};

  const src = readFileSync(new URL("./content.js", import.meta.url), "utf8");
  new Function(src)();

  const fire = (type, ev) => (docListeners[type] || []).forEach((fn) => fn(ev));
  return {
    localData,
    toasts,
    setVideos: (v) => {
      videos = v;
    },
    video: (vid, o) => new HTMLVideoElement(vid, o),
    feed: (metas) =>
      (winListeners.message || []).forEach((fn) => fn({ data: { source: "dyfilter", type: "feed", metas } })),
    dropped: (ids) =>
      (winListeners.message || []).forEach((fn) => fn({ data: { source: "dyfilter", type: "dropped", ids } })),
    tick: () => intervals.forEach((i) => i.fn()),
    advance: (ms) => {
      clockOffset += ms;
    },
    play: (v) => fire("play", { target: v }),
    key: (key, trusted) => fire("keydown", { key, isTrusted: trusted }),
    wheel: (deltaY, trusted) => fire("wheel", { deltaY, isTrusted: trusted }),
    downs: () => dispatched.filter((e) => e.type === "keydown" && e.key === "ArrowDown").length,
  };
}

const old = (id, nick = "甲") => ({ id, desc: "旧视频", nick, ct: now() - 800 * H, live: 0 });
const fresh = (id, nick = "乙") => ({ id, desc: "新视频", nick, ct: now() - 1 * H, live: 0 });

// 1. 过期视频在播：兜底合成 ↓ 跳掉
{
  const ctx = boot({ hours: 720 });
  ctx.feed([old("V1")]);
  ctx.setVideos([ctx.video("V1")]);
  ctx.tick();
  ok(ctx.downs() === 1, "过期视频触发一次合成 ArrowDown", `downs=${ctx.downs()}`);
  ok(ctx.localData.skippedCount === 1, "跳过计数上报", String(ctx.localData.skippedCount));
}

// 2. 往回翻到刚被跳过的过期视频：不再跳，并提示已保留
{
  const ctx = boot({ hours: 720 });
  ctx.feed([old("V1"), fresh("V2")]);
  ctx.setVideos([ctx.video("V1")]);
  ctx.tick();
  ok(ctx.downs() === 1, "先跳掉 V1");

  ctx.advance(900);
  ctx.setVideos([ctx.video("V2")]);
  ctx.tick();
  ok(ctx.downs() === 1, "V2 是新的，不跳");

  ctx.advance(900);
  ctx.setVideos([ctx.video("V1")]); // 用户往回翻
  ctx.tick();
  ok(ctx.downs() === 1, "回看 V1 不再被跳走（已跨过节流窗口）", `downs=${ctx.downs()}`);
  ok(ctx.toasts.some((t) => t.includes("已保留这条")), "回看时给出明确提示", ctx.toasts.join(" / "));
  ctx.advance(900);
  ctx.tick();
  ctx.advance(900);
  ctx.tick();
  ok(ctx.downs() === 1, "反复轮询也不跳（豁免是会话级的）");
}

// 3. 豁免只针对回看的那条：再往前翻到别的过期视频照常过滤
{
  const ctx = boot({ hours: 720 });
  ctx.feed([old("V1"), fresh("V2"), old("V3", "丙")]);
  ctx.setVideos([ctx.video("V1")]);
  ctx.tick();
  ctx.advance(900);
  ctx.setVideos([ctx.video("V2")]);
  ctx.tick();
  ctx.advance(900);
  ctx.setVideos([ctx.video("V1")]);
  ctx.tick();
  const before = ctx.downs();
  ctx.advance(900);
  ctx.setVideos([ctx.video("V3")]);
  ctx.tick();
  ok(ctx.downs() === before + 1, "往前翻到 V3 仍然过滤", `downs=${ctx.downs()}`);
}

// 4. 我们自己合成的 ↓ 不算用户回看意图
{
  const ctx = boot({ hours: 720 });
  ctx.feed([old("V1"), old("V2", "丙")]);
  ctx.setVideos([ctx.video("V1")]);
  ctx.tick();
  ctx.advance(900);
  ctx.key("ArrowDown", false); // 合成事件，isTrusted=false
  ctx.setVideos([ctx.video("V2")]);
  ctx.tick();
  ok(ctx.downs() === 2, "合成 ↓ 之后过期视频照跳", `downs=${ctx.downs()}`);
}

// 5. 真实 ↑ 之后切到一条顺序里没出现过的过期视频：也豁免
{
  const ctx = boot({ hours: 720 });
  ctx.feed([old("V1"), old("V9", "壬")]);
  ctx.setVideos([ctx.video("V1")]);
  ctx.tick();
  ctx.advance(900);
  ctx.key("ArrowUp", true);
  ctx.setVideos([ctx.video("V9")]);
  ctx.tick();
  ok(ctx.downs() === 1, "真实 ↑ 后落到的过期视频被保留", `downs=${ctx.downs()}`);
}

// 6. 滚轮向上算回看意图；向下不算
{
  const ctx = boot({ hours: 720 });
  ctx.feed([old("V1"), old("V9", "壬")]);
  ctx.setVideos([ctx.video("V1")]);
  ctx.tick();
  ctx.advance(900);
  ctx.wheel(-120, true);
  ctx.setVideos([ctx.video("V9")]);
  ctx.tick();
  ok(ctx.downs() === 1, "滚轮向上后落到的过期视频被保留", `downs=${ctx.downs()}`);

  const ctx2 = boot({ hours: 720 });
  ctx2.feed([old("A1"), old("A9", "壬")]);
  ctx2.setVideos([ctx2.video("A1")]);
  ctx2.tick();
  ctx2.advance(900);
  ctx2.wheel(120, true);
  ctx2.setVideos([ctx2.video("A9")]);
  ctx2.tick();
  ok(ctx2.downs() === 2, "滚轮向下是往前翻，照常过滤", `downs=${ctx2.downs()}`);
}

// 7. 关键字命中的视频，回看同样豁免
{
  const ctx = boot({ hours: 720, keywords: ["广告"] });
  ctx.feed([
    { id: "K1", desc: "这是广告", nick: "甲", ct: now() - 1 * H, live: 0 },
    fresh("K2"),
  ]);
  ctx.setVideos([ctx.video("K1")]);
  ctx.tick();
  ok(ctx.downs() === 1, "关键字命中先跳掉");
  ctx.advance(900);
  ctx.setVideos([ctx.video("K2")]);
  ctx.tick();
  ctx.advance(900);
  ctx.setVideos([ctx.video("K1")]);
  ctx.tick();
  ok(ctx.downs() === 1, "回看关键字命中的那条也不再跳", `downs=${ctx.downs()}`);
}

// 8. 直播不参与时间判定，但关键字仍生效；回看豁免一视同仁
{
  const ctx = boot({ hours: 1, keywords: ["带货"] });
  ctx.feed([
    { id: "L1", desc: "直播带货中", nick: "主播", ct: now() - 500 * H, live: 1 },
    { id: "L2", desc: "聊天", nick: "主播2", ct: now() - 500 * H, live: 1 },
  ]);
  ctx.setVideos([ctx.video("L1")]);
  ctx.tick();
  ok(ctx.downs() === 1, "直播按关键字跳（不按开播时间）");
  ctx.advance(900);
  ctx.setVideos([ctx.video("L2")]);
  ctx.tick();
  ok(ctx.downs() === 1, "没命中关键字的直播不跳");
  ctx.advance(900);
  ctx.setVideos([ctx.video("L1")]);
  ctx.tick();
  ok(ctx.downs() === 1, "回看直播也豁免");
}

// 9. 总开关关掉：完全不动
{
  const ctx = boot({ enabled: false, hours: 1 });
  ctx.feed([old("V1")]);
  ctx.setVideos([ctx.video("V1")]);
  ctx.tick();
  ok(ctx.downs() === 0, "开关关闭时完全不动", `downs=${ctx.downs()}`);
}

// 10. 接口层漏网的视频：回看同样豁免（豁免优先于漏网判定）
{
  const ctx = boot({ hours: 720 });
  ctx.feed([fresh("D1"), fresh("D2")]);
  ctx.dropped(["D1"]);
  ctx.setVideos([ctx.video("D1")]);
  ctx.tick();
  ok(ctx.downs() === 1, "漏网视频立刻兜底跳掉");
  ctx.advance(900);
  ctx.setVideos([ctx.video("D2")]);
  ctx.tick();
  ctx.advance(900);
  ctx.setVideos([ctx.video("D1")]);
  ctx.tick();
  ok(ctx.downs() === 1, "回看漏网的那条也不再跳", `downs=${ctx.downs()}`);
}

// 11. play 事件路径同样走豁免（不只是 400ms 轮询）
{
  const ctx = boot({ hours: 720 });
  ctx.feed([old("V1"), fresh("V2")]);
  const v1 = ctx.video("V1");
  ctx.setVideos([v1]);
  ctx.play(v1);
  ok(ctx.downs() === 1, "play 事件里就跳掉，不等轮询");
  ctx.advance(900);
  const v2 = ctx.video("V2");
  ctx.setVideos([v2]);
  ctx.play(v2);
  ctx.advance(900);
  ctx.setVideos([v1]);
  ctx.play(v1);
  ok(ctx.downs() === 1, "play 事件里回看也不跳", `downs=${ctx.downs()}`);
}

console.log(fail === 0 ? `ALL PASS (${pass} 条断言)` : `${fail} FAILED / ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);