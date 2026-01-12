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

/********************************************************************
 * RULE: Profile name "First Last" → "First"
 ********************************************************************/
addDomRule("profile-name-first-word-only", (doc) => {
  const profileImg = doc.querySelector('img[alt^="Profile image for"]');
  if (!profileImg) return false;

  const scope =
    profileImg.closest("section") ||
    profileImg.closest("main") ||
    doc.querySelector("main") ||
    doc.body;

  if (!scope) return false;

  const h1 = scope.querySelector("h1");
  if (!h1) return false;

  const original = (h1.textContent || "").trim();
  if (!original) return false;

  const tokens = original.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;

  const firstName = tokens[0];
  if (h1.textContent.trim() === firstName) return false;

  h1.textContent = firstName;
  return true;
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
      applyDomRules(doc);
    });
  };

  const obs = new MutationObserver(scheduleApply);
  obs.observe(doc.documentElement, { childList: true, subtree: true });

  iframe.addEventListener("load", () => {
    const nextDoc = safeGetIframeDoc(iframe);
    if (nextDoc) applyDomRules(nextDoc);
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
