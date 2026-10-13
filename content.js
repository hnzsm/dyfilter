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
  // 读不到 cookie（被内核挡掉）时不作为依据，宁可用不可少。
  const LOGIN_COOKIE = /(?:^|;\s*)(?:sessionid|session_t|sid_guard)=/;
  const loggedIn = () => {
    const raw = typeof document.cookie === "string" ? document.cookie : "";
    return raw ? LOGIN_COOKIE.test(raw) : true;
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
        if (m && m.id && !metas.has(m.id)) {
          metas.set(String(m.id), m);
          if (String(m.id) === currentVid) evaluate(currentVid, true);
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
    const holder = v && v.closest("[data-e2e-vid]");
    return holder ? holder.getAttribute("data-e2e-vid") : null;
  }

  function playingVideo() {
    for (const v of document.querySelectorAll("video")) {
      if (v.paused || v.ended || v.readyState < 2) continue;
      return v;
    }
    return null;
  }

  // 接口元数据没认出来时退回页面 DOM：从播放中的 video 往上找作者链接，
  // 抖音的作者链接形如 /user/<sec_uid>，昵称就是链接文字。
  function authorFromDom() {
    let node = playingVideo();
    for (let up = 0; node && up < 8; up += 1, node = node.parentElement) {
      const link = node.querySelector && node.querySelector('a[href*="/user/"]');
      if (!link) continue;
      const nick = (link.textContent || "").trim();
      if (!nick) return null;
      const m = /\/user\/([^?#/]+)/.exec(link.href || "");
      let sec = "";
      try {
        sec = m ? decodeURIComponent(m[1]) : "";
      } catch (e) {
        sec = m ? m[1] : "";
      }
      return { nick, sec };
    }
    return null;
  }

  function currentAuthor() {
    const vid = currentVid || findCurrentVid();
    const meta = vid ? metas.get(vid) : null;
    if (meta && meta.nick) return { nick: String(meta.nick).trim(), sec: meta.sec || "", via: "接口" };
    const dom = authorFromDom();
    return dom ? { ...dom, via: "页面" } : null;
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
      toast(`没认出手上这条的作者（已捕获 ${metas.size} 条），等它播起来再试`, 3500);
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
