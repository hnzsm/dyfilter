import { readFileSync } from "fs";

const els = {};
const mkEl = (id) => {
  const node = {
    id,
    value: "",
    checked: false,
    title: "",
    className: "",
    style: {},
    children: [],
    handlers: {},
    addEventListener(type, fn) {
      this.handlers[type] = fn;
    },
    click() {
      this.handlers.click && this.handlers.click();
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  };
  let text = "";
  Object.defineProperty(node, "textContent", {
    get: () => text,
    // 真实 DOM 里给 textContent 赋值会清空子节点，popup 重绘列表靠的就是这一句
    set: (v) => {
      text = v;
      if (v === "") node.children.length = 0;
    },
  });
  return node;
};
for (const id of ["enabled", "hours", "keywords", "save", "hint", "stats", "blocked", "blocked-count", "blocked-empty"]) {
  els[id] = mkEl(id);
}
global.document = {
  getElementById: (id) => els[id],
  activeElement: els.save,
  createElement: () => mkEl("new"),
};
const syncData = {
  enabled: true,
  hours: 168,
  keywords: ["直播"],
  blocked: [
    { sec: "SEC_A", nick: "某博主" },
    { sec: "", nick: "只有昵称的博主" },
  ],
};
const localData = {
  capturedCount: 33,
  seamlessCount: 21,
  skippedCount: 2,
  hookTs: Date.now(),
  contentTs: Date.now(),
  patchMode: "proto",
  cfgHours: 168,
  loggedIn: 1,
};
let saved = null;
global.chrome = {
  runtime: { id: "ext", lastError: null },
  storage: {
    sync: {
      get: (def, cb) => cb({ ...def, ...syncData }),
      set: (obj, cb) => {
        saved = obj;
        Object.assign(syncData, obj);
        cb && cb();
      },
    },
    local: { get: (def, cb) => cb({ ...def, ...localData }) },
  },
};
const timers = [];
global.setInterval = (fn) => {
  timers.push(fn);
  return 1;
};
global.clearInterval = () => {};
global.clearTimeout = () => {};
global.setTimeout = () => 2;

const src = readFileSync(new URL("./popup.js", import.meta.url), "utf8");
new Function(src)();

console.log("[stats]\n" + els.stats.textContent);
console.log("[hours input] " + els.hours.value + " [keywords] " + els.keywords.value);
const chipText = () => els.blocked.children.map((li) => `${li.children[0].textContent}${li.children[0].title ? "/" + li.children[0].title : ""}`).join(" , ");
console.log("[blocked] " + els.blocked.children.length + " 个 chip: " + chipText());
console.log("[blocked-count] " + els["blocked-count"].textContent + " [empty hidden] " + (els["blocked-empty"].style.display === "none"));

// 移除第一个 chip
els.blocked.children[0].children[1].click();
console.log("[移除后] " + JSON.stringify(saved) + " 剩余 chip: " + chipText());

// 场景：接口层改写没生效
localData.seamlessCount = 0;
localData.patchMode = "";
timers[0]();
console.log("[stats/未生效]\n" + els.stats.textContent);

// 场景：设置与生效值不一致
localData.seamlessCount = 5;
localData.cfgHours = 720;
timers[0]();
console.log("[stats/不一致]\n" + els.stats.textContent);

// 场景：未登录
localData.cfgHours = 168;
localData.loggedIn = 0;
timers[0]();
console.log("[stats/未登录]\n" + els.stats.textContent);

// 场景：拉黑没认出作者，诊断行要原样出现在弹窗里
localData.loggedIn = 1;
localData.authorDbg = "视频3 在播1 vid=7693890338 元数据0/镜像0 样例键=无 地址索引0/0 src=AFj7DEPE 作者链接12 附近无作者链接";
localData.authorDbgTs = Date.now();
timers[0]();
const dbgLine = els.stats.textContent.split("\n").find((l) => l.includes("没认出作者"));
if (!dbgLine) throw new Error("诊断行没进弹窗");
if (!dbgLine.includes("元数据0/镜像0")) throw new Error("诊断行内容被截断: " + dbgLine);
console.log("[stats/拉黑诊断]\n" + els.stats.textContent);

// 超过 5 分钟的旧诊断不再刷屏
localData.authorDbgTs = Date.now() - 6 * 60 * 1000;
timers[0]();
if (els.stats.textContent.includes("没认出作者")) throw new Error("过期诊断仍在显示");

// 场景：账号级拉黑接口没通过，三个端点的真实回包要原样出现在弹窗里
localData.blockDbg = "403/code8(invalid a_bogus)";
localData.blockDbgTs = Date.now();
timers[0]();
const blockLine = els.stats.textContent.split("\n").find((l) => l.includes("拉黑接口没通过"));
if (!blockLine) throw new Error("接口诊断行没进弹窗");
if (!blockLine.includes("invalid a_bogus")) throw new Error("接口诊断行被截断: " + blockLine);
console.log("[stats/接口诊断]\n" + els.stats.textContent);

localData.blockDbgTs = Date.now() - 6 * 60 * 1000;
timers[0]();
if (els.stats.textContent.includes("拉黑接口没通过")) throw new Error("过期接口诊断仍在显示");

// 保存按钮：只写自己的字段，不能把 blocked 冲掉
localData.loggedIn = 1;
els.enabled.checked = true;
els.hours.value = "48";
els.keywords.value = "直播\n 广告 ";
els.save.click();
console.log("[已保存] " + JSON.stringify(saved) + " hint=" + els.hint.textContent);
console.log("[blocked 仍在] " + JSON.stringify(syncData.blocked));
