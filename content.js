(() => {
  const LEGACY_DEFAULTS = { enabled: true, hours: null, days: null, keywords: [] };
  let settings = { enabled: true, hours: 720, keywords: [] };
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
    if (meta.ct > 0) {
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
    for (const v of document.querySelectorAll("video")) {
      if (v.paused || v.ended || v.readyState < 2) continue;
      const holder = v.closest("[data-e2e-vid]");
      if (holder) return holder.getAttribute("data-e2e-vid");
    }
    return null;
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

  setInterval(() => {
    const vid = findCurrentVid();
    if (!vid) return;
    currentVid = vid;
    evaluate(vid);
  }, 400);
})();
