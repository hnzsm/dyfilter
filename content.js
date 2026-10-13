(() => {
  const LEGACY_DEFAULTS = { enabled: true, hours: null, days: null, keywords: [], blocked: [] };
  let settings = { enabled: true, hours: 720, keywords: [], blocked: [] };
  const metas = new Map();
  let currentVid = null;
  let lastSkipAt = 0;
  let lastSkipVid = null;
  let consecutiveSkips = 0;
  let cooldownUntil = 0;
  let seamlessCount = 0; // 接口层直接删掉的条数
  let skippedCount = 0; // 兜底滚动跳过触发的次数

  const writeConfig = () => {
    const cfg = JSON.stringify({
      enabled: settings.enabled,
      hours: settings.hours,
      keywords: settings.keywords,
      blocked: settings.blocked,
    });
    document.documentElement.dataset.dyConfig = cfg;
    try {
      localStorage.setItem("dyfilter-cfg", cfg);
    } catch (e) {}
  };

  const normalizeHours = (raw) => {
    if (Number.isFinite(raw.hours) && raw.hours > 0) return raw.hours;
    if (Number.isFinite(raw.days) && raw.days > 0) return raw.days * 24; // 从旧"天"单位迁移
    return 720;
  };

  const loadSettings = () =>
    chrome.storage.sync.get(LEGACY_DEFAULTS, (stored) => {
      settings = {
        enabled: stored.enabled !== false,
        hours: normalizeHours(stored),
        keywords: Array.isArray(stored.keywords) ? stored.keywords : [],
        blocked: Array.isArray(stored.blocked) ? stored.blocked.filter((b) => b && (b.sec || b.nick)) : [],
      };
      writeConfig();
    });

  loadSettings();
  if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      loadSettings();
      if (currentVid) evaluate(currentVid, true);
    });
  }

  // 扩展被重载/更新后，页面里旧实例的 content script 会变孤儿，
  // 再调 chrome.* 会抛 "Extension context invalidated"。用它判断并自行拆台。
  const ctxOk = () => {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  };

  let hbTimer = 0;
  // 拉黑要有账号才有意义，未登录时不往抖音自己的菜单里塞这一行。
  // 判据必须是"正向认出未登录"：上一版拿 document.cookie 里的 sessionid 判断，
  // 结果登录态也读不到那个名字，整行菜单被藏掉了（用户实测：右键没菜单）。
  // 现在只在页面上有可见「登录」按钮时才算未登录，判不准就照常给入口。
  const LOGIN_TEXT = /^(登录|注册|手机号登录|扫码登录)$/;
  // 登录墙盖在页面上时，未登录的访客也会看到一个可见的「登录」按钮，
  // 但它挂在弹层里而不是右上角工具条。只认顶栏里那个，判不准就给入口。
  const TOP_BAR_H = 140;
  const loggedIn = () => {
    const nodes = document.querySelectorAll("a, button, [role='button']");
    for (const node of nodes) {
      const text = (node.textContent || "").trim();
      if (!LOGIN_TEXT.test(text)) continue;
      const r = node.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.top < TOP_BAR_H) return false;
    }
    return true;
  };

  const heartbeat = () => {
    if (!ctxOk()) {
      clearInterval(hbTimer);
      return;
    }
    const ds = document.documentElement.dataset;
    chrome.storage.local.set({
      contentTs: Date.now(),
      hookTs: Number(ds.dyMainHook || 0),
      patchMode: ds.dyPatchMode || "",
      cfgHours: settings.hours,
      blockedCount: settings.blocked.length,
      loggedIn: loggedIn() ? 1 : 0,
    });
  };
  // 每次页面加载重新计数，弹窗里的数字只反映当前这一页
  if (ctxOk()) chrome.storage.local.set({ capturedCount: 0, seamlessCount: 0, skippedCount: 0 });
  heartbeat();
  hbTimer = setInterval(heartbeat, 3000);

  const droppedIds = new Set();

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.source !== "dyfilter") return;
    if (d.type === "feed" && Array.isArray(d.metas)) {
      for (const m of d.metas) {
        const id = m && m.id && String(m.id);
        if (id && !metas.has(id)) {
          metas.set(id, m);
          const key = urlKey(m.url);
          if (key && !urlIndex.has(key)) urlIndex.set(key, id);
          const tail = urlTail(m.url);
          if (tail) {
            const n = (tailSeen.get(tail) || 0) + 1;
            tailSeen.set(tail, n);
            // 同一个文件名出现在两张卡片上就作废，不猜是哪条
            if (n === 1) tailIndex.set(tail, id);
            else tailIndex.delete(tail);
          }
          if (id === currentVid) evaluate(currentVid, true);
        }
      }
      reportStats();
    } else if (d.type === "dropped" && Array.isArray(d.ids)) {
      for (const id of d.ids) {
        if (id && !droppedIds.has(id)) {
          droppedIds.add(id);
          seamlessCount += 1;
        }
      }
      reportStats();
    }
  });

  const reportStats = () => {
    if (!ctxOk()) return;
    chrome.storage.local.set({
      capturedCount: metas.size,
      seamlessCount,
      skippedCount,
    });
  };

  function matchRule(vid) {
    // 接口层已删除过却仍在播放 = 漏网，立刻兜底
    if (droppedIds.has(vid)) return { reason: "接口层漏网" };
    const meta = metas.get(vid);
    if (!meta) return null;
    const hit = blacklistedHit(meta);
    if (hit) return { reason: `已拉黑「${hit}」`, meta };
    // 直播卡片的 create_time 是开播时间，不参与"发布超过 N 小时"判定
    if (meta.ct > 0 && !meta.live) {
      const ageHours = (Date.now() / 1000 - meta.ct) / 3600;
      if (ageHours > settings.hours) return { reason: `发布已 ${Math.floor(ageHours)} 小时`, meta };
    }
    const text = `${meta.desc} ${meta.nick}`.toLowerCase();
    for (const kw of settings.keywords) {
      const k = kw.trim().toLowerCase();
      if (k && text.includes(k)) return { reason: `命中关键字「${kw.trim()}」`, meta };
    }
    return null;
  }

  // 拉黑匹配：有 sec_uid 就只认 sec_uid（改名不影响），卡片没带 sec_uid 时退回昵称精确匹配
  function blacklistedHit(meta) {
    const nick = String(meta.nick || "").trim().toLowerCase();
    for (const b of settings.blocked) {
      if (meta.sec && b.sec && meta.sec === b.sec) return b.nick || meta.nick || "该博主";
      if (!meta.sec && nick && b.nick && nick === String(b.nick).trim().toLowerCase()) return b.nick;
    }
    return "";
  }

  function evaluate(vid, force) {
    if (!settings.enabled) return;
    if (Date.now() < cooldownUntil) return;
    const hit = matchRule(vid);
    if (!hit) {
      consecutiveSkips = 0;
      return;
    }
    const now = Date.now();
    // 漏网视频不等节流窗口，立刻跳
    if (!force && !droppedIds.has(vid) && now - lastSkipAt < 800) return;
    if (consecutiveSkips >= 10) {
      cooldownUntil = now + 15000;
      consecutiveSkips = 0;
      toast("当前没有符合条件的视频，稍后继续", 4000);
      return;
    }
    lastSkipAt = now;
    lastSkipVid = vid;
    consecutiveSkips += 1;
    skippedCount += 1;
    reportStats();
    toast(`已过滤：${hit.reason}`, 2000);
    skipToNext();
  }

  function skipToNext() {
    const opts = { bubbles: true, cancelable: true };
    for (const type of ["keydown", "keyup"]) {
      document.dispatchEvent(new KeyboardEvent(type, { ...opts, key: "ArrowDown", code: "ArrowDown", keyCode: 40 }));
    }
  }

  // play 在卡片切换动画中即触发（早于轮询），此刻判定跳过最接近无感；
  // 实测预加载卡片不会触发 play，无需视口守卫
  document.addEventListener(
    "play",
    (e) => {
      const t = e.target;
      if (!(t instanceof HTMLVideoElement)) return;
      const holder = t.closest("[data-e2e-vid]");
      if (!holder) return;
      const vid = holder.getAttribute("data-e2e-vid");
      if (!vid) return;
      currentVid = vid;
      evaluate(vid, vid !== lastSkipVid);
    },
    true
  );

  function findCurrentVid() {
    const v = playingVideo();
    const holder = v && v.closest && v.closest("[data-e2e-vid]");
    return holder ? holder.getAttribute("data-e2e-vid") : null;
  }

  function playingVideos() {
    const out = [];
    for (const v of document.querySelectorAll("video")) {
      if (v.paused || v.ended || v.readyState < 2) continue;
      out.push(v);
    }
    return out;
  }

  function playingVideo() {
    const list = playingVideos();
    if (!list.length) return null;
    if (list.length === 1) return list[0];
    // 预加载的下一条未必处于 paused，按 DOM 顺序取会认错卡片：取视口里占面积最大的
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    let best = null;
    let bestArea = 0;
    for (const v of list) {
      const r = v.getBoundingClientRect ? v.getBoundingClientRect() : null;
      if (!r) continue;
      const w = Math.min(r.right, vw) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      const area = Math.max(0, w) * Math.max(0, h);
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    return best || list[0];
  }

  // 播放地址 → 卡片 id 的索引。抖音的 data-e2e-vid 一改名，接口元数据和 DOM 就对不上号了，
  // 而播放器 src 和接口里的 play_addr 是同一条路径（签名在 query 上），按路径匹配不依赖任何属性名。
  const urlPath = (u) => {
    const s = String(u || "");
    if (!s || s.startsWith("blob:") || s.startsWith("data:")) return "";
    return s.replace(/^[a-z]+:\/\//i, "").split("?")[0].split("#")[0];
  };
  const urlKey = (u) => {
    const segs = urlPath(u).split("/").filter(Boolean);
    return segs.slice(-2).join("/");
  };
  const urlTail = (u) => {
    const segs = urlPath(u).split("/").filter(Boolean);
    const last = segs[segs.length - 1] || "";
    return last.length >= 12 ? last : "";
  };
  const urlIndex = new Map();
  // 只按最后一段匹配时，先确认这段在整页里唯一，避免多张卡片撞成同一条
  const tailSeen = new Map();
  const tailIndex = new Map();

  const userLinkCount = () => {
    try {
      return document.querySelectorAll("a[href*='/user/']").length;
    } catch (e) {
      return -1;
    }
  };

  // 认不出作者时把各环节的计数打出来：是哪一条链断了，看提示就知道，不用猜
  function authorDiag() {
    const v = playingVideo();
    const src = v ? String(v.currentSrc || v.src || "") : "";
    const vid = currentVid || findCurrentVid() || "";
    let sample = "";
    for (const k of metas.keys()) {
      sample = k;
      break;
    }
    return [
      `视频${document.querySelectorAll("video").length}`,
      `在播${playingVideos().length}`,
      `vid=${String(vid).slice(0, 10) || "无"}`,
      `元数据${metas.size}`,
      `样例键=${sample.slice(0, 10) || "无"}`,
      `地址索引${urlIndex.size}/${tailIndex.size}`,
      `src=${urlTail(src).slice(-8) || "无"}`,
      `作者链接${userLinkCount()} ${domNote || "近链ok"}`,
    ].join(" ");
  }

  // 作者链接的 sec_uid：href 形状比 class 稳，抖音改版也不受影响
  function secOfHref(href) {
    const m = /\/user\/([^?#/]+)/.exec(String(href || ""));
    if (!m) return "";
    try {
      return decodeURIComponent(m[1]);
    } catch (e) {
      return m[1];
    }
  }

  // 两个矩形的间距；有重叠时为 0
  const rectGap = (a, b) =>
    Math.max(
      Math.max(a.left - b.right, b.left - a.right, 0),
      Math.max(a.top - b.bottom, b.top - a.bottom, 0)
    );

  // 头像那种 <a><img></a> 是没有文字的，昵称得从 alt / aria-label / 接口元数据里补
  function nickOfLink(a, sec) {
    for (const raw of [a.textContent, a.title, a.getAttribute && a.getAttribute("aria-label")]) {
      const s = String(raw || "").trim();
      if (s) return s;
    }
    const img = a.querySelector && a.querySelector("img");
    const alt = img && String(img.alt || "").trim();
    if (alt) return alt;
    for (const m of metas.values()) if (m && m.sec === sec && m.nick) return String(m.nick).trim();
    return `作者 ${String(sec).slice(0, 8)}`;
  }

  let domNote = "";

  // 作者链接不保证是 video 的祖先节点（抖音把视频和右侧信息栏做成兄弟节点），
  // 所以按"离在播视频最近"来认，而不是沿 parentElement 上溯——上溯到列表容器会抓到别的卡片。
  const NEAR_LINK = 260;
  function authorFromDom() {
    domNote = "";
    const v = playingVideo();
    const r = v && v.getBoundingClientRect && v.getBoundingClientRect();
    if (!r) {
      domNote = "无在播视频";
      return null;
    }
    const near = [];
    for (const a of document.querySelectorAll('a[href*="/user/"]')) {
      const sec = secOfHref(a.href);
      if (!sec) continue;
      const ar = a.getBoundingClientRect ? a.getBoundingClientRect() : null;
      if (!ar || ar.width <= 0 || ar.height <= 0) continue;
      const gap = rectGap(ar, r);
      if (gap > NEAR_LINK) continue;
      near.push({ a, sec, gap });
    }
    if (!near.length) {
      domNote = "附近无作者链接";
      return null;
    }
    near.sort((x, y) => x.gap - y.gap);
    const best = near[0];
    // 压在视频画面上的链接就是这一条的作者；够得着但没压住的，必须明显比对手更近才算数
    const tol = best.gap > 0 ? Math.max(8, best.gap) : 8;
    const rival = near.find((c) => c.sec !== best.sec && c.gap <= best.gap + tol);
    if (rival) {
      domNote = `两个作者链接同距(${Math.round(best.gap)}/${Math.round(rival.gap)}px)`;
      return null;
    }
    return { nick: nickOfLink(best.a, best.sec), sec: best.sec };
  }

  function currentAuthor() {
    const vid = currentVid || findCurrentVid();
    const meta = (vid && metas.get(vid)) || metaByPlayUrl();
    if (meta && meta.nick) return { nick: String(meta.nick).trim(), sec: meta.sec || "", via: "接口" };
    const dom = authorFromDom();
    return dom ? { ...dom, via: "页面" } : null;
  }

  function metaByPlayUrl() {
    const v = playingVideo();
    const src = v && (v.currentSrc || v.src);
    const id = urlIndex.get(urlKey(src)) || tailIndex.get(urlTail(src));
    return id ? metas.get(id) : null;
  }

  let toastEl = null;
  let toastTimer = 0;
  function toast(text, ms) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.style.cssText =
        "position:fixed;left:16px;top:70px;z-index:2147483647;background:rgba(0,0,0,.75);" +
        "color:#fff;padding:8px 14px;border-radius:8px;font-size:14px;pointer-events:none;" +
        "font-family:system-ui,sans-serif;max-width:60vw;";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.style.display = "none"), ms);
  }

  // 拉黑走独立的 blocked 列表（按 sec_uid 认人），不再往关键字里塞昵称。
  function blockCurrentAuthor() {
    const who = currentAuthor();
    if (!who) {
      const diag = authorDiag();
      if (ctxOk()) chrome.storage.local.set({ authorDbg: diag, authorDbgTs: Date.now() });
      toast(`没认出手上这条的作者：${diag}`, 6000);
      return;
    }
    chrome.storage.sync.get(LEGACY_DEFAULTS, (stored) => {
      if (!ctxOk() || chrome.runtime.lastError) return;
      const list = Array.isArray(stored.blocked) ? stored.blocked.filter((b) => b && (b.sec || b.nick)) : [];
      const lower = who.nick.toLowerCase();
      if (list.some((b) => (who.sec && b.sec === who.sec) || String(b.nick || "").toLowerCase() === lower)) {
        toast(`「${who.nick}」已经拉黑了`, 2500);
        return;
      }
      chrome.storage.sync.set(
        {
          enabled: stored.enabled !== false,
          hours: normalizeHours(stored),
          keywords: Array.isArray(stored.keywords) ? stored.keywords : [],
          blocked: [...list, { sec: who.sec, nick: who.nick }],
        },
        () => {
          if (!ctxOk() || chrome.runtime.lastError) return;
          toast(`已拉黑：${who.nick}`, 2500);
        }
      );
    });
  }

  if (chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== "dyfilter-block-author") return;
      blockCurrentAuthor();
      sendResponse({ ok: true });
    });
  }

  // 播放器区域被抖音自己 preventDefault 接管，弹的是页面画的菜单，浏览器原生菜单看不到。
  // 这里在它的菜单弹出后补一行「拉黑该作者」，样式直接克隆它自己的一行。
  const MENU_LABEL = "拉黑该作者";
  let menuAnchor = null; // 最近一次右键的位置，用来认出"刚弹出来的就是那个菜单"

  const rowsOf = (el) => {
    const pick = (node) => Array.from(node.children).filter((c) => (c.textContent || "").trim());
    const kids = pick(el);
    if (kids.length >= 2) return kids;
    if (el.children.length === 1) {
      const inner = pick(el.children[0]);
      if (inner.length >= 2) return inner;
    }
    return [];
  };

  const looksLikeMenu = (el) => {
    if (!el || el.nodeType !== 1 || !menuAnchor) return false;
    if (!loggedIn()) return false;
    if (el.dataset.dyAuthorMenu) return false;
    if (Date.now() - menuAnchor.at > 1500) return false;
    const pos = window.getComputedStyle ? window.getComputedStyle(el).position : "";
    if (pos !== "fixed" && pos !== "absolute") return false;
    const r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 24) return false;
    // 菜单一般贴着鼠标位置展开，留 80px 容差应对边界翻转
    if (Math.abs(r.left - menuAnchor.x) > 80 || Math.abs(r.top - menuAnchor.y) > 80) return false;
    return rowsOf(el).length >= 2;
  };

  const closeMenu = (menuEl) => {
    // 模拟一次"菜单外按下"，交给页面自己的关闭逻辑；直接 remove 它的节点可能让它下次弹不出来
    for (const type of ["pointerdown", "mousedown", "click"]) {
      document.body.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
  };

  function injectInto(menuEl) {
    const rows = rowsOf(menuEl);
    if (!rows.length) return;
    menuEl.dataset.dyAuthorMenu = "1";
    const row = rows[rows.length - 1].cloneNode(true);
    row.textContent = MENU_LABEL;
    rows[0].parentNode.appendChild(row);
    row.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(menuEl);
      blockCurrentAuthor();
    });
  }

  const adopt = (node) => {
    if (!node || node.nodeType !== 1) return false;
    if (looksLikeMenu(node)) {
      injectInto(node);
      return true;
    }
    for (const child of Array.from(node.children)) {
      if (looksLikeMenu(child)) {
        injectInto(child);
        return true;
      }
    }
    return false;
  };

  // 路径一：菜单节点是新插入 DOM 的（React portal 常见）
  if (window.MutationObserver) {
    new window.MutationObserver((records) => {
      for (const rec of records) {
        for (const node of Array.from(rec.addedNodes)) if (adopt(node)) return;
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // 路径二：菜单节点被复用、只切 display，用鼠标点处的元素栈往上找
  function probeMenu() {
    if (!menuAnchor || !document.elementsFromPoint) return;
    const stack = document.elementsFromPoint(menuAnchor.x, menuAnchor.y) || [];
    for (const el of stack) {
      let cur = el;
      for (let depth = 0; cur && depth < 6; depth += 1, cur = cur.parentElement) {
        if (looksLikeMenu(cur)) {
          injectInto(cur);
          return;
        }
      }
    }
  }

  document.addEventListener(
    "contextmenu",
    (e) => {
      menuAnchor = { x: e.clientX, y: e.clientY, at: Date.now() };
      for (const ms of [60, 180, 400]) setTimeout(probeMenu, ms);
    },
    true
  );

  setInterval(() => {
    const vid = findCurrentVid();
    if (!vid) return;
    currentVid = vid;
    evaluate(vid);
  }, 400);
})();
