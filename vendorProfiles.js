/**
 * vendorProfiles.js
 *
 * Tiered auto-capture profiles for known billing pages.
 * Each profile describes how to find the receipt list, open each receipt,
 * screenshot it, and close it.
 *
 * Tier 1: Hardcoded profiles for major vendors (reliable, tested selectors)
 * Tier 2: Generic heuristic fallback (works on most SaaS billing pages)
 */

"use strict";

const VENDOR_PROFILES = {
  // ─── YouTube TV ───────────────────────────────────────────────────────────
  // YouTube TV "View" links navigate to a new page (not a modal).
  // navigationType: "page" tells the capture loop to:
  //   1. Collect all hrefs upfront before any navigation
  //   2. Navigate to each URL directly via window.location
  //   3. Screenshot the receipt page
  //   4. Navigate back to the billing list and wait for it to reload
  "tv.youtube.com": {
    name: "YouTube TV",
    viewButtonSelector: 'a',
    viewButtonText: "View",
    navigationType: "page",   // <-- key flag: links navigate away, not modal
    waitAfterOpen: 5000,      // wait for receipt page to fully render (increased for slow connections)
    waitAfterBack: 4000,      // wait for billing list to reload after back()
    scrollToLoad: true,
    captureModal: false,
  },

  // ─── Netflix ──────────────────────────────────────────────────────────────
  "www.netflix.com": {
    name: "Netflix",
    viewButtonSelector: 'a[href*="viewbillingactivity"], a[href*="billing"]',
    viewButtonText: null, // follow links directly
    modalSelector: null, // opens new page
    closeButtonSelector: null,
    waitAfterOpen: 2500,
    captureModal: false, // new page, screenshot full page
    scrollToLoad: true,
  },

  // ─── Hulu ─────────────────────────────────────────────────────────────────
  "www.hulu.com": {
    name: "Hulu",
    viewButtonSelector: 'a[href*="receipt"], a[href*="invoice"], button',
    viewButtonText: "View",
    modalSelector: '[class*="modal"], [role="dialog"]',
    closeButtonSelector: '[aria-label*="close" i], button[class*="close"]',
    waitAfterOpen: 2000,
    captureModal: true,
    scrollToLoad: true,
  },

  // ─── Disney+ ──────────────────────────────────────────────────────────────
  "www.disneyplus.com": {
    name: "Disney+",
    viewButtonSelector: 'a[href*="receipt"], a[href*="invoice"], button',
    viewButtonText: "View",
    modalSelector: '[class*="modal"], [role="dialog"]',
    closeButtonSelector: '[aria-label*="close" i], button[class*="close"]',
    waitAfterOpen: 2500,
    captureModal: true,
    scrollToLoad: false,
  },

  // ─── Max (HBO Max) ────────────────────────────────────────────────────────
  "www.max.com": {
    name: "Max",
    viewButtonSelector: 'a[href*="receipt"], a[href*="invoice"], button',
    viewButtonText: "View",
    modalSelector: '[class*="modal"], [role="dialog"]',
    closeButtonSelector: '[aria-label*="close" i], button[class*="close"]',
    waitAfterOpen: 2000,
    captureModal: true,
    scrollToLoad: false,
  },

  // ─── Stripe Billing Portal ────────────────────────────────────────────────
  "billing.stripe.com": {
    name: "Stripe",
    viewButtonSelector: 'a[href*="invoice"], a[href*="receipt"], a[download]',
    viewButtonText: null,
    modalSelector: null, // opens new tab/page
    closeButtonSelector: null,
    waitAfterOpen: 3000,
    captureModal: false,
    scrollToLoad: true,
  },

  // ─── Paramount+ ───────────────────────────────────────────────────────────
  // Billing page: https://help.paramountplus.com/s/my-invoices
  // Each invoice row has a link that opens a PDF or detail page
  "help.paramountplus.com": {
    name: "Paramount+",
    viewButtonSelector: 'a[href*="invoice"], a[href*="receipt"], a[href*="pdf"], a',
    viewButtonText: null,  // match all links in the invoice table
    navigationType: "page",
    waitAfterOpen: 4000,
    waitAfterBack: 3000,
    scrollToLoad: false,
    captureModal: false,
  },
  "www.paramountplus.com": {
    name: "Paramount+",
    viewButtonSelector: 'a[href*="receipt"], a[href*="invoice"], button',
    viewButtonText: "View",
    modalSelector: '[class*="modal"], [role="dialog"]',
    closeButtonSelector: '[aria-label*="close" i], button[class*="close"]',
    waitAfterOpen: 2000,
    captureModal: true,
    scrollToLoad: false,
  },
};

/**
 * Generic heuristic fallback — used when no hardcoded profile exists.
 * Scans the page for any links/buttons that look like receipt/invoice triggers.
 */
const GENERIC_PROFILE = {
  name: null, // will be set from page title / meta
  // Text patterns to match against link/button text content
  viewButtonTextPatterns: [
    /^view$/i,
    /^view receipt$/i,
    /^view invoice$/i,
    /^download$/i,
    /^download receipt$/i,
    /^download invoice$/i,
    /invoice/i,
    /receipt/i,
  ],
  // Href patterns for anchor tags
  hrefPatterns: [
    /receipt/i,
    /invoice/i,
    /billing.*history/i,
    /payment.*history/i,
    /\/pdf/i,
  ],
  modalSelector: '[class*="modal"], [class*="dialog"], [class*="overlay"], [role="dialog"]',
  closeButtonSelector: '[aria-label*="close" i], [aria-label*="dismiss" i], button[class*="close"], .close, #close',
  waitAfterOpen: 2500,
  captureModal: true,
  scrollToLoad: true,
};

/**
 * Get the profile for the current page hostname.
 * Returns the hardcoded profile if available, otherwise the generic fallback.
 */
function getVendorProfile(hostname) {
  // Strip www. prefix for matching
  const clean = hostname.replace(/^www\./, "");
  // Check exact match first
  if (VENDOR_PROFILES[hostname]) return { ...VENDOR_PROFILES[hostname], isHardcoded: true };
  // Check without www
  const withWww = "www." + clean;
  if (VENDOR_PROFILES[withWww]) return { ...VENDOR_PROFILES[withWww], isHardcoded: true };
  // Check if hostname ends with a known domain
  for (const [domain, profile] of Object.entries(VENDOR_PROFILES)) {
    if (hostname.endsWith(domain) || domain.endsWith(clean)) {
      return { ...profile, isHardcoded: true };
    }
  }
  return { ...GENERIC_PROFILE, isHardcoded: false };
}

/**
 * Find all "View receipt" buttons/links on the current page using the profile.
 * Returns an array of DOM elements.
 */
function findReceiptTriggers(profile) {
  const triggers = [];
  const seen = new Set();

  if (profile.isHardcoded && profile.viewButtonSelector) {
    // Use hardcoded selector
    const els = document.querySelectorAll(profile.viewButtonSelector);
    els.forEach((el) => {
      if (seen.has(el)) return;
      // If viewButtonText is specified, filter by text content
      if (profile.viewButtonText) {
        const text = el.textContent?.trim() || "";
        if (!text.toLowerCase().includes(profile.viewButtonText.toLowerCase())) return;
      }
      seen.add(el);
      triggers.push(el);
    });
  }

  if (!profile.isHardcoded || triggers.length === 0) {
    // Generic heuristic: scan all links and buttons
    const candidates = document.querySelectorAll("a, button");
    candidates.forEach((el) => {
      if (seen.has(el)) return;
      const text = el.textContent?.trim() || "";
      const href = el.getAttribute("href") || "";

      const textMatch = GENERIC_PROFILE.viewButtonTextPatterns.some((p) => p.test(text));
      const hrefMatch = GENERIC_PROFILE.hrefPatterns.some((p) => p.test(href));

      if (textMatch || hrefMatch) {
        seen.add(el);
        triggers.push(el);
      }
    });
  }

  return triggers;
}

// Export for use in content.js (loaded as a separate script via manifest)
if (typeof window !== "undefined") {
  window.RIQ_VendorProfiles = { getVendorProfile, findReceiptTriggers, VENDOR_PROFILES, GENERIC_PROFILE };
}
