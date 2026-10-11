import { readFileSync } from "fs";

const received = [];
global.window = global;
global.location = { origin: "https://www.douyin.com" };
global.postMessage = (msg) => received.push(msg);
window.postMessage = (msg) => received.push(msg);
global.setInterval = () => 0;
const dataset = {};
global.document = { documentElement: { dataset }, addEventListener() {}, body: {} };
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => (store[k] = String(v)),
};

class XMLHttpRequest {
  constructor() {
    this.readyState = 0;
    this.responseType = "";
    this._raw = "";
  }
  open(method, url) {
    this._url = url;
  }
  send() {}
  addEventListener() {}
  get responseText() {
    return this.readyState !== 4 ? "" : this._raw;
  }
  get response() {
    return this.readyState !== 4 ? null : this._raw;
  }
}
global.XMLHttpRequest = XMLHttpRequest;

const src = readFileSync(new URL("./hook.js", import.meta.url), "utf8");
new Function(src)();

const H = 3600;
const now = Math.floor(Date.now() / 1000);
const item = (id, ageH, desc = "", nick = "") => ({
  aweme_id: id,
  desc,
  author: { nickname: nick },
  create_time: now - ageH * H,
});
const feed = (list) => JSON.stringify({ aweme_list: list, has_more: 1, status_code: 0 });

const read = (url, payload, asObject = false) => {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url);
  xhr.readyState = 4;
  xhr._raw = asObject ? payload : payload;
  const before = received.length;
  const out = asObject ? xhr.response : JSON.parse(xhr.responseText);
  const msgs = received.slice(before);
  const pick = (o) =>
    o.aweme_id ||
    o.item_id ||
    (o.aweme && (o.aweme.aweme_id || o.aweme.item_id)) ||
    (o.aweme_info && (o.aweme_info.aweme_id || o.aweme_info.item_id));
  return { out, ids: (out.aweme_list || []).map(pick), msgs };
};

const URL_FEED = "https://www.douyin.com/aweme/v1/web/tab/feed/?x=1";
const setCfg = (hours, keywords = []) =>
  localStorage.setItem("dyfilter-cfg", JSON.stringify({ enabled: true, hours, keywords }));

const results = [];
const t = (name, cond, extra = "") => results.push(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " | " + extra : ""}`);

t("patchMode=proto", dataset.dyPatchMode === "proto", dataset.dyPatchMode);

setCfg(168);
let r = read(URL_FEED, feed([item("a", 10), item("b", 400), item("c", 20), item("d", 1000)]));
t("扁平 aweme_list 删掉超阈值项", JSON.stringify(r.ids) === '["a","c"]', r.ids.join(","));
t("删除项上报 dropped", r.msgs.some((m) => m.type === "dropped" && m.ids.includes("b") && m.ids.includes("d")));
t("feed 采集上报", r.msgs.some((m) => m.type === "feed" && m.metas.length === 4));

// 整页全命中：不改写（返回空会卡死播放器）
const before2 = received.length;
r = read(URL_FEED, feed([item("e", 500), item("f", 900)]));
t("整页全命中时不改写", JSON.stringify(r.ids) === '["e","f"]', r.ids.join(","));
t("整页全命中时不上报 dropped", !received.slice(before2).some((m) => m.type === "dropped"));

// 深层/换字段名的列表结构也能过滤
r = read(URL_FEED, JSON.stringify({ data: { item_list: [item("g", 5), item("h", 800)] }, cursor: 1 }));
t(
  "嵌套 item_list 也能过滤",
  JSON.stringify(r.out.data.item_list.map((a) => a.aweme_id)) === '["g"]',
  JSON.stringify(r.out.data.item_list.map((a) => a.aweme_id))
);

const deep = {
  section_list: [{ aweme: item("i", 1) }, { aweme: item("j", 999) }],
  aweme_list: [item("k", 2), item("l", 777)],
};
r = read(URL_FEED, JSON.stringify(deep));
t("aweme_list 深层过滤", JSON.stringify(r.ids) === '["k"]', r.ids.join(","));
t("section_list 里的命中项也被删", r.msgs.some((m) => m.type === "dropped" && m.ids.includes("j") && m.ids.includes("l")));

// 包装卡片（aweme_info）+ 全页命中：不得被改成空列表
const wrap = { aweme_list: [{ aweme_info: item("w1", 1) }, { aweme_info: item("w2", 9000) }] };
r = read(URL_FEED, JSON.stringify(wrap));
t("aweme_info 包装识别", JSON.stringify(r.ids) === '["w1"]', r.ids.join(","));
r = read(URL_FEED, JSON.stringify({ aweme_list: [{ aweme_info: item("w3", 9000) }, { aweme_info: item("w4", 8000) }] }));
t("全页命中时 aweme_list 保持完整", JSON.stringify(r.ids) === '["w3","w4"]', r.ids.join(","));

// 关键字屏蔽
setCfg(99999, ["广告"]);
r = read(URL_FEED, feed([item("m", 1, "正常内容"), item("n", 1, "这是个广告"), item("o", 1, "", "品牌广告号")]));
t("关键字命中 desc", !r.ids.includes("n"), r.ids.join(","));
t("关键字命中 nickname", !r.ids.includes("o"), r.ids.join(","));

// 关闭开关后不动响应
setCfg(0.0001);
localStorage.setItem("dyfilter-cfg", JSON.stringify({ enabled: false, hours: 1, keywords: [] }));
r = read(URL_FEED, feed([item("p", 5000), item("q", 1)]));
t("enabled=false 时不改写", JSON.stringify(r.ids) === '["p","q"]', r.ids.join(","));

// responseType=json：页面直接拿对象，也要改写
setCfg(168);
const xo = new XMLHttpRequest();
xo.open("GET", URL_FEED);
xo.readyState = 4;
xo.responseType = "json";
xo._raw = { aweme_list: [item("u1", 1), item("u2", 9000)] };
const objOut = xo.response;
t(
  "responseType=json 也改写",
  Array.isArray(objOut.aweme_list) && objOut.aweme_list.length === 1 && objOut.aweme_list[0].aweme_id === "u1",
  JSON.stringify(objOut.aweme_list && objOut.aweme_list.map((a) => a.aweme_id))
);

// 非 feed 接口不碰
setCfg(168);
const other = new XMLHttpRequest();
other.open("GET", "https://www.douyin.com/aweme/v1/web/comment/list/");
other.readyState = 4;
other._raw = feed([item("z", 5000)]);
t("非 feed URL 原样返回", other.responseText === feed([item("z", 5000)]));

// 重复读取走缓存且结果一致
const xhr3 = new XMLHttpRequest();
xhr3.open("GET", URL_FEED);
xhr3.readyState = 4;
xhr3._raw = feed([item("s", 1), item("tt", 9000)]);
const first = JSON.parse(xhr3.responseText);
const second = JSON.parse(xhr3.responseText);
t("两次读取结果一致", JSON.stringify(first) === JSON.stringify(second), JSON.stringify(second.aweme_list.map((a) => a.aweme_id)));

console.log(results.join("\n"));
console.log(results.some((x) => x.startsWith("FAIL")) ? "SOME FAILED" : "ALL PASS");
