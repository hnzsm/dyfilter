const MENU_ID = "dyfilter-block-author";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "拉黑该作者",
    contexts: ["page", "video"],
    // 只在抖音页出现，其它站点看不到这一项
    documentUrlPatterns: ["https://www.douyin.com/*"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!info || info.menuItemId !== MENU_ID) return;
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "dyfilter-block-author" }, () => {
    void chrome.runtime.lastError; // 页面还没注入 content script
  });
});
