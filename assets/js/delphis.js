/********************************************************************
 * Constants
 ********************************************************************/
const IFRAME_GO_TO_PROFILE = "Back to chat center"; // keeping your constant
const DELPHI_IFRAME_SELECTOR = "#delphi-frame";
const LOG_PREFIX = "[delphi-domrules]";
const IFRAME_WAIT_TIMEOUT_MS = 15000;

/********************************************************************
 * Tiny logger
 ********************************************************************/
function log(...args) {
  // comment out if you want silence
  console.log(LOG_PREFIX, ...args);
}

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
  } catch (e) {
    // Cross-origin or not ready
    return null;
  }
}

/********************************************************************
 * DOM RULES
 * Keep the approach simple: rules are idempotent functions(doc) -> boolean
 ********************************************************************/
const domRules = [];

/**
 * Register a DOM rule. It will be applied repeatedly via observers.
 */
function addDomRule(name, fn) {
  domRules.push({ name, fn });
}

/**
 * Run all rules against a document.
 */
function applyDomRules(doc) {
  if (!doc) return;

  for (const rule of domRules) {
    try {
      const changed = !!rule.fn(doc);
      if (changed) log(`rule applied: ${rule.name}`);
    } catch (e) {
      console.warn(LOG_PREFIX, `rule error: ${rule.name}`, e);
    }
  }
}

/********************************************************************
 * RULE: Profile name "First Last" -> "First"
 *
 * Stable targeting (no Tailwind classes, no Radix ids):
 * - Detect profile context via: img[alt^="Profile image for"]
 * - Then find the closest reasonable container and the first <h1> within it.
 * - Replace textContent with the first token only.
 ********************************************************************/
addDomRule("profile-name-first-word-only", (doc) => {
  const profileImg = doc.querySelector('img[alt^="Profile image for"]');
  if (!profileImg) return false;

  // Prefer a nearby structural container rather than classes.
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

  // Only change if it looks like "First Last" (at least two tokens)
  const tokens = original.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;

  const firstName = tokens[0];
  if (h1.textContent.trim() === firstName) return false;

  h1.textContent = firstName;
  return true;
});

/********************************************************************
 * Attach observers inside the iframe so rules keep applying
 * across SPA navigations / re-renders.
 ********************************************************************/
function installIframeDomRuleEngine(iframe) {
  const doc = safeGetIframeDoc(iframe);
  if (!doc || !doc.documentElement) {
    log("iframe document not ready yet");
    return;
  }

  // Run once immediately
  applyDomRules(doc);

  // Avoid double-install
  if (doc.__delphiDomRulesInstalled) {
    log("dom rules already installed in iframe");
    return;
  }
  doc.__delphiDomRulesInstalled = true;

  // Mutation observer (throttled)
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

  // Also re-run on load (some apps replace the whole tree)
  iframe.addEventListener("load", () => {
    const nextDoc = safeGetIframeDoc(iframe);
    if (nextDoc) applyDomRules(nextDoc);
  });

  log("dom rules engine installed in iframe");
}

/********************************************************************
 * Bootstrap
 ********************************************************************/
document.addEventListener("DOMContentLoaded", async () => {
  log("DOMContentLoaded");

  try {
    const iframe = await waitForIframe(DELPHI_IFRAME_SELECTOR);
    log("iframe found:", iframe);

    // Try now, and again shortly after (covers hydration timing)
    installIframeDomRuleEngine(iframe);
    setTimeout(() => installIframeDomRuleEngine(iframe), 250);
    setTimeout(() => installIframeDomRuleEngine(iframe), 1000);
  } catch (e) {
    console.warn(LOG_PREFIX, e);
  }
});
