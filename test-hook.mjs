import { readFileSync } from "fs";

const received = [];
global.window = global;
global.location = { origin: "https://www.douyin.com" };
global.postMessage = (msg) => received.push(msg);
window.postMessage = (msg) => received.push(msg);
const intervals = [];
global.setInterval = (fn) => {
  intervals.push(fn);
  return intervals.length;
};
const dataset = {};
global.document = { documentElement: { dataset }, addEventListener() {}, body: {} };
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => (store[k] = String(v)),
};

const sentXhrs = [];
class XMLHttpRequest {
  constructor() {
    this.readyState = 0;
    this.responseType = "";
    this._raw = "";
    this.status = 0;
  }
  open(method, url) {
    this._method = method;
    this._url = url;
  }
  setRequestHeader(k, v) {
    (this._headers = this._headers || {})[String(k).toLowerCase()] = v;
  }
  send(body) {
    this._body = body == null ? "" : String(body);
    sentXhrs.push(this);
  }
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
const item = (id, ageH, desc = "", nick = "", sec = "") => ({
  aweme_id: id,
  desc,
  author: { nickname: nick, ...(sec ? { sec_uid: sec } : {}) },
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
const setCfg = (hours, keywords = [], blocked = []) =>
  localStorage.setItem("dyfilter-cfg", JSON.stringify({ enabled: true, hours, keywords, blocked }));

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

// 直播卡片：字段路径不同（owner/room_id/live_title），且没有发布时间
const liveCard = (id, nick, title, extra = {}) => ({
  aweme_id: id,
  aweme_type: 2,
  room_id: String(Number(id.slice(1)) + 100),
  owner: { nickname: nick, sec_uid: extra.sec || "" },
  extra_info: { live_title: title },
  ...extra,
});
setCfg(1, ["xx主播"]);
r = read(
  URL_FEED,
  JSON.stringify({
    aweme_list: [liveCard("L1", "xx主播", "深夜聊天"), liveCard("L2", "别的台", "唱歌"), item("v1", 9999)],
  })
);
t("直播命中作者名被删", !r.ids.includes("L1"), r.ids.join(","));
t("未命中关键字的直播保留", r.ids.includes("L2"), r.ids.join(","));
setCfg(1, []);
r = read(URL_FEED, JSON.stringify({ aweme_list: [liveCard("L8", "甲", "跳舞"), liveCard("L9", "乙", "唱歌"), item("v1", 9999)] }));
t("直播不被时间阈值误杀", r.ids.includes("L8") && r.ids.includes("L9"), r.ids.join(","));
t("同页视频仍按时间删除", !r.ids.includes("v1"), r.ids.join(","));

setCfg(1, ["深夜"]);
r = read(URL_FEED, JSON.stringify({ aweme_list: [liveCard("L3", "某台", "深夜电台"), item("v2", 0)] }));
t("直播命中房间标题被删", !r.ids.includes("L3"), r.ids.join(","));

setCfg(1, ["主播"]);
r = read(URL_FEED, JSON.stringify({ aweme_list: [liveCard("L4", "xx主播", "聊天"), liveCard("L5", "yy主播", "唱歌")] }));
t("整页只剩直播且全命中时不改写", JSON.stringify(r.ids) === '["L4","L5"]', r.ids.join(","));

// 非卡片数组不受影响
setCfg(168, []);
const noise = {
  aweme_list: [item("n1", 1), item("n2", 9000)],
  extra: [{ url: "a" }, { url: "b" }],
};
r = read(URL_FEED, JSON.stringify(noise));
t("普通对象数组不被误删", r.out.extra.length === 2, JSON.stringify(r.out.extra));
t("卡片数组正常过滤", JSON.stringify(r.ids) === '["n1"]', r.ids.join(","));

// 直播卡片也可能从 live/feed 兄弟路径下发
setCfg(168, ["xx主播"]);
r = read(
  "https://www.douyin.com/aweme/v1/web/live/feed/?x=1",
  JSON.stringify({ aweme_list: [liveCard("L6", "xx主播", "聊天"), liveCard("L7", "正常台", "跳舞")] })
);
t("live/feed 路径同样过滤", JSON.stringify(r.ids) === '["L7"]', r.ids.join(","));

// 拉黑名单：优先按 sec_uid 认人，改名不影响；卡片没带 sec_uid 时按昵称精确匹配
setCfg(99999, [], [{ sec: "SEC_A", nick: "旧名字" }]);
r = read(
  URL_FEED,
  feed([item("b1", 1, "正常", "改叫新名字了", "SEC_A"), item("b2", 1, "正常", "路人甲", "SEC_B")])
);
t("按 sec_uid 拉黑（昵称已改也拦得住）", !r.ids.includes("b1"), r.ids.join(","));
t("未拉黑的 sec_uid 不受影响", r.ids.includes("b2"), r.ids.join(","));

setCfg(99999, [], [{ sec: "", nick: "甲" }]);
r = read(URL_FEED, feed([item("b3", 1, "正常", "甲"), item("b4", 1, "正常", "甲方爸爸")]));
t("无 sec_uid 时按昵称精确拉黑", !r.ids.includes("b3"), r.ids.join(","));
t("昵称精确匹配不做子串（不误伤同名前缀）", r.ids.includes("b4"), r.ids.join(","));

setCfg(99999, [], [{ sec: "SEC_L", nick: "某主播" }]);
r = read(URL_FEED, JSON.stringify({ aweme_list: [liveCard("L10", "某主播", "聊天", { sec: "SEC_L" }), liveCard("L11", "别的台", "唱歌", { sec: "SEC_M" })] }));
t("直播按 sec_uid 拉黑", !r.ids.includes("L10"), r.ids.join(","));
t("未拉黑的直播保留", r.ids.includes("L11"), r.ids.join(","));

// 元数据镜像：content.js 挂载晚于首页响应，postMessage 会整个错过，所以再落一份 localStorage
setCfg(99999);
store["dyfilter-feed"] = undefined;
delete store["dyfilter-feed"];
r = read(URL_FEED, feed([item("m1", 1, "标题一", "博主一", "SEC_M1"), item("m2", 1, "标题二", "博主二", "SEC_M2")]));
const mirrored = JSON.parse(store["dyfilter-feed"] || "[]");
t("采集结果落进 localStorage 镜像", mirrored.length === 2, JSON.stringify(mirrored.map((m) => m.id)));
t("镜像带得上 sec_uid 与播放地址", mirrored[0].sec === "SEC_M1" && typeof mirrored[0].url === "string", JSON.stringify(mirrored[0]));
r = read(URL_FEED, feed([item("m1", 1, "标题一", "博主一", "SEC_M1"), item("m3", 1, "标题三", "博主三", "SEC_M3")]));
const mirrored2 = JSON.parse(store["dyfilter-feed"] || "[]");
t("镜像按 id 去重、跨页累加", mirrored2.map((m) => m.id).join(",") === "m1,m2,m3", mirrored2.map((m) => m.id).join(","));

// 拉黑请求由 MAIN world 代发（isolated world 裸 fetch 会被 WAF 403）
store["dyfilter-block-req"] = JSON.stringify({ id: "r1", sec: "SEC_Z" });
intervals.forEach((fn) => fn());
const bx = sentXhrs[sentXhrs.length - 1];
t(
  "拉黑走页面自己的 XHR + 实测端点",
  !!bx && bx._method === "POST" && /\/aweme\/v1\/web\/user\/block\//.test(bx._url),
  bx ? `${bx._method} ${bx._url.slice(0, 60)}` : "没发出请求"
);
t(
  "body 带上实测抓到的字段",
  !!bx && /block_type=0/.test(bx._body) && /sec_user_id=SEC_Z/.test(bx._body) && /source=0/.test(bx._body),
  bx ? bx._body : ""
);
t("带上登录 cookie 与表单头", !!bx && bx.withCredentials === true && /x-www-form-urlencoded/.test((bx._headers || {})["content-type"] || ""), JSON.stringify(bx && bx._headers));
if (bx) {
  bx.status = 200;
  bx.readyState = 4;
  bx._raw = JSON.stringify({ status_code: 0 });
  bx.onreadystatechange();
}
const bres = JSON.parse(store["dyfilter-block-res"] || "{}");
t("回包按 id 写回通道给 content", bres.id === "r1" && bres.status === 200 && /status_code/.test(bres.text), store["dyfilter-block-res"]);
const before = sentXhrs.length;
intervals.forEach((fn) => fn());
t("同一条请求不重复提交", sentXhrs.length === before, `又发了 ${sentXhrs.length - before} 次`);

console.log(results.join("\n"));
console.log(results.some((x) => x.startsWith("FAIL")) ? "SOME FAILED" : "ALL PASS");
