/**
 * ReconcileIQ Chrome Extension — Popup v2.0.0
 *
 * Architecture change from v1.x:
 * - Single capture: sends CAPTURE_TAB_PDF to background worker (no content script needed)
 * - Capture All: asks content script for invoice URLs, then sends BACKGROUND_TAB_CAPTURE_ALL
 *   to background worker which opens hidden background tabs (user's tab is never disturbed)
 * - "Capture All" button now shows on ANY page (not just hardcoded billing pages)
 *   because the content script detects invoice links universally
 */

// ─── Vendor name map (for display only) ──────────────────────────────────────
const VENDOR_MAP = [
  { pattern: /tv\.youtube\.com/, vendor: "YouTube TV" },
  { pattern: /youtube\.com\/paid_memberships/, vendor: "YouTube Premium" },
  { pattern: /netflix\.com/, vendor: "Netflix" },
  { pattern: /vysor\.io/, vendor: "Vysor" },
  { pattern: /hulu\.com/, vendor: "Hulu" },
  { pattern: /disneyplus\.com/, vendor: "Disney+" },
  { pattern: /paramountplus\.com/, vendor: "Paramount+" },
  { pattern: /max\.com/, vendor: "Max (HBO)" },
  { pattern: /hbomax\.com/, vendor: "Max (HBO)" },
  { pattern: /billing\.stripe\.com/, vendor: "Stripe Billing" },
  { pattern: /chargebee\.com/, vendor: "Chargebee" },
  { pattern: /recurly\.com/, vendor: "Recurly" },
];

function detectVendorFromUrl(url) {
  for (const { pattern, vendor } of VENDOR_MAP) {
    if (pattern.test(url)) return vendor;
  }
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host.split(".")[0];
  } catch { return "Receipt"; }
}

function matchVendorFromList(url, vendorList) {
  if (!vendorList || !vendorList.length) return null;
  try {
    const currentHostname = new URL(url).hostname.replace(/^www\./, "");
    for (const vendor of vendorList) {
      if (!vendor.billingUrl) continue;
      try {
        const vendorHostname = new URL(vendor.billingUrl).hostname.replace(/^www\./, "");
        if (currentHostname === vendorHostname || url.startsWith(vendor.billingUrl)) {
          return vendor.vendorName;
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return null;
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function openTab(url) {
  if (!url) return;
  chrome.tabs.create({ url });
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const statusSubtext = document.getElementById("status-subtext");
const pageUrl = document.getElementById("page-url");
const pageTitle = document.getElementById("page-title");
const vendorBadge = document.getElementById("vendor-badge");
const btnCapture = document.getElementById("btn-capture");
const captureLabel = document.getElementById("capture-label");
const btnCaptureAll = document.getElementById("btn-capture-all");
const captureAllLabel = document.getElementById("capture-all-label");
const btnStop = document.getElementById("btn-stop");
const resultCard = document.getElementById("result-card");
const progressWrap = document.getElementById("progress-wrap");
const progressFill = document.getElementById("progress-fill");
const progressPct = document.getElementById("progress-pct");
const progressStatus = document.getElementById("progress-status");
const progressCounts = document.getElementById("progress-counts");
const activityPanel = document.getElementById("activity-panel");
const activityCount = document.getElementById("activity-count");
const activityList = document.getElementById("activity-list");
const activityViewAll = document.getElementById("activity-view-all");
const configSection = document.getElementById("config-section");
const inputToken = document.getElementById("input-token");
const inputBase = document.getElementById("input-base");
const btnSave = document.getElementById("btn-save");
const btnClear = document.getElementById("btn-clear");
const linkSettings = document.getElementById("link-settings");

// ─── State ────────────────────────────────────────────────────────────────────
let isConnected = false;
let isCapturingAll = false;
let currentTab = null;
let currentVendor = "Receipt";
let userVendorList = [];
let captureResults = [];

// ─── Status display ───────────────────────────────────────────────────────────
function setStatus(type, text, subtext) {
  statusDot.className = "status-dot " + type;
  statusText.textContent = text;
  statusSubtext.textContent = subtext || "";
}

// ─── Result card ──────────────────────────────────────────────────────────────
function showResult(message, isError, linkUrl) {
  resultCard.style.display = "block";
  resultCard.className = "result-card " + (isError ? "err" : "ok");
  resultCard.innerHTML = "";
  if (linkUrl) {
    const span = document.createElement("span");
    span.textContent = message + " ";
    const a = document.createElement("a");
    a.textContent = "View \u2192";
    a.href = "#";
    a.style.cssText = "color:#93c5fd;text-decoration:underline;cursor:pointer;";
    a.addEventListener("click", (e) => { e.preventDefault(); openTab(linkUrl); });
    resultCard.appendChild(span);
    resultCard.appendChild(a);
  } else {
    resultCard.textContent = message;
  }
  if (!isError) setTimeout(() => { resultCard.style.display = "none"; }, 8000);
}

// ─── Progress bar ─────────────────────────────────────────────────────────────
function setProgress(current, total, captured, failed) {
  if (total === 0) { progressWrap.style.display = "none"; return; }
  progressWrap.style.display = "block";
  const pct = Math.round((current / total) * 100);
  progressFill.style.width = pct + "%";
  progressPct.textContent = pct + "%";
  progressStatus.textContent = current < total
    ? "Processing " + (current + 1) + " of " + total + "..."
    : "Complete";
  progressCounts.textContent = captured + " saved" + (failed ? " \u00b7 " + failed + " failed" : "");
}

// ─── Capture All state ────────────────────────────────────────────────────────
function setCapturing(capturing) {
  isCapturingAll = capturing;
  btnCaptureAll.style.display = capturing ? "none" : "flex";
  btnStop.style.display = capturing ? "flex" : "none";
  if (capturing) {
    progressWrap.style.display = "block";
    activityPanel.style.display = "block";
  }
}

// ─── Activity panel ───────────────────────────────────────────────────────────
function renderActivityPanel(results) {
  captureResults = results || captureResults;
  const successCount = captureResults.filter(r => !r.error).length;
  activityCount.textContent = successCount;
  activityPanel.style.display = "block";
  if (captureResults.length === 0) {
    activityList.innerHTML = '<div class="activity-empty">No receipts captured yet...</div>';
    return;
  }
  activityList.innerHTML = "";
  captureResults.forEach((r, i) => {
    const item = document.createElement("div");
    const label = r.label || ("Receipt " + (i + 1));
    if (r.error) {
      item.className = "activity-item err";
      item.innerHTML =
        '<span class="activity-icon">x</span>' +
        '<span class="activity-label" title="' + escHtml(label) + '">' + escHtml(label) + '</span>' +
        '<span class="activity-err-text" title="' + escHtml(r.error) + '">' + escHtml(r.error.slice(0, 30)) + '</span>';
    } else {
      item.className = "activity-item ok";
      const iconSpan = document.createElement("span");
      iconSpan.className = "activity-icon";
      iconSpan.textContent = "ok";
      const labelSpan = document.createElement("span");
      labelSpan.className = "activity-label";
      labelSpan.title = label;
      labelSpan.textContent = label;
      item.appendChild(iconSpan);
      item.appendChild(labelSpan);
      if (r.receiptUrl) {
        const viewLink = document.createElement("a");
        viewLink.className = "activity-link";
        viewLink.textContent = "View";
        viewLink.href = "#";
        viewLink.addEventListener("click", (e) => { e.preventDefault(); openTab(r.receiptUrl); });
        item.appendChild(viewLink);
      }
    }
    activityList.appendChild(item);
  });
  activityList.scrollTop = activityList.scrollHeight;
}

// ─── Load saved config ────────────────────────────────────────────────────────
async function loadConfig() {
  const { apiToken, apiBase } = await chrome.storage.local.get(["apiToken", "apiBase"]);
  if (apiToken) {
    inputToken.value = apiToken;
    inputToken.placeholder = "...";
    btnClear.style.display = "block";
  }
  if (apiBase) inputBase.value = apiBase;
  return { apiToken, apiBase };
}

// ─── Fetch user's vendor list ─────────────────────────────────────────────────
async function fetchVendorList(apiToken, apiBase) {
  if (!apiToken || !apiBase) return [];
  try {
    const res = await fetch(apiBase + "/api/extension/vendors", {
      headers: { "Authorization": "Bearer " + apiToken },
    });
    if (!res.ok) return [];
    const json = await res.json();
    const vendors = json?.vendors ?? [];
    await chrome.storage.local.set({ cachedVendorList: vendors, vendorListCachedAt: Date.now() });
    return vendors;
  } catch (e) {
    const { cachedVendorList } = await chrome.storage.local.get("cachedVendorList");
    return cachedVendorList || [];
  }
}

// ─── Update page info display ─────────────────────────────────────────────────
function updatePageUI(url, title, vendorList) {
  if (!url) return;
  try {
    pageUrl.textContent = url.length > 60 ? url.slice(0, 60) + "\u2026" : url;
  } catch { pageUrl.textContent = url; }
  pageTitle.textContent = title || "";

  // Detect vendor name
  const listVendor = matchVendorFromList(url, vendorList);
  const hardcodedVendor = detectVendorFromUrl(url);
  currentVendor = listVendor || hardcodedVendor;

  if (vendorBadge) {
    vendorBadge.textContent = currentVendor;
    vendorBadge.style.display = "inline-block";
  }

  captureLabel.textContent = "Capture " + currentVendor + " Receipt";
  captureAllLabel.textContent = "Capture All " + currentVendor + " Receipts";
}

// ─── Check connection ─────────────────────────────────────────────────────────
async function checkConnection(apiToken, apiBase) {
  if (!apiToken || !apiBase) {
    setStatus("disconnected", "Not configured", "Enter your API token below");
    return false;
  }
  try {
    const res = await fetch(apiBase + "/api/extension/ping", {
      headers: { "Authorization": "Bearer " + apiToken },
    });
    if (res.ok) {
      const json = await res.json();
      const name = json?.user?.name || json?.name || "Connected";
      setStatus("connected", name, apiBase.replace(/^https?:\/\//, ""));
      isConnected = true;
      return true;
    }
  } catch {}
  setStatus("error", "Connection failed", "Check your API token and base URL");
  isConnected = false;
  return false;
}

// ─── Single capture ───────────────────────────────────────────────────────────
async function captureCurrentTab() {
  if (!currentTab) return;
  captureLabel.textContent = "Capturing\u2026";
  btnCapture.disabled = true;
  resultCard.style.display = "none";

  const response = await new Promise(resolve => {
    chrome.runtime.sendMessage({
      type: "CAPTURE_TAB_PDF",
      payload: {
        tabId: currentTab.id,
        vendor: currentVendor,
        sourceUrl: currentTab.url,
        pageTitle: currentTab.title,
      },
    }, resolve);
  });

  captureLabel.textContent = "Capture " + currentVendor + " Receipt";
  btnCapture.disabled = false;

  if (response?.ok) {
    const { apiBase } = await chrome.storage.local.get(["apiBase"]);
    const base = apiBase || "";
    const receiptId = response.receiptId || response.id;
    const linkUrl = receiptId && base
      ? base + "/receipts?highlight=" + receiptId
      : (base ? base + "/receipts" : null);
    showResult("Receipt captured for " + currentVendor, false, linkUrl);
  } else {
    showResult(response?.error || "Upload failed", true);
  }
}

// ─── Inject content script if needed, then get invoice links ─────────────────
async function getInvoiceLinksFromTab(tabId) {
  // Try asking the content script for links (it may already be injected)
  const fromContentScript = await new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { type: "GET_INVOICE_LINKS" }, (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp);
    });
  });

  if (fromContentScript && fromContentScript.links) {
    return fromContentScript.links;
  }

  // Content script not injected — inject it dynamically
  try {
    await new Promise((resolve, reject) => {
      chrome.scripting.executeScript({
        target: { tabId },
        files: ["vendorProfiles.js", "content.js"],
      }, (results) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(results);
      });
    });
    // Wait for script to initialize
    await new Promise(r => setTimeout(r, 600));
    // Ask again
    const resp2 = await new Promise(resolve => {
      chrome.tabs.sendMessage(tabId, { type: "GET_INVOICE_LINKS" }, (r) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(r);
      });
    });
    return resp2?.links || [];
  } catch (err) {
    console.warn("[ReconcileIQ Popup] Could not inject content script:", err.message);
    return [];
  }
}

// ─── Capture All ─────────────────────────────────────────────────────────────
async function captureAll() {
  if (!currentTab || isCapturingAll) return;
  captureResults = [];
  renderActivityPanel([]);
  setCapturing(true);
  progressFill.style.width = "0%";
  progressPct.textContent = "0%";
  progressStatus.textContent = "Finding receipts\u2026";
  progressCounts.textContent = "";
  resultCard.style.display = "none";

  const { apiBase } = await chrome.storage.local.get(["apiBase"]);
  const tabId = currentTab.id;

  // Get invoice links from the content script
  const links = await getInvoiceLinksFromTab(tabId);

  if (!links || links.length === 0) {
    setCapturing(false);
    showResult("No invoice links found on this page. Try navigating to a billing history or invoices page.", true);
    return;
  }

  progressStatus.textContent = "Starting capture of " + links.length + " receipts\u2026";

  // Hand off to background worker — it opens each URL in a hidden background tab
  chrome.runtime.sendMessage({
    type: "BACKGROUND_TAB_CAPTURE_ALL",
    payload: {
      hrefs: links,
      vendor: currentVendor,
      baseUrl: apiBase || null,
      waitAfterOpen: 2500,
    },
  });
}

// ─── Stop ─────────────────────────────────────────────────────────────────────
async function stopCapture() {
  chrome.runtime.sendMessage({ type: "CAPTURE_ALL_ABORT" });
  btnStop.textContent = "Stopping\u2026";
  btnStop.disabled = true;
  setTimeout(() => {
    btnStop.textContent = "Stop";
    btnStop.disabled = false;
  }, 3000);
}

// ─── Background worker messages ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "CAPTURE_ALL_PROGRESS") {
    setProgress(msg.current, msg.total, msg.captured, msg.failed);
    renderActivityPanel(msg.results || []);
  }
  if (msg.type === "CAPTURE_ALL_DONE") {
    setCapturing(false);
    renderActivityPanel(msg.results || []);
    setProgress(msg.total, msg.total, msg.captured, msg.failed);
    const base = msg.baseUrl || "";
    const linkUrl = base ? base + "/receipts" : null;
    if (linkUrl && activityViewAll) {
      activityViewAll.href = "#";
      activityViewAll.style.display = "block";
      const newLink = activityViewAll.cloneNode(true);
      activityViewAll.parentNode.replaceChild(newLink, activityViewAll);
      newLink.addEventListener("click", (e) => { e.preventDefault(); openTab(linkUrl); });
    }
    showResult("Done: " + msg.captured + " saved, " + msg.failed + " failed", msg.captured === 0, linkUrl);
  }
});

// ─── Event listeners ──────────────────────────────────────────────────────────
btnSave.addEventListener("click", async () => {
  const token = inputToken.value.trim();
  const base = inputBase.value.trim().replace(/\/$/, "");
  if (!token || !base) { showResult("Please enter both the API token and base URL", true); return; }
  btnSave.textContent = "Saving...";
  btnSave.disabled = true;
  await chrome.storage.local.set({ apiToken: token, apiBase: base });
  btnClear.style.display = "block";
  const connected = await checkConnection(token, base);
  btnSave.textContent = "Save & Connect";
  btnSave.disabled = false;
  if (connected) {
    showResult("Connected successfully!");
    userVendorList = await fetchVendorList(token, base);
    if (currentTab?.url) updatePageUI(currentTab.url, currentTab.title, userVendorList);
    btnCapture.disabled = false;
    btnCaptureAll.disabled = false;
  }
});

btnClear.addEventListener("click", async () => {
  await chrome.storage.local.remove(["apiToken", "apiBase", "cachedVendorList", "vendorListCachedAt"]);
  inputToken.value = "";
  inputBase.value = "";
  btnClear.style.display = "none";
  isConnected = false;
  userVendorList = [];
  btnCapture.disabled = true;
  btnCaptureAll.disabled = true;
  setStatus("disconnected", "Disconnected", "Enter your API token to reconnect");
});

btnCapture.addEventListener("click", () => {
  if (isConnected) captureCurrentTab();
  else showResult("Not connected. Save your API token first.", true);
});

btnCaptureAll.addEventListener("click", () => {
  if (isConnected) captureAll();
  else showResult("Not connected. Save your API token first.", true);
});

btnStop.addEventListener("click", stopCapture);

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const { apiToken, apiBase } = await loadConfig();
  currentTab = await chrome.tabs.query({ active: true, currentWindow: true }).then(t => t[0]);

  // Load cached vendor list immediately
  const { cachedVendorList } = await chrome.storage.local.get("cachedVendorList");
  userVendorList = cachedVendorList || [];

  if (currentTab?.url) {
    updatePageUI(currentTab.url, currentTab.title, userVendorList);
  }

  const connected = await checkConnection(apiToken, apiBase);
  if (connected) {
    btnCapture.disabled = false;
    btnCaptureAll.disabled = false;
    // Fetch fresh vendor list in background
    fetchVendorList(apiToken, apiBase).then(vendors => {
      userVendorList = vendors;
      if (currentTab?.url) updatePageUI(currentTab.url, currentTab.title, userVendorList);
    });
  }

  // Restore in-progress capture state
  const { captureAllRunning, captureAllResults, captureAllProgress } = await chrome.storage.local.get([
    "captureAllRunning", "captureAllResults", "captureAllProgress"
  ]);
  if (captureAllRunning) {
    setCapturing(true);
    if (captureAllResults?.length) renderActivityPanel(captureAllResults);
    if (captureAllProgress) {
      setProgress(captureAllProgress.current, captureAllProgress.total, captureAllProgress.captured, captureAllProgress.failed);
    }
  } else {
    // Not capturing — ensure buttons are visible (they start display:none in HTML)
    setCapturing(false);
    if (captureAllResults?.length) {
      renderActivityPanel(captureAllResults);
      if (apiBase && activityViewAll) {
        activityViewAll.href = "#";
        activityViewAll.style.display = "block";
        activityViewAll.addEventListener("click", (e) => {
          e.preventDefault();
          openTab(apiBase + "/receipts");
        });
      }
    }
  }

  linkSettings.addEventListener("click", (e) => {
    e.preventDefault();
    const base = apiBase || "https://reconcileiq.manus.space";
    chrome.tabs.create({ url: base + "/settings?tab=extension" });
  });
}

init().catch(console.error);
