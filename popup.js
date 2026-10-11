const $ = (id) => document.getElementById(id);

// 扩展刚被重载时，旧弹窗上下文失效，chrome.storage 内部读 chrome.runtime.id 会抛 TypeError
const safe = (fn, failMsg) => {
  try {
    if (!chrome.runtime || !chrome.runtime.id) throw new Error("stale");
    fn();
  } catch (e) {
    const el = $("stats");
    if (el) el.textContent = failMsg;
  }
};

const normalizeHours = (s) => {
  if (Number.isFinite(s.hours) && s.hours > 0) return s.hours;
  if (Number.isFinite(s.days) && s.days > 0) return s.days * 24;
  return 720;
};

safe(() => {
  chrome.storage.sync.get({ enabled: true, hours: null, days: null, keywords: [] }, (s) => {
    $("enabled").checked = s.enabled !== false;
    $("hours").value = normalizeHours(s);
    $("keywords").value = (s.keywords || []).join("\n");
  });
}, "扩展刚被重载：请关闭弹窗，再点一次工具栏图标打开");

// 计数每秒自刷新，不用关弹窗重开
let statsTimer = 0;
const renderStats = () => {
  try {
    if (!chrome.runtime || !chrome.runtime.id) throw new Error("stale");
  } catch (e) {
    clearInterval(statsTimer);
    $("stats").textContent = "扩展刚被重载：请关闭弹窗，再点一次工具栏图标打开";
    return;
  }
  chrome.storage.local.get(
    { capturedCount: 0, seamlessCount: 0, skippedCount: 0, hookTs: 0, contentTs: 0, patchMode: "", cfgHours: 0 },
    (st) => {
      if (chrome.runtime.lastError) return;
      const now = Date.now();
      const ok = (ts, windowMs) => ts > 0 && now - ts < windowMs;
      const mark = (alive) => (alive ? "正常" : "未运行");
      const lines = [
        `过滤脚本：${mark(ok(st.contentTs, 15000))}　页面注入：${mark(st.hookTs > 0)}`,
        `已捕获 ${st.capturedCount} 个视频`,
        `无痕屏蔽 ${st.seamlessCount} 个　滚动跳过 ${st.skippedCount} 个`,
        `页面生效阈值：${st.cfgHours} 小时`,
      ];
      if (!ok(st.contentTs, 15000)) {
        lines.push("请先在抖音页按 F12 打开控制台，把下方两项检查的结果发我：");
        lines.push("1. document.documentElement.dataset.dyMainHook");
        lines.push("2. 控制台左上角上下文里是否出现本扩展名");
      } else if (st.hookTs === 0) {
        lines.push("页面注入未运行：请确认已点击扩展的刷新按钮并刷新了抖音页面");
      } else if (st.capturedCount === 0) {
        lines.push("若多刷几个视频后仍为 0，说明接口路径变了，把弹窗截图发我");
      } else if (st.seamlessCount === 0) {
        lines.push(
          `无痕屏蔽为 0：接口层改写未生效（补丁模式 ${st.patchMode || "未知"}），目前只靠滚动跳过兜底。请把这一行截图发我。`
        );
      } else if (
        document.activeElement !== $("hours") &&
        Number($("hours").value) > 0 &&
        Number($("hours").value) !== st.cfgHours
      ) {
        lines.push("生效阈值和设置不一致：请点保存，再刷新抖音页。");
      }
      $("stats").textContent = lines.join("\n");
      $("stats").style.whiteSpace = "pre-wrap";
    }
  );
};
renderStats();
statsTimer = setInterval(renderStats, 1000);

let hintTimer = 0;
function showHint(text) {
  $("hint").textContent = text;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => ($("hint").textContent = ""), 1500);
}

$("save").addEventListener("click", () => {
  const hours = Math.max(1, Math.min(87600, Number($("hours").value) || 720));
  const keywords = $("keywords").value.split("\n").map((k) => k.trim()).filter(Boolean);
  safe(() => {
    chrome.storage.sync.set({ enabled: $("enabled").checked, hours, keywords }, () => {
      if (chrome.runtime.lastError) return;
      showHint("已保存");
    });
  }, "扩展刚被重载：请关闭弹窗重开后再保存");
});
