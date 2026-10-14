import { readFileSync } from "fs";

const els = {};
for (const id of ["enabled", "hours", "keywords", "save", "hint", "stats"]) {
  els[id] = {
    id,
    value: "",
    checked: false,
    textContent: "",
    style: {},
    handlers: {},
    addEventListener(type, fn) {
      this.handlers[type] = fn;
    },
    click() {
      this.handlers.click && this.handlers.click();
    },
  };
}
global.document = {
  getElementById: (id) => els[id],
  activeElement: els.save,
};
const syncData = { enabled: true, hours: 168, keywords: ["直播"] };
const localData = {
  capturedCount: 33,
  seamlessCount: 21,
  skippedCount: 2,
  hookTs: Date.now(),
  contentTs: Date.now(),
  patchMode: "proto",
  cfgHours: 168,
};
let saved = null;
global.chrome = {
  runtime: { id: "ext", lastError: null },
  storage: {
    sync: {
      get: (def, cb) => cb({ ...def, ...syncData }),
      set: (obj, cb) => {
        saved = obj;
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

// 保存按钮
els.enabled.checked = true;
els.hours.value = "48";
els.keywords.value = "直播\n 广告 ";
els.save.click();
console.log("[已保存] " + JSON.stringify(saved) + " hint=" + els.hint.textContent);
