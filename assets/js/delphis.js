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

function (doc) {
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



/********************************************************************
 * DOM RULES ENGINE
 ********************************************************************/
const domRules = [];

function addDomRule(name, fn) {
  domRules.push({ name, fn });
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


addDomRule("profile-name-first-word-only", (doc) => {
  const mode = getDelphiMode(doc);

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


/********************************************************************
 * Install observers inside iframe
 ********************************************************************/
function installIframeDomRuleEngine(iframe) {
  const doc = safeGetIframeDoc(iframe);
  if (!doc || !doc.documentElement) {
    dvLog(LOG_PREFIX, "iframe document not ready yet");
    return;
  }

  applyDomRules(doc);

  updateAndLogDelphiMode(doc);//log Delphi mode

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
      applyDomRules(doc);
    });
  };

  const obs = new MutationObserver(scheduleApply);
  obs.observe(doc.documentElement, { childList: true, subtree: true });

  iframe.addEventListener("load", () => {
    const nextDoc = safeGetIframeDoc(iframe);
    if (!nextDoc) return;

    updateAndLogDelphiMode(nextDoc);//log updated delphi mode
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
