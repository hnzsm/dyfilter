(() => {
  if (window.__dyfilterHooked) return;
  window.__dyfilterHooked = true;

  // 首页推荐流的直播卡片可能走 live/feed 这类兄弟路径，按 */feed/ 统一放行
  const FEED_URL_RE = /\/aweme\/v1\/web\/[a-z/]*feed\/|\/multi\/aweme/;
  const beat = () => {
    document.documentElement.dataset.dyMainHook = String(Date.now());
  };
  beat();
  setInterval(beat, 10000);

  // 配置来源优先级：localStorage（跨世界共享、document_start 即就绪）> dataset > 默认值。
  const CFG_DEFAULT = { enabled: true, hours: 720, keywords: [], blocked: [] };
  const sanitize = (c) => ({
    enabled: c && typeof c.enabled === "boolean" ? c.enabled : CFG_DEFAULT.enabled,
    hours: c && Number.isFinite(c.hours) && c.hours > 0 ? c.hours : CFG_DEFAULT.hours,
    keywords: c && Array.isArray(c.keywords) ? c.keywords : [],
    blocked: c && Array.isArray(c.blocked) ? c.blocked.filter((b) => b && (b.sec || b.nick)) : [],
  });
  const getCfg = () => {
    try {
      const ls = localStorage.getItem("dyfilter-cfg");
      if (ls) return sanitize(JSON.parse(ls));
    } catch (e) {}
    try {
      const ds = document.documentElement.dataset.dyConfig;
      if (ds) return sanitize(JSON.parse(ds));
    } catch (e) {}
    return CFG_DEFAULT;
  };

  const post = (msg) => {
    beat();
    window.postMessage({ source: "dyfilter", ...msg }, window.location.origin);
  };

  // 卡片识别一律按形状取值：视频在 desc / author.nickname，直播卡片字段路径不同
  // （标题常在 title / live_title / status，主播在 owner / user / anchor），
  // 写死单一路径会让直播卡片整批漏掉。
  const ID_KEYS = ["aweme_id", "item_id", "room_id", "id_str"];
  const SUB_KEYS = ["aweme", "aweme_info", "author", "owner", "user", "anchor", "room", "room_data", "extra_info", "data"];
  const TITLE_KEYS = ["desc", "title", "live_title", "status", "content"];
  const NICK_KEYS = ["nickname", "nick_name", "author_nickname"];
  const SEC_KEYS = ["sec_uid", "sec_user_id", "user_sec_uid", "uid_str"];

  const isObj = (o) => !!o && typeof o === "object" && !Array.isArray(o);
  const strOf = (o, keys) => {
    if (!isObj(o)) return "";
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  const fieldOf = (o, keys) => {
    const direct = strOf(o, keys);
    if (direct) return direct;
    for (const k of SUB_KEYS) {
      const v = strOf(o && o[k], keys);
      if (v) return v;
    }
    return "";
  };
  const idOf = (o) => {
    if (!isObj(o)) return "";
    for (const k of ID_KEYS) {
      const v = o[k];
      if (typeof v === "string" && v) return v;
      if (typeof v === "number" && v) return String(v);
    }
    for (const k of SUB_KEYS) {
      const v = idOf(o[k]);
      if (v) return v;
    }
    return "";
  };
  const timeOf = (o) => Number(o && (o.create_time || o.create_time_seconds)) || 0;
  const isLive = (o) =>
    isObj(o) && (o.aweme_type === 2 || !!o.room_id || isObj(o.room_data) || isObj(o.room) || !!strOf(o, ["live_type"]));
  const isCard = (o) =>
    isObj(o) && !!idOf(o) && (timeOf(o) > 0 || o.aweme_type !== undefined || isLive(o) || !!fieldOf(o, TITLE_KEYS) || !!fieldOf(o, NICK_KEYS));

  const cardTitle = (o) => fieldOf(o, TITLE_KEYS);
  const cardNick = (o) => fieldOf(o, NICK_KEYS);
  const cardSec = (o) => fieldOf(o, SEC_KEYS);
  // 播放地址：content.js 用它把"正在播的 video"对回接口卡片，不依赖 data-e2e-vid
  const playUrlOf = (o) => {
    const v = isObj(o) && o.video;
    if (!isObj(v)) return "";
    const lists = [
      isObj(v.play_addr) && v.play_addr.url_list,
      v.url_list,
      isObj(v.download_addr) && v.download_addr.url_list,
    ];
    for (const list of lists) if (Array.isArray(list) && typeof list[0] === "string") return list[0];
    return "";
  };
  const cardMeta = (o) => ({
    id: idOf(o),
    desc: cardTitle(o),
    nick: cardNick(o),
    sec: cardSec(o),
    url: playUrlOf(o),
    ct: timeOf(o),
    live: isLive(o) ? 1 : 0,
  });

  // 拉黑：优先按 sec_uid 精确匹配（改名不影响）；卡片没带 sec_uid 时退回昵称精确匹配。
  const isBlacklisted = (m, cfg) => {
    const nick = m.nick.toLowerCase();
    for (const b of cfg.blocked) {
      if (m.sec && b.sec && m.sec === b.sec) return true;
      if (!m.sec && nick && b.nick && nick === String(b.nick).trim().toLowerCase()) return true;
    }
    return false;
  };

  const isBlocked = (o, now, cfg) => {
    const m = cardMeta(o);
    if (isBlacklisted(m, cfg)) return true;
    // 直播没有"发布时间"可言（create_time 是开播时间），只受关键字屏蔽
    if (!m.live && m.ct > 0 && (now - m.ct) / 3600 > cfg.hours) return true;
    const text = `${m.desc} ${m.nick}`.toLowerCase();
    for (const kw of cfg.keywords) {
      const k = String(kw).trim().toLowerCase();
      if (k && text.includes(k)) return true;
    }
    return false;
  };

  const asJson = (payload) => {
    if (typeof payload === "string") {
      if (payload[0] !== "{") return null;
      try {
        return JSON.parse(payload);
      } catch (e) {
        return null;
      }
    }
    return payload && typeof payload === "object" ? payload : null;
  };

  const unwrapCard = (el) => {
    if (!isObj(el)) return null;
    if (isCard(el)) return el;
    for (const k in el) if (isCard(el[k])) return el[k]; // {aweme:{}} / {aweme_info:{}} 包装
    return null;
  };

  // 一次遍历同时供采集和过滤使用。只认"卡片数组"（数组里过半元素是卡片），
  // 避免误伤响应里其它带 id 的对象数组。
  const scanCards = (json) => {
    const found = [];
    const dive = (node, depth, key) => {
      if (!node || typeof node !== "object" || depth > 10) return;
      if (Array.isArray(node)) {
        const hits = [];
        for (let i = 0; i < node.length; i++) {
          const card = unwrapCard(node[i]);
          if (card) hits.push({ card, i });
          else dive(node[i], depth + 1, key);
        }
        if (hits.length && hits.length * 2 >= node.length) {
          for (const h of hits) found.push({ card: h.card, arr: node, i: h.i, top: key === "aweme_list" });
        }
        return;
      }
      if (isObj(node)) for (const k in node) dive(node[k], depth + 1, k);
    };
    dive(json, 0, "");
    return found;
  };

  const metasOf = (cards) => {
    const out = [];
    const seen = new Set();
    for (const c of cards) {
      const m = cardMeta(c.card);
      if (m.id && !seen.has(m.id)) {
        seen.add(m.id);
        out.push(m);
      }
    }
    return out;
  };

  // 返回 { json, dropped }；不改写的两种情况：没有命中、改写完会一张不剩
  const filterCards = (cards) => {
    const cfg = getCfg();
    if (!cfg.enabled || !cards.length) return null;
    const now = Date.now() / 1000;
    const dropped = [];
    const seen = new Set();
    const marks = [];
    let kept = 0;
    let keptTop = 0;
    let sawTop = false;
    for (const c of cards) {
      if (c.top) sawTop = true;
      if (!isBlocked(c.card, now, cfg)) {
        kept += 1;
        if (c.top) keptTop += 1;
        continue;
      }
      const id = idOf(c.card);
      if (!seen.has(id)) {
        seen.add(id);
        dropped.push(id);
      }
      marks.push(c);
    }
    // 实测把每页删空会让播放器卡死不再续拉
    if (!dropped.length || (sawTop ? keptTop : kept) <= 0) return null;
    const groups = new Map();
    for (const m of marks) {
      const list = groups.get(m.arr) || [];
      list.push(m.i);
      groups.set(m.arr, list);
    }
    for (const [arr, idxs] of groups) {
      for (const i of idxs.sort((a, b) => b - a)) arr.splice(i, 1);
    }
    return { dropped };
  };

  // content.js 在 document_idle 才挂载，首页那批响应早于它的监听器，postMessage 错过就补不回来了。
  // 所以再往 localStorage 落一份（和配置同一条已验证可靠的跨世界通道），content 侧按需回读。
  const MIRROR_MAX = 120;
  const mirror = (metas) => {
    try {
      const prev = JSON.parse(localStorage.getItem("dyfilter-feed") || "[]");
      const list = Array.isArray(prev) ? prev : [];
      const seen = new Set(list.map((m) => String(m && m.id)));
      for (const m of metas) {
        const k = String(m && m.id);
        if (k && k !== "undefined" && !seen.has(k)) {
          seen.add(k);
          list.push(m);
        }
      }
      localStorage.setItem("dyfilter-feed", JSON.stringify(list.slice(-MIRROR_MAX)));
    } catch (e) {}
  };

  // 采集元数据（供 content.js 兜底判定），每个实例只做一次
  const collect = (xhr, cards) => {
    if (xhr.__dyCollected) return;
    if (!cards.length) return;
    xhr.__dyCollected = true;
    const metas = metasOf(cards);
    if (metas.length) {
      post({ type: "feed", metas });
      mirror(metas);
    }
  };

  const process = (xhr, payload, isText) => {
    if (xhr.__dyRawSeen === payload && xhr.__dyResult) {
      const cached = xhr.__dyResult;
      if (isText) return typeof cached === "string" ? cached : JSON.stringify(cached);
      return typeof cached === "string" ? JSON.parse(cached) : cached;
    }
    xhr.__dyRawSeen = payload;
    const json = asJson(payload);
    if (!json) return payload;
    const cards = scanCards(json);
    collect(xhr, cards);
    const filtered = filterCards(cards);
    if (filtered) post({ type: "dropped", ids: filtered.dropped });
    xhr.__dyResult = json;
    return isText ? JSON.stringify(json) : json;
  };

  const descText = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "responseText");
  const descResp = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "response");
  const nativeText = descText && descText.get;
  const nativeResp = descResp && descResp.get;

  const safeCall = (fn, xhr) => {
    try {
      return fn ? fn.call(xhr) : undefined;
    } catch (e) {
      return undefined; // responseType=json/blob 时读 responseText 会抛，属正常
    }
  };

  // 优先原型级：一次覆盖所有实例，页面怎么读都拦得到；失败再退回逐个实例打补丁
  const patchProto = (name, native, accept) => {
    if (!native) return false;
    try {
      Object.defineProperty(XMLHttpRequest.prototype, name, {
        configurable: true,
        get() {
          const raw = safeCall(native, this);
          if (!this.__dyFeed || this.readyState !== 4 || !accept(raw)) return raw;
          return process(this, raw, typeof raw === "string");
        },
      });
      return true;
    } catch (e) {
      return false;
    }
  };

  const protoOk = [
    patchProto("responseText", nativeText, (r) => typeof r === "string"),
    patchProto("response", nativeResp, (r) => r != null),
  ].some(Boolean);

  const patchInstance = (xhr) => {
    if (xhr.__dyPatched) return;
    xhr.__dyPatched = true;
    // 拿不到原生 getter 就绝不覆盖，否则会把页面读取变成 undefined
    if (nativeText) {
      try {
        Object.defineProperty(xhr, "responseText", {
          configurable: true,
          get() {
            const raw = safeCall(nativeText, this);
            if (this.readyState !== 4 || typeof raw !== "string") return raw;
            return process(this, raw, true);
          },
        });
      } catch (e) {}
    }
    if (nativeResp) {
      try {
        Object.defineProperty(xhr, "response", {
          configurable: true,
          get() {
            const raw = safeCall(nativeResp, this);
            if (this.readyState !== 4 || raw == null) return raw;
            return process(this, raw, typeof raw === "string");
          },
        });
      } catch (e) {}
    }
  };

  // 独立于页面读取方式的兜底采集
  const sniff = (xhr) => {
    if (xhr.__dyCollected) return;
    let payload = safeCall(nativeResp, xhr);
    if (payload == null && (xhr.responseType === "" || xhr.responseType === "text")) {
      payload = safeCall(nativeText, xhr);
    }
    const json = asJson(payload);
    if (json) collect(xhr, scanCards(json));
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__dyUrl = String(url || "");
    this.__dyFeed = FEED_URL_RE.test(this.__dyUrl);
    if (this.__dyFeed && !protoOk) patchInstance(this);
    return nativeOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__dyFeed) {
      this.addEventListener("load", () => sniff(this));
    }
    return nativeSend.apply(this, args);
  };

  const nativeFetch = window.fetch;
  window.fetch = (...args) => {
    const p = nativeFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
      if (FEED_URL_RE.test(url)) {
        return p.then((res) => {
          return res
            .clone()
            .text()
            .then((t) => {
              const json = asJson(t);
              if (json) {
                const cards = scanCards(json);
                collect({ __dyCollected: false }, cards);
                const filtered = filterCards(cards);
                if (filtered) {
                  post({ type: "dropped", ids: filtered.dropped });
                  const headers = new Headers(res.headers);
                  headers.delete("content-length");
                  headers.delete("content-encoding");
                  return new Response(JSON.stringify(json), {
                    status: res.status,
                    statusText: res.statusText,
                    headers,
                  });
                }
              }
              return res;
            })
            .catch(() => res);
        });
      }
    } catch (e) {}
    return p;
  };

  document.documentElement.dataset.dyPatchMode = protoOk ? "proto" : "instance";

  // 拉黑请求必须由页面自己的网络层发出：抖音的安全 SDK 包了 fetch/XHR 并补风控头，
  // 扩展 isolated world 里的裸 fetch 会被 WAF 直接 403（实测连 JSON 体都没有）。
  // 通道：content.js 写 localStorage['dyfilter-block-req']，这里取走、发请求、把回包写进 'dyfilter-block-res'。
  const BLOCK_REQ = "dyfilter-block-req";
  const BLOCK_RES = "dyfilter-block-res";
  const BLOCK_PATH = "/aweme/v1/web/user/block/";
  const BLOCK_QUERY =
    "device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=2&update_version_code=170400&version_code=170400&version_name=17.4.0&cookie_enabled=true&platform=PC";
  let lastBlockId = "";

  const runBlock = (req) => {
    const done = (status, text) => {
      try {
        localStorage.setItem(BLOCK_RES, JSON.stringify({ id: req.id, status, text: String(text || "").slice(0, 400) }));
      } catch (e) {}
    };
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${BLOCK_PATH}?${BLOCK_QUERY}`, true);
      xhr.withCredentials = true;
      xhr.setRequestHeader("content-type", "application/x-www-form-urlencoded");
      xhr.onreadystatechange = () => {
        if (xhr.readyState === 4) done(xhr.status, xhr.responseText);
      };
      xhr.onerror = () => done(0, "");
      xhr.send(`block_type=0&sec_user_id=${encodeURIComponent(req.sec)}&source=0`);
    } catch (e) {
      done(-1, String((e && e.message) || e).slice(0, 120));
    }
  };

  setInterval(() => {
    let req = null;
    try {
      const raw = localStorage.getItem(BLOCK_REQ);
      if (raw) req = JSON.parse(raw);
    } catch (e) {}
    if (!req || !req.id || !req.sec || req.id === lastBlockId) return;
    lastBlockId = req.id;
    runBlock(req);
  }, 250);
})();
