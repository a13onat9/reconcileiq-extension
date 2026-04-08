/**
 * ReconcileIQ Content Script v2.0.0
 *
 * Architecture change from v1.x:
 * - No more screenshot capture (background worker does PDF via chrome.debugger)
 * - No more page navigation (background worker opens hidden background tabs)
 * - Content script just scans DOM and reports URLs to background worker
 */

(function () {
  "use strict";

  if (window.__riqInjected) return;
  window.__riqInjected = true;

  let isCapturingAll = false;

  // ─── Vendor detection ────────────────────────────────────────────────────
  function detectVendor() {
    if (window.RIQ_VendorProfiles) {
      const profile = window.RIQ_VendorProfiles.getVendorProfile(window.location.hostname);
      if (profile && profile.vendor) return profile.vendor;
    }
    const host = window.location.hostname.replace(/^www\./, "");
    return host.split(".")[0];
  }

  // ─── Universal invoice link finder ───────────────────────────────────────
  function findInvoiceLinks() {
    // Tier 1: vendor-specific profiles
    if (window.RIQ_VendorProfiles) {
      const profile = window.RIQ_VendorProfiles.getVendorProfile(window.location.hostname);
      const triggers = window.RIQ_VendorProfiles.findReceiptTriggers(profile);
      if (triggers.length > 0) {
        const urls = [];
        const seen = new Set();
        triggers.forEach((el) => {
          const href = el.href || el.getAttribute("href");
          if (href && href.startsWith("http") && !seen.has(href)) {
            seen.add(href);
            urls.push(href);
          }
        });
        if (urls.length > 0) return urls;
      }
    }

    // Tier 2: universal DOM heuristics
    const LINK_TEXT_PATTERNS = [
      /^view$/i, /^view receipt$/i, /^view invoice$/i,
      /^download$/i, /^download receipt$/i, /^download invoice$/i,
      /^invoice #?\d/i, /^receipt #?\d/i,
      /^open invoice$/i, /^open receipt$/i, /^pdf$/i,
    ];

    const HREF_PATTERNS = [
      /\/invoice/i, /\/receipt/i, /\/billing\/history/i,
      /\/orders\/\d/i, /\/transactions\/\d/i,
      /viewinvoice/i, /downloadinvoice/i,
      /invoice_id=/i, /receipt_id=/i,
      /[?&]id=\d/i, /\.pdf(\?|$)/i,
    ];

    // Strip language/locale query params before deduplication so "My Invoices" in
    // Arabic, Turkish, French, etc. all collapse to the same canonical URL.
    const LOCALE_PARAMS = new Set(["language", "lang", "locale", "lng", "hl", "l"]);
    function canonicalUrl(href) {
      try {
        const u = new URL(href);
        for (const p of LOCALE_PARAMS) u.searchParams.delete(p);
        u.searchParams.sort();
        return u.origin + u.pathname + (u.search ? u.search : "");
      } catch { return href; }
    }
    // Skip links that are just the current page in a different language
    const currentCanonical = canonicalUrl(window.location.href);
    const seen = new Set();
    const urls = [];

    document.querySelectorAll("a[href]").forEach((el) => {
      const href = el.href;
      if (!href || !href.startsWith("http")) return;
      const canonical = canonicalUrl(href);
      // Skip language-switcher links (same canonical as current page)
      if (canonical === currentCanonical) return;
      if (seen.has(canonical)) return;

      const text = (el.textContent || "").trim();
      const textMatch = LINK_TEXT_PATTERNS.some((p) => p.test(text));
      const hrefMatch = HREF_PATTERNS.some((p) => p.test(href));

      if (textMatch || hrefMatch) {
        const isNavLink =
          /privacy|terms|help|support|faq|contact|about|login|signup|home|dashboard/i.test(href) &&
          !/invoice|receipt|billing/i.test(href);
        if (!isNavLink) {
          seen.add(canonical);
          urls.push(href); // push original href so the actual URL is used
        }
      }
    });

    return urls;
  }

  // ─── Toast notification ───────────────────────────────────────────────────
  function setToast(text, bgColor, linkUrl) {
    let toast = document.getElementById("riq-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "riq-toast";
      toast.style.cssText =
        "position:fixed;bottom:80px;right:20px;z-index:2147483647;" +
        "background:rgba(30,30,30,0.95);color:#fff;padding:10px 16px;" +
        "border-radius:8px;font-size:13px;font-family:system-ui,sans-serif;" +
        "max-width:320px;box-shadow:0 4px 16px rgba(0,0,0,0.4);" +
        "transition:opacity 0.3s;pointer-events:auto;";
      document.body.appendChild(toast);
    }
    if (!text) { toast.style.opacity = "0"; return; }
    toast.style.background = bgColor || "rgba(30,30,30,0.95)";
    toast.style.opacity = "1";
    if (linkUrl) {
      toast.innerHTML =
        text +
        ' <a href="' + linkUrl + '" target="_blank" ' +
        'style="color:#93c5fd;text-decoration:underline;margin-left:6px;">View in ReconcileIQ</a>';
    } else {
      toast.textContent = text;
    }
  }

  // ─── Floating button UI ───────────────────────────────────────────────────
  function injectUI() {
    if (document.getElementById("riq-btn-container")) return;

    const container = document.createElement("div");
    container.id = "riq-btn-container";
    container.style.cssText =
      "position:fixed;bottom:20px;right:20px;z-index:2147483646;" +
      "display:flex;flex-direction:column;gap:8px;align-items:flex-end;" +
      "font-family:system-ui,-apple-system,sans-serif;";

    const allBtn = document.createElement("button");
    allBtn.id = "riq-all-btn";
    allBtn.style.cssText =
      "background:#16a34a;color:#fff;border:none;border-radius:8px;" +
      "padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer;" +
      "box-shadow:0 4px 12px rgba(0,0,0,0.3);white-space:nowrap;" +
      "display:flex;align-items:center;gap:6px;";
    allBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">' +
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
      '<polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
      "Capture All Receipts";
    allBtn.addEventListener("click", () => startCaptureAll(allBtn));

    const btn = document.createElement("button");
    btn.id = "riq-single-btn";
    btn.style.cssText =
      "background:#7c3aed;color:#fff;border:none;border-radius:8px;" +
      "padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer;" +
      "box-shadow:0 4px 12px rgba(0,0,0,0.3);white-space:nowrap;" +
      "display:flex;align-items:center;gap:6px;";
    btn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">' +
      '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>' +
      "Capture Receipt";
    btn.addEventListener("click", captureSinglePage);

    const links = findInvoiceLinks();
    if (links.length === 0) allBtn.style.display = "none";

    container.appendChild(allBtn);
    container.appendChild(btn);
    document.body.appendChild(container);

    const observer = new MutationObserver(() => {
      const found = findInvoiceLinks();
      allBtn.style.display = found.length > 0 ? "flex" : "none";
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─── Capture single page as PDF ───────────────────────────────────────────
  function captureSinglePage() {
    const btn = document.getElementById("riq-single-btn");
    if (btn) { btn.textContent = "Capturing\u2026"; btn.disabled = true; }
    setToast("Capturing page as PDF\u2026");

    chrome.runtime.sendMessage(
      {
        type: "CAPTURE_TAB_PDF",
        payload: {
          tabId: null, // background worker uses sender.tab.id
          vendor: detectVendor(),
          sourceUrl: window.location.href,
          pageTitle: document.title,
        },
      },
      (result) => {
        if (btn) {
          btn.innerHTML =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">' +
            '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>' +
            "Capture Receipt";
          btn.disabled = false;
        }
        if (result && result.ok) {
          setToast("\u2713 Receipt captured!", "rgba(5,150,105,0.92)");
          setTimeout(() => setToast(null), 6000);
        } else {
          setToast("\u2717 " + ((result && result.error) || "Capture failed"), "rgba(220,38,38,0.92)");
          setTimeout(() => setToast(null), 8000);
        }
      }
    );
  }

  // ─── Capture All ─────────────────────────────────────────────────────────
  function startCaptureAll(allBtn) {
    if (isCapturingAll) {
      chrome.runtime.sendMessage({ type: "CAPTURE_ALL_ABORT" });
      allBtn.textContent = "Stopping\u2026";
      return;
    }

    const links = findInvoiceLinks();
    if (links.length === 0) {
      setToast("No invoice links found on this page.", "rgba(220,38,38,0.92)");
      setTimeout(() => setToast(null), 5000);
      return;
    }

    isCapturingAll = true;
    allBtn.textContent = "Capturing 0 of " + links.length + "\u2026";
    allBtn.style.background = "#dc2626";
    setToast("Starting capture of " + links.length + " receipts in background\u2026");

    chrome.runtime.sendMessage({
      type: "BACKGROUND_TAB_CAPTURE_ALL",
      payload: {
        hrefs: links,
        vendor: detectVendor(),
        baseUrl: null,
        waitAfterOpen: 2500,
      },
    });
  }

  // ─── Message listener (from popup and background worker) ──────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Popup asks for the list of invoice links on this page
    if (msg.type === "GET_INVOICE_LINKS") {
      const links = findInvoiceLinks();
      sendResponse({ links, count: links.length });
      return true;
    }

    const allBtn = document.getElementById("riq-all-btn");

    if (msg.type === "CAPTURE_ALL_PROGRESS") {
      const { current, total, captured } = msg;
      if (allBtn) {
        allBtn.textContent =
          "Capturing " + (current + 1) + " of " + total + " (" + captured + " saved)\u2026";
      }
      setToast("Capturing " + (current + 1) + " of " + total + "\u2026");
    }

    if (msg.type === "CAPTURE_ALL_DONE") {
      isCapturingAll = false;
      if (allBtn) {
        allBtn.innerHTML =
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">' +
          '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
          '<polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
          "Capture All Receipts";
        allBtn.style.background = "#16a34a";
        allBtn.disabled = false;
      }
      const { captured, failed, total } = msg;
      const color = captured > 0 ? "rgba(5,150,105,0.92)" : "rgba(220,38,38,0.92)";
      setToast(
        "\u2713 Done: " + captured + " of " + total + " captured" +
        (failed ? " (" + failed + " failed)" : ""),
        color
      );
      setTimeout(() => setToast(null), 12000);
    }
  });

  // ─── PDF link interception ────────────────────────────────────────────────
  function interceptPdfLinks() {
    document.querySelectorAll(
      'a[href$=".pdf"], a[href*="downloadinvoice"], a[href*="download_invoice"]'
    ).forEach((link) => {
      if (link.dataset.riqIntercepted) return;
      link.dataset.riqIntercepted = "1";
      link.addEventListener("click", async (e) => {
        const href = link.href;
        if (!href || !href.startsWith("http")) return;
        try {
          const res = await fetch(href);
          const blob = await res.blob();
          if (blob.type !== "application/pdf") return;
          e.preventDefault();
          const reader = new FileReader();
          reader.onload = () => {
            const base64 = reader.result.split(",")[1];
            chrome.runtime.sendMessage(
              {
                type: "UPLOAD_PDF",
                payload: { base64, vendor: detectVendor(), sourceUrl: href, pageTitle: document.title },
              },
              (r) => {
                if (r && r.ok) setToast("\u2713 PDF receipt sent to ReconcileIQ", "rgba(5,150,105,0.92)");
                else setToast("\u2717 " + ((r && r.error) || "Upload failed"), "rgba(220,38,38,0.92)");
                setTimeout(() => setToast(null), 6000);
              }
            );
          };
          reader.readAsDataURL(blob);
        } catch (err) { /* silently ignore */ }
      });
    });
  }

  // ─── Init ─────────────────────────────────────────────────────────────────
  injectUI();
  interceptPdfLinks();
  const pdfObserver = new MutationObserver(() => interceptPdfLinks());
  pdfObserver.observe(document.body, { childList: true, subtree: true });

})();
