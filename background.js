/**
 * ReconcileIQ Chrome Extension — Background Service Worker v2.0.4
 *
 * Architecture change from v1.x:
 * - REMOVED: captureVisibleTab (caused "all_urls permission" errors on cross-domain tabs)
 * - REMOVED: page navigation approach (navigated the user's tab, breaking their session)
 * - NEW: chrome.debugger + Page.printToPDF — works on ANY page, any domain
 * - NEW: background tab approach for Capture All — opens each invoice in a hidden tab,
 *   captures PDF, closes it. User's current tab is NEVER touched.
 */

// ─── Upload a PDF (base64 string) to ReconcileIQ ─────────────────────────────
async function uploadPdf({ base64, vendor, sourceUrl, pageTitle }) {
  const { apiToken, apiBase } = await chrome.storage.local.get(["apiToken", "apiBase"]);
  if (!apiToken || !apiBase) {
    return { ok: false, error: "Not configured. Open the extension popup and set your API token." };
  }
  const byteString = atob(base64);
  const ab = new ArrayBuffer(byteString.length);
  const ia = new Uint8Array(ab);
  for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
  const blob = new Blob([ab], { type: "application/pdf" });
  const formData = new FormData();
  formData.append("file", blob, "receipt.pdf");
  formData.append("vendor", vendor || "");
  formData.append("sourceUrl", sourceUrl || "");
  formData.append("pageTitle", pageTitle || "");
  try {
    const res = await fetch(`${apiBase}/api/extension/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}` },
      body: formData,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    return await res.json();
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ─── Upload a screenshot (base64 dataURL) to ReconcileIQ (legacy fallback) ────
async function uploadScreenshot({ dataUrl, vendor, sourceUrl, pageTitle }) {
  const { apiToken, apiBase } = await chrome.storage.local.get(["apiToken", "apiBase"]);
  if (!apiToken || !apiBase) {
    return { ok: false, error: "Not configured. Open the extension popup and set your API token." };
  }
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const formData = new FormData();
  formData.append("file", blob, "screenshot.png");
  formData.append("vendor", vendor || "");
  formData.append("sourceUrl", sourceUrl || "");
  formData.append("pageTitle", pageTitle || "");
  try {
    const res = await fetch(`${apiBase}/api/extension/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}` },
      body: formData,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    return await res.json();
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ─── Ping to verify the token is valid ────────────────────────────────────────
async function pingApi(apiToken, apiBase) {
  try {
    const res = await fetch(`${apiBase}/api/extension/ping`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ─── Capture a tab as PDF using chrome.debugger + Page.printToPDF ─────────────
// Works on any URL — no host_permissions or activeTab needed.
// Attaches debugger briefly (~1-2 seconds), prints PDF, detaches.
async function captureTabAsPdf(tabId) {
  // Detach first in case a previous run left it attached
  try { await chrome.debugger.detach({ tabId }); } catch {}

  await chrome.debugger.attach({ tabId }, "1.3");
  try {
    const result = await chrome.debugger.sendCommand({ tabId }, "Page.printToPDF", {
      printBackground: true,
      paperWidth: 8.5,
      paperHeight: 11,
      marginTop: 0.4,
      marginBottom: 0.4,
      marginLeft: 0.4,
      marginRight: 0.4,
      scale: 0.9,
    });
    return result.data; // base64-encoded PDF
  } finally {
    try { await chrome.debugger.detach({ tabId }); } catch {}
  }
}

// ─── Wait for a tab to finish loading ────────────────────────────────────────
function waitForTabLoad(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // timeout — proceed anyway
    }, timeoutMs);
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ─── Get extra wait time for known slow SPA pages ─────────────────────────────
// Some pages (YouTube TV, Google, etc.) render billing content asynchronously
// well after document load. We wait longer for these.
function getExtraWaitMs(url) {
  if (!url) return 2500;
  if (/tv\.youtube\.com|youtube\.com\/paid_memberships/i.test(url)) return 7000;
  if (/google\.com/i.test(url)) return 5000;
  if (/microsoft\.com|office\.com|azure\.com/i.test(url)) return 4000;
  if (/apple\.com|icloud\.com/i.test(url)) return 4000;
  return 2500; // default
}

// ─── Sleep helper ─────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Send message to popup (best-effort) ──────────────────────────────────────
function sendToPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {}); // popup may be closed — ignore
}

// ─── Single-tab PDF capture and upload ────────────────────────────────────────
async function captureAndUploadTab({ tabId, vendor, sourceUrl, pageTitle }) {
  try {
    const base64 = await captureTabAsPdf(tabId);
    return await uploadPdf({ base64, vendor, sourceUrl, pageTitle });
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ─── Background-tab Capture All ──────────────────────────────────────────────
// Opens each invoice URL in a hidden background tab, captures PDF, closes it.
// The user's current tab is NEVER navigated or disturbed.
async function runBackgroundTabCaptureAll({ hrefs, vendor, baseUrl, waitAfterOpen }) {
  const total = hrefs.length;
  let captured = 0;
  let failed = 0;
  const results = []; // array of { label, receiptId, receiptUrl, error }

  await chrome.storage.local.set({
    captureAllAbort: false,
    captureAllRunning: true,
    captureAllResults: [],
    captureAllProgress: null,
  });

  for (let i = 0; i < hrefs.length; i++) {
    // Check abort flag
    const state = await chrome.storage.local.get("captureAllAbort");
    if (state.captureAllAbort) break;

    // Persist progress
    await chrome.storage.local.set({
      captureAllResults: results,
      captureAllProgress: { current: i, total, captured, failed },
    });
    sendToPopup({ type: "CAPTURE_ALL_PROGRESS", current: i, total, captured, failed, results });

    const href = hrefs[i];
    let label = `Receipt ${i + 1}`;
    let bgTabId = null;

    try {
      // Open invoice URL in a hidden background tab (active: false = user doesn't see it)
      const bgTab = await chrome.tabs.create({ url: href, active: false });
      bgTabId = bgTab.id;

      // Wait for page to fully load
      await waitForTabLoad(bgTabId, 20000);
      // Extra wait for JS-rendered pages — use per-URL timing for slow SPAs
      const extraWait = Math.max(waitAfterOpen || 2500, getExtraWaitMs(href));
      await sleep(extraWait);

      // Get page title for labeling
      const tab = await chrome.tabs.get(bgTabId);
      label = tab.title || label;

      // Capture as PDF via debugger API
      const base64 = await captureTabAsPdf(bgTabId);

      // Upload to ReconcileIQ
      const result = await uploadPdf({ base64, vendor, sourceUrl: href, pageTitle: label });

      if (result?.ok) {
        captured++;
        const receiptId = result.receiptId || result.id;
        results.push({
          label,
          receiptId,
          receiptUrl: receiptId && baseUrl
            ? `${baseUrl}/receipts?highlight=${receiptId}`
            : (baseUrl ? `${baseUrl}/receipts` : null),
          error: null,
        });
      } else {
        failed++;
        results.push({ label, receiptId: null, receiptUrl: null, error: result?.error || "Upload failed" });
        console.warn("[ReconcileIQ BG] Upload failed:", href, result?.error);
      }
    } catch (e) {
      console.warn("[ReconcileIQ BG] Error at index", i, href, e.message);
      failed++;
      results.push({ label, receiptId: null, receiptUrl: null, error: e.message });
    } finally {
      // Always close the background tab
      if (bgTabId) {
        try { await chrome.tabs.remove(bgTabId); } catch {}
      }
    }

    // Small delay between captures to avoid rate limiting
    await sleep(500);
  }

  // Persist final results and clear running flag
  await chrome.storage.local.set({
    captureAllAbort: false,
    captureAllRunning: false,
    captureAllResults: results,
  });

  sendToPopup({ type: "CAPTURE_ALL_DONE", captured, failed, total, baseUrl, results });
}

// ─── Message handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // PDF capture of the current tab (replaces captureVisibleTab screenshot)
  if (message.type === "CAPTURE_TAB_PDF") {
    const { tabId, vendor, sourceUrl, pageTitle } = message.payload;
    captureAndUploadTab({ tabId, vendor, sourceUrl, pageTitle }).then(sendResponse);
    return true;
  }

  // Legacy screenshot upload (kept for backward compatibility with old content.js)
  if (message.type === "UPLOAD_SCREENSHOT") {
    uploadScreenshot(message.payload).then(sendResponse);
    return true;
  }

  // PDF upload from content script (e.g. intercepted PDF link click)
  if (message.type === "UPLOAD_PDF") {
    uploadPdf(message.payload).then(sendResponse);
    return true;
  }

  // API ping
  if (message.type === "PING_API") {
    const { apiToken, apiBase } = message.payload;
    pingApi(apiToken, apiBase).then(sendResponse);
    return true;
  }

  // Capture All — background tab approach (primary)
  if (message.type === "BACKGROUND_TAB_CAPTURE_ALL") {
    runBackgroundTabCaptureAll(message.payload);
    sendResponse({ ok: true, started: true });
    return true;
  }

  // Abort Capture All
  if (message.type === "CAPTURE_ALL_ABORT") {
    chrome.storage.local.set({ captureAllAbort: true });
    sendResponse({ ok: true });
    return true;
  }

  // Legacy page-nav messages — now route to background tab approach
  if (message.type === "PAGE_NAV_CAPTURE_ALL") {
    runBackgroundTabCaptureAll(message.payload);
    sendResponse({ ok: true, started: true });
    return true;
  }

  if (message.type === "PAGE_NAV_CAPTURE_ABORT") {
    chrome.storage.local.set({ captureAllAbort: true });
    sendResponse({ ok: true });
    return true;
  }
});
