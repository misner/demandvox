/********************************************************************
 * Environment + logging 
 * ------------------------------------------------------------------
 * Enforce verbose logs on preview instances (*.pages.dev)
 * to debug embed behavior, but silence logs on production domains.
 *
 * IMPORTANT:
 * - Preview: hostname endsWith(".pages.dev")  → logs ON
 * - Production: everything else               → logs OFF
 ********************************************************************/
function isPreviewHost() {
  try {
    return window.location.hostname.endsWith(".pages.dev");
  } catch {
    return false;
  }
}

/**
 * Debug flag used throughout this file.
 * You can also override manually in DevTools if needed:
 *   window.__DV_DEBUG__ = true;
 */
const DV_DEBUG = isPreviewHost() || Boolean(window.__DV_DEBUG__);

/**
 * Centralized logger (so production stays quiet).
 */
function dvLog(...args) {
  if (DV_DEBUG) console.log(...args);
}
function dvWarn(...args) {
  if (DV_DEBUG) console.warn(...args);
}
function dvError(...args) {
  console.error(...args);
}

/********************************************************************
 * Constants
 ********************************************************************/
const IFRAME_GO_TO_PROFILE = "Back to chat center";
const DELPHI_IFRAME_SELECTOR = "#delphi-frame";
const IFRAME_WAIT_TIMEOUT_MS = 15000;
const LOG_PREFIX = "[delphi-domrules]";

/********************************************************************
 * Utilities
 ********************************************************************/
function waitForIframe(selector, timeoutMs = IFRAME_WAIT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(selector);
    if (existing) return resolve(existing);

    const obs = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        obs.disconnect();
        resolve(el);
      }
    });

    obs.observe(document.documentElement, { childList: true, subtree: true });

    setTimeout(() => {
      obs.disconnect();
      reject(new Error(`Timeout waiting for iframe: ${selector}`));
    }, timeoutMs);
  });
}

function safeGetIframeDoc(iframe) {
  try {
    return iframe?.contentDocument || iframe?.contentWindow?.document || null;
  } catch {
    return null;
  }
}

function isElementVisible(el) {
  if (!el) return false;

  // Fast checks first
  const style = el.ownerDocument?.defaultView?.getComputedStyle(el);
  if (!style) return false;

  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }

  // If it has no layout boxes, treat as not visible
  const rect = el.getBoundingClientRect?.();
  if (!rect || (rect.width === 0 && rect.height === 0)) return false;

  return true;
}

/**
 * Returns the first visible match for selector, or null.
 * We prefer visible elements because Delphi is a SPA and keeps old screens mounted.
 */
function queryVisible(doc, selector) {
  const nodes = Array.from(doc.querySelectorAll(selector));
  for (const node of nodes) {
    if (isElementVisible(node)) return node;
  }
  return null;
}

function getDelphiMode(doc) {
  if (!doc) return "unknown_mode";

  // 1) Call mode
  if (queryVisible(doc, ".delphi-call-container")) return "call_mode";

  // 2) Chat mode
  if (
    queryVisible(doc, ".delphi-chat-conversation") ||
    queryVisible(doc, "[data-sentry-component='Talk']") ||
    queryVisible(doc, ".delphi-talk-container")
  ) {
    return "chat_mode";
  }

  // 3) Overview / Profile mode (best effort)
  if (queryVisible(doc, ".delphi-profile-container")) return "overview_mode";

  // Fallback: overview often has a profile image for the clone
  if (doc.querySelector('img[alt^="Profile image for"]')) return "overview_mode";

  return "unknown_mode";
}

/**
 * Detect whether a user is logged in to Delphi.
 *
 * Reliable signal: Presence of the auth menu trigger button at the top right across all modes
 */
function isDelphiLoggedIn(doc) {
  if (!doc) return false;

  // Use visible-first strategy to avoid SPA leftovers
  const btn =
    queryVisible(doc, "button.delphi-auth-menu-trigger") ||
    doc.querySelector("button.delphi-auth-menu-trigger");

  return !!btn;
}


/**
 * "First Last" => "First"
 * Returns null if it can't/shouldn't transform.
 */
function extractFirstName(fullName) {
  const original = (fullName || "").trim();
  if (!original) return null;

  const tokens = original.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;

  return tokens[0];
}

function updateAndLogDelphiMode(doc) {
  if (!doc) return "unknown_mode";

  const nextMode = getDelphiMode(doc);
  const prevMode = doc.__delphiMode || "unknown_mode";

  if (nextMode !== prevMode) {
    doc.__delphiMode = nextMode;

    // Optional: expose it for debugging from the parent page DevTools.
    // Note: this runs in iframe context, so we also mirror it to the parent window.
    try {
      window.__DELPHI_MODE__ = nextMode;
    } catch {}

    if (DV_DEBUG) dvLog(LOG_PREFIX, "mode changed:", prevMode, "→", nextMode);
  }

  return nextMode;
}

function ruleForceText({ name, selector, getText, preferVisible = true }) {
  return {
    name,
    apply(doc) {
      const el = preferVisible && typeof queryVisible === "function"
        ? queryVisible(doc, selector)
        : doc.querySelector(selector);

      if (!el) return false;

      const desired = String(getText());
      const current = (el.textContent || "").trim();

      if (current !== desired) {
        el.textContent = desired;
        dvLog(LOG_PREFIX, `[delphi] ${name}: text updated`);
        return true;
      }
      return false;
    },
  };
}

function ruleHideButKeepLayout({ name, selector, preferVisible = true }) {
  return {
    name,
    apply(doc) {
      const el = preferVisible && typeof queryVisible === "function"
        ? queryVisible(doc, selector)
        : doc.querySelector(selector);

      if (!el) return false;

      if (el.style.visibility !== "hidden") {
        el.style.visibility = "hidden";
        dvLog(LOG_PREFIX, `[delphi] ${name}: hidden (layout preserved)`);
        return true;
      }
      return false;
    },
  };
}

function ruleRemoveElement({ name, selector, preferVisible = true }) {
  return {
    name,
    apply(doc) {
      const el = preferVisible && typeof queryVisible === "function"
        ? queryVisible(doc, selector)
        : doc.querySelector(selector);

      if (!el) return false;

      // Idempotency guard in case the node is re-mounted quickly
      if (el.__dvRemoved) return false;
      el.__dvRemoved = true;

      el.remove();
      dvLog(LOG_PREFIX, `[delphi] ${name}: element removed from DOM`);
      return true;
    },
  };
}

/**
 * ---------------------------------------------------------------
 * Call header (DESKTOP ONLY):
 * Replace Delphi logo with "Back to chat"
 *
 * Mobile behavior:
 * - No change (Delphi logo area remains hidden)
 *
 * Desktop behavior:
 * - Chevron remains visible
 * - Delphi logo is replaced with a text CTA
 * ---------------------------------------------------------------
 */
function ruleCallHeaderBackToChatLink() {
  // Desktop call header logo link (Delphi)
  const selector = "header.delphi-call-header a[aria-label='Delphi']";

  return {
    name: "call-header-back-to-chat-link",

    apply(doc) {
      // Only run in call mode
      const mode = doc.__delphiMode || getDelphiMode(doc);
      if (mode !== "call_mode") return false;

      // Prefer visible because Delphi keeps old screens mounted
      const link = queryVisible(doc, selector) || doc.querySelector(selector);
      if (!link) return false;

      // idempotency guard
      if (link.__dvBackToChatApplied) return false;
      link.__dvBackToChatApplied = true;

      // IMPORTANT: you said you want it to go to profile/overview
      // If your correct destination is /overview, keep this:
      link.setAttribute("href", "/overview");

      // Replace content with text CTA
      link.textContent = IFRAME_GO_TO_PROFILE;

      // Reset classes then apply desired styling (desktop only)
      link.className = "";
      link.classList.add("text-sand-11", "hidden", "text-sm", "font-medium", "md:block");

      // Ensure link behaves nicely as text
      link.style.whiteSpace = "nowrap";
      link.style.display = "inline-flex";
      link.style.alignItems = "center";

      link.setAttribute("aria-label", "Back to chat center");

      // Hide the vertical divider next to the logo (if present)
      const divider = link.closest("span")?.nextElementSibling;
      if (divider && divider.getAttribute("role") === "presentation") {
        divider.style.visibility = "hidden";
      }

      dvLog(LOG_PREFIX, `[delphi] call-header-back-to-chat-link: replaced logo with CTA`);
      return true;
    },
  };
}



/********************************************************************
 * DOM RULES ENGINE
 ********************************************************************/
const domRules = [];

function addDomRule(name, fn) {
  domRules.push({ name, fn });
}

function addBuiltRule(ruleObj) {
  addDomRule(ruleObj.name, (doc) => ruleObj.apply(doc));
}

function applyDomRules(doc) {
  if (!doc) return;

  for (const rule of domRules) {
    try {
      const changed = !!rule.fn(doc);
      if (changed) dvLog(LOG_PREFIX, "rule applied:", rule.name);
    } catch (e) {
      dvWarn(LOG_PREFIX, "rule error:", rule.name, e);
    }
  }
}

/********************************************************************
 * VISIBILITY AND LAYOUT AJDUSTEMENTS 
 ********************************************************************/

//Edit agent name to only show first name
addDomRule("profile-name-first-word-only", (doc) => {
  const mode = doc.__delphiMode || getDelphiMode(doc);

  // Helper: set element text to first name (if needed)
  const setFirstName = (el) => {
    if (!el) return false;

    const first = extractFirstName(el.textContent);
    if (!first) return false;

    if (el.textContent.trim() === first) return false;

    el.textContent = first;
    return true;
  };

  // ---------------------------
  // Mode: CHAT
  // ---------------------------
  if (mode === "chat_mode") {
    const h1 = queryVisible(doc, "h1.delphi-talk-title-text");
    return setFirstName(h1);
  }

  // ---------------------------
  // Mode: CALL  
  // ---------------------------
  if (mode === "call_mode") {
    let changed = false;

    const headerTitle = queryVisible(doc, "h1.delphi-call-header-title");
    changed = setFirstName(headerTitle) || changed;

    const centerTitle = queryVisible(doc, "h2.delphi-call-clone-indicator-title");
    changed = setFirstName(centerTitle) || changed;

    return changed;
  }

  // ---------------------------
  // Mode: OVERVIEW / PROFILE (and fallback)
  // ---------------------------
  const profileImg = doc.querySelector('img[alt^="Profile image for"]');
  if (!profileImg) return false;

  const scope =
    profileImg.closest("section") ||
    profileImg.closest("main") ||
    doc.querySelector("main") ||
    doc.body;

  if (!scope) return false;

  const h1 = scope.querySelector("h1");
  return setFirstName(h1);
});

// Overview/Profile: hide the Delphi logo nav link (ONLY in overview mode)
addDomRule("overview-hide-delphi-nav-link", (doc) => {
  const mode = doc.__delphiMode || getDelphiMode(doc);
  if (mode !== "overview_mode") return false;

  return ruleHideButKeepLayout({
    name: "overview-hide-delphi-nav-link-inner",
    selector: "a[role='navigation'][aria-label='Delphi'][href='/overview']",
    preferVisible: true,
  }).apply(doc);
});

//Chat mode: nav bar logo+chat history icons
addDomRule("chat-header-logo-loggedin", (doc) => {
  const mode = doc.__delphiMode || getDelphiMode(doc);
  if (mode !== "chat_mode") return false;

  // The button that contains BOTH:
  // - Delphi logo SVG (left)
  // - Chat History icon + text (right) when logged-in
  const btn = queryVisible(doc, "header.delphi-talk-header button.delphi-header-logo");
  if (!btn) return false;

  // Logged-in detection
  const isLoggedIn = isDelphiLoggedIn(doc);

  // Case A: logged-in -> remove ONLY the Delphi logo svg (display:none)
  if (isLoggedIn) {
    const delphiSvg = btn.querySelector(":scope > svg");
    if (!delphiSvg) return false;

    if (delphiSvg.style.display !== "none") {
      delphiSvg.style.display = "none";
      dvLog(LOG_PREFIX, "[delphi] chat: logged-in, hid Delphi SVG only");
      return true;
    }
    return false;
  }

  // Case B: logged-out -> keep existing behavior: hide the whole button but preserve layout
  // (this matches your current approach)
  if (btn.style.visibility !== "hidden") {
    btn.style.visibility = "hidden";
    dvLog(LOG_PREFIX, "[delphi] chat: logged-out, hid header logo button (layout preserved)");
    return true;
  }

  return false;
});

// Chat mode (logged-in): when Chat History drawer/dialog is open,
// hide Delphi brand icon + Delphi wordmark inside the drawer header.
function ruleChatHistoryDialogHideDelphiBrandSvgs() {
  return {
    name: "chat-history-dialog-hide-delphi-brand-svgs",

    apply(doc) {
      const mode = doc.__delphiMode || getDelphiMode(doc);
      if (mode !== "chat_mode") return false;

      // Only when logged in
      if (!isDelphiLoggedIn(doc)) return false;

      // Only when the drawer/dialog is actually open
      const dialog = doc.querySelector("div[role='dialog'][data-state='open']");
      if (!dialog) return false;

      // Inside the dialog header, target the Delphi nav link
      const delphiNav = dialog.querySelector(
        "header a[role='navigation'][aria-label='Delphi']"
      );
      if (!delphiNav) return false;

      // Idempotency guard: do not re-apply on every DOM tick
      if (delphiNav.__dvHideBrandSvgsApplied) return false;
      delphiNav.__dvHideBrandSvgsApplied = true;

      // Hide BOTH SVGs (logo mark + wordmark), keep anchor in DOM
      const svgs = delphiNav.querySelectorAll("svg");
      if (!svgs || svgs.length === 0) return false;

      svgs.forEach((svg) => {
        svg.style.display = "none";
      });

      // Extra safety: remove the visual gap that was between the two SVGs
      delphiNav.style.gap = "0";

      return true;
    },
  };
}

// Call mode: hide avatar picture + name block in delphi nav
addDomRule("call-hide-header-profile-block", (doc) => {
  const mode = doc.__delphiMode || getDelphiMode(doc);
  if (mode !== "call_mode") return false;

  const el = queryVisible(doc, ".delphi-call-header-link");
  if (!el) return false;

  if (el.style.visibility !== "hidden") {
    el.style.visibility = "hidden";
    dvLog(LOG_PREFIX, "[delphi] call-hide-header-profile-block: hidden");
    return true;
  }

  return false;
});

// Apply built rules
addBuiltRule(ruleCallHeaderBackToChatLink()); //Call mode (desktop): replace Delphi logo with "Back to chat center"
addBuiltRule(ruleChatHistoryDialogHideDelphiBrandSvgs()); //hide Delphi brand icon + Delphi wordmark inside the 'chat history' drawer

/********************************************************************
 * Install observers inside iframe
 ********************************************************************/
function installIframeDomRuleEngine(iframe) {
  const doc = safeGetIframeDoc(iframe);
  if (!doc || !doc.documentElement) {
    dvLog(LOG_PREFIX, "iframe document not ready yet");
    return;
  }

  updateAndLogDelphiMode(doc);

  // Log auth state only when it changes (prevents console spam)
  const loggedInNow = isDelphiLoggedIn(doc);
  if (doc.__dvLoggedIn !== loggedInNow) {
    doc.__dvLoggedIn = loggedInNow;
    if (DV_DEBUG) dvLog(LOG_PREFIX, "logged in:", loggedInNow);
  }

  applyDomRules(doc);

  if (doc.__delphiDomRulesInstalled) {
    dvLog(LOG_PREFIX, "dom rules already installed");
    return;
  }
  doc.__delphiDomRulesInstalled = true;

  let scheduled = false;
  const scheduleApply = () => {
    if (scheduled) return;
    scheduled = true;
    (doc.defaultView || window).requestAnimationFrame(() => {
      scheduled = false;
      
      updateAndLogDelphiMode(doc);

      // Log auth state only when it changes (prevents console spam)
      const loggedInNow = isDelphiLoggedIn(doc);
      if (doc.__dvLoggedIn !== loggedInNow) {
        doc.__dvLoggedIn = loggedInNow;
        if (DV_DEBUG) dvLog(LOG_PREFIX, "logged in:", loggedInNow);
      }

      applyDomRules(doc);
    });
  };

  const obs = new MutationObserver(scheduleApply);
  obs.observe(doc.documentElement, { childList: true, subtree: true });

  iframe.addEventListener("load", () => {
    const nextDoc = safeGetIframeDoc(iframe);
    if (!nextDoc) return;

    updateAndLogDelphiMode(nextDoc);
    applyDomRules(nextDoc);
  });

  dvLog(LOG_PREFIX, "dom rules engine installed in iframe");
}

/********************************************************************
 * Bootstrap
 ********************************************************************/
document.addEventListener("DOMContentLoaded", async () => {
  dvLog(LOG_PREFIX, "DOMContentLoaded");

  try {
    const iframe = await waitForIframe(DELPHI_IFRAME_SELECTOR);
    dvLog(LOG_PREFIX, "iframe found", iframe);

    installIframeDomRuleEngine(iframe);
    setTimeout(() => installIframeDomRuleEngine(iframe), 250);
    setTimeout(() => installIframeDomRuleEngine(iframe), 1000);
  } catch (e) {
    dvError(LOG_PREFIX, e);
  }
});
