const activeTabs = new Map();

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => activeTabs.set(windowId, tabId));
chrome.tabs.onRemoved.addListener((tabId, { windowId }) => { if (activeTabs.get(windowId) === tabId) activeTabs.delete(windowId); });
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'getActiveCaptureTab') return false;
  chrome.windows.getLastFocused({ populate: false }, (window) => {
    const windowId = window?.id;
    const tracked = windowId == null ? undefined : activeTabs.get(windowId);
    if (tracked) return sendResponse({ tabId: tracked, windowId });
    const query = windowId == null ? { active: true, lastFocusedWindow: true } : { active: true, windowId };
    chrome.tabs.query(query, (tabs) => {
      const tab = tabs[0];
      if (tab?.id != null) activeTabs.set(tab.windowId, tab.id);
      sendResponse(tab?.id == null ? null : { tabId: tab.id, windowId: tab.windowId });
    });
  });
  return true;
});
