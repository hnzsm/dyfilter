(() => {
  if (window.__dyfilterHooked) return;
  window.__dyfilterHooked = true;

  const FEED_URL_RE = /\/aweme\/v1\/web\/(tab\/feed|general\/feed|hotboard\/feed|feed)\/|\/multi\/aweme/;
  const beat = () => {
    document.documentElement.dataset.dyMainHook = String(Date.now());
  };
  beat();
  setInterval(beat, 10000);

  // 配置来源优先级：localStorage（跨世界共享、document_start 即就绪）> dataset > 默认值。
  const CFG_DEFAULT = { enabled: true, hours: 720, keywords: [] };
  const sanitize = (c) => ({
    enabled: c && typeof c.enabled === "boolean" ? c.enabled : CFG_DEFAULT.enabled,
    hours: c && Number.isFinite(c.hours) && c.hours > 0 ? c.hours : CFG_DEFAULT.hours,
    keywords: c && Array.isArray(c.keywords) ? c.keywords : [],
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

  const toMeta = (a) => {
    const id = a && (a.aweme_id || a.item_id);
    if (!id) return null;
    return {
      id: String(id),
      desc: a.desc || "",
      nick: (a.author && a.author.nickname) || "",
      ct: Number(a.create_time) || 0,
    };
  };

  const walk = (node, out, depth) => {
    if (!node || depth > 12 || out.length > 200) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, out, depth + 1);
      return;
    }
    if (typeof node === "object") {
      const m = toMeta(node);
      if (m && m.ct) out.push(m);
      for (const k in node) walk(node[k], out, depth + 1);
    }
  };

  const isBlocked = (a, now, cfg) => {
    const ct = Number(a && a.create_time) || 0;
    if (ct > 0 && (now - ct) / 3600 > cfg.hours) return true;
    const text = `${(a && a.desc) || ""} ${((a && a.author && a.author.nickname) || "")}`.toLowerCase();
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

  const isAweme = (o) =>
    !!o && typeof o === "object" && (o.aweme_id || o.item_id) && Number(o.create_time) > 0;

  // 递归删掉任意层级"作品数组"里命中的条目。各接口字段名不一致（aweme_list / item_list / data / list），
  // 且卡片可能是 {aweme:{...}} / {aweme_info:{...}} 包装，所以只按对象形状识别，
  // 避免抖音换字段名后接口层过滤静默失效。先统计后落刀：中途改坏会让删空保护失效。
  const filterJson = (json) => {
    const cfg = getCfg();
    if (!cfg.enabled || !json || typeof json !== "object") return null;
    const now = Date.now() / 1000;
    const dropped = [];
    const seen = new Set();
    const marks = [];
    let kept = 0;
    let keptTop = -1;
    const awemeOf = (o) => {
      if (!o || typeof o !== "object") return null;
      if (isAweme(o)) return o;
      for (const k in o) if (isAweme(o[k])) return o[k];
      return null;
    };
    const dive = (node, depth, key) => {
      if (!node || typeof node !== "object" || depth > 10) return;
      if (Array.isArray(node)) {
        if (key === "aweme_list" && keptTop < 0) keptTop = 0;
        for (let i = 0; i < node.length; i++) {
          const a = awemeOf(node[i]);
          if (!a) {
            dive(node[i], depth + 1, key);
            continue;
          }
          if (!isBlocked(a, now, cfg)) {
            kept += 1;
            if (key === "aweme_list") keptTop += 1;
            continue;
          }
          const id = String(a.aweme_id || a.item_id);
          if (!seen.has(id)) {
            seen.add(id);
            dropped.push(id);
          }
          marks.push({ arr: node, i });
        }
        return;
      }
      for (const k in node) dive(node[k], depth + 1, k);
    };
    dive(json, 0, "");
    // 实测把每页删空会让播放器卡死不再续拉，所以只在还能留下内容时改写
    if (!dropped.length || (keptTop >= 0 ? keptTop : kept) <= 0) return null;
    const groups = new Map();
    for (const m of marks) {
      const list = groups.get(m.arr) || [];
      list.push(m.i);
      groups.set(m.arr, list);
    }
    for (const [arr, idxs] of groups) {
      for (const i of idxs.sort((a, b) => b - a)) arr.splice(i, 1);
    }
    return { json, dropped };
  };

  // 采集元数据（供 content.js 兜底判定），每个实例只做一次
  const collect = (xhr, payload) => {
    if (xhr.__dyCollected) return;
    const json = asJson(payload);
    if (!json) return;
    xhr.__dyCollected = true;
    const out = [];
    walk(json, out, 0);
    const seen = new Set();
    const metas = out.filter((m) => m && !seen.has(m.id) && seen.add(m.id));
    if (metas.length) post({ type: "feed", metas });
  };

  // 改写 + 采集；isText 决定返回字符串还是对象
  const process = (xhr, payload, isText) => {
    if (xhr.__dyRawSeen === payload && xhr.__dyResult) {
      const cached = xhr.__dyResult;
      if (isText) return typeof cached === "string" ? cached : JSON.stringify(cached);
      return typeof cached === "string" ? JSON.parse(cached) : cached;
    }
    xhr.__dyRawSeen = payload;
    const json = asJson(payload);
    collect(xhr, json);
    const filtered = json ? filterJson(json) : null;
    if (filtered) post({ type: "dropped", ids: filtered.dropped });
    const result = filtered ? filtered.json : json;
    if (!result) return payload; // 解析不出来，原样返回
    xhr.__dyResult = result;
    return isText ? JSON.stringify(result) : result;
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
    collect(xhr, payload);
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
                collect({ __dyCollected: false }, json);
                const filtered = filterJson(json);
                if (filtered) {
                  post({ type: "dropped", ids: filtered.dropped });
                  const headers = new Headers(res.headers);
                  headers.delete("content-length");
                  headers.delete("content-encoding");
                  return new Response(JSON.stringify(filtered.json), {
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
})();
