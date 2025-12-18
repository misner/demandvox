/********************************************************************
 * Constants 
 ********************************************************************/
const MIN_IFRAME_VIEWPORT_RATIO = 0.87;
const INTRO_TITLE = "Hi, I'm Michael";
const RESIZE_INTERVAL_MS = 1500;
const IFRAME_GO_TO_PROFILE = "Back to chat center";

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
 * Keep usage consistent:
 *   dvLog("[feature] message", extra)
 *   dvWarn("[feature] warning", extra)
 *   dvError("[feature] error", extra)  // usually still important in prod
 */
function dvLog(...args) {
  if (DV_DEBUG) console.log(...args);
}
function dvWarn(...args) {
  if (DV_DEBUG) console.warn(...args);
}
function dvError(...args) {
  // keep errors even in production because they signal breakage.
  // If you want them silent too, change this to: if (DV_DEBUG) console.error(...)
  console.error(...args);
}

/********************************************************************
 * Mode detector
 ********************************************************************/
function getDelphiMode(doc) {
  if (!doc) return "unknown_mode";

  // CHAT view: conversation + composer
  if (doc.querySelector(".delphi-chat-conversation")) {
    return "chat_mode";
  }

  // OVERVIEW / PROFILE view
  if (doc.querySelector(".delphi-profile-container")) {
    return "overview_mode";
  }

  if (doc.querySelector(".delphi-call-container")) {
    return "call_mode";
  }
  return "unknown_mode";
}

/********************************************************************
 * Delphi DOM Watchers (extensible rules, single observer)
 ********************************************************************/
function getIframeDoc(iframe) {
  try {
    return iframe.contentDocument || iframe.contentWindow?.document || null;
  } catch (e) {
    dvWarn("[delphi] Cannot access iframe document", e);
    return null;
  }
}

function ensureDelphiWatcherRuntime(iframe) {
  const doc = getIframeDoc(iframe);
  if (!doc || !doc.body) return null;

  // Create a single runtime per iframe document
  if (doc.__dvWatcherRuntime) return doc.__dvWatcherRuntime;

  const runtime = {
    installed: false,
    rules: [],
    runAll: null,
  };

  const runAll = () => {
    for (const rule of runtime.rules) {
      try {
        rule.apply(doc);
      } catch (e) {
        dvWarn(`[delphi] Rule failed: ${rule.name}`, e);
      }
    }
  };
  runtime.runAll = runAll;

  // Debounced execution to reduce strain on heavy DOM churn
  let scheduled = false;
  const scheduleRun = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      runAll();
    });
  };

  // Install one observer for everything we want to “enforce”
  const obs = new MutationObserver(scheduleRun);
  obs.observe(doc.body, { childList: true, subtree: true, characterData: true });

  runtime.installed = true;
  doc.__dvWatcherRuntime = runtime;

  // Run once immediately as well
  runAll();

  return runtime;
}

function addDelphiDomRule(iframe, rule) {
  const runtime = ensureDelphiWatcherRuntime(iframe);
  if (!runtime) return;

  // Avoid duplicates if inject runs multiple times
  if (runtime.rules.some((r) => r.name === rule.name)) return;

  runtime.rules.push(rule);

  // Apply right away
  runtime.runAll();
}

/********************************************************************
 * Rule builders
 * Add reusable rule builders (so adding more later is easy)
 *   Later, when you want more behaviors, you add more builders like: ruleSetAttribute,
 *   ruleMoveElement, ruleSwapImageSrc, ruleRemoveElement …without adding more observers.
 ********************************************************************/
function ruleForceText({ name, selector, getText }) {
  return {
    name,
    apply(doc) {
      const el = doc.querySelector(selector);
      if (!el) return;

      const desired = String(getText());
      const current = (el.textContent || "").trim();

      if (current !== desired) {
        el.textContent = desired;
        dvLog(`[delphi] ${name}: text updated`);
      }
    },
  };
}

function ruleHideButKeepLayout({ name, selector }) {
  return {
    name,
    apply(doc) {
      const el = doc.querySelector(selector);
      if (!el) return;

      if (el.style.visibility !== "hidden") {
        el.style.visibility = "hidden";
        dvLog(`[delphi] ${name}: hidden (layout preserved)`);
      }
    },
  };
}

function ruleRemoveElement({ name, selector }) {
  return {
    name,

    apply(doc) {
      const el = doc.querySelector(selector);
      if (!el) return;

      // Remove element entirely from the DOM
      el.remove();

      dvLog(`[delphi] ${name}: element removed from DOM`);
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
  const selector = "header.delphi-call-header a[aria-label='Delphi']";

  return {
    name: "call-header-back-to-chat-link",
    selector,

    apply(doc) {
      const link = doc.querySelector(selector);
      if (!link) return;

      // idempotency guard
      if (link.__dvBackToChatApplied) return;
      link.__dvBackToChatApplied = true;

      // Make it go where the chevron takes you
      link.setAttribute("href", "/chat");

      // Replace the SVG (and any children) with text
      link.textContent = IFRAME_GO_TO_PROFILE;

      // Reset classes then apply desired styling (desktop only)
      link.className = "";
      link.classList.add("text-sand-11", "hidden", "text-sm", "font-medium", "md:block");

      // Keep it from wrapping, and ensure it behaves like a text link
      link.style.whiteSpace = "nowrap";
      link.style.display = "inline-flex";
      link.style.alignItems = "center";

      // Optional, but harmless
      link.setAttribute("aria-label", "Back to Chat center");

      // Hide the vertical divider next to the logo
      const divider = link.closest("span")?.nextElementSibling;
      if (divider && divider.getAttribute("role") === "presentation") {
        divider.style.visibility = "hidden";
      }
    },
  };
}

/**
 * Hide Delphi logo in PROFILE / OVERVIEW header
 * while keeping layout stable and removing interaction.
 */
function ruleProfileHeaderHideDelphiLogo() {
  return {
    name: "profile-header-delphi-logo-hidden",

    // Profile / Overview ONLY
    selector: ".delphi-profile-container > header a[aria-label='Delphi']",

    apply(doc) {
      const el = doc.querySelector(this.selector);
      if (!el) return;

      // 1. Hide visually BUT keep layout space
      if (el.style.visibility !== "hidden") {
        el.style.visibility = "hidden";
      }

      // 2. Prevent any interaction
      if (el.style.pointerEvents !== "none") {
        el.style.pointerEvents = "none";
      }

      // 3. Defensive: prevent keyboard / navigation activation
      el.removeAttribute("href");
      el.removeAttribute("role");
    },
  };
}

/********************************************************************
 * Register all DOM enforcement rules
 ********************************************************************/
function registerDelphiDomRules(iframe) {
  //Add “install once” guard to DOM watcher runtime
  if (iframe.__dvDomRulesInstalled) return;
  iframe.__dvDomRulesInstalled = true;

  /* CHAT_mode view 
  */
  // Profile/Overview H1: "Hi, I'm Michael"
  addDelphiDomRule(
    iframe,
    ruleForceText({
      name: "overview-title",
      selector: ".delphi-profile-container header h1.text-xl.font-medium",
      getText: () => INTRO_TITLE,
    })
  );

  // Chat header title: hide but keep layout (your existing requirement)
  // addDelphiDomRule(
  //   iframe,
  //   ruleHideButKeepLayout({
  //     name: "chat-header-title-hidden",
  //     selector: "h1.delphi-talk-title-text",
  //   })
  // );

  addDelphiDomRule(
    iframe,
    ruleRemoveElement({
      name: "chat-header-title-removed",
      selector: "h1.delphi-talk-title-text",
    })
  );

  /* CALL_mode view
  */
  // Call header: hide delphi logo, pic & green dot
  addDelphiDomRule(
    iframe,
    ruleHideButKeepLayout({
      name: "call-header-profile-block-hidden",
      selector: "header.delphi-call-header .delphi-call-header-link",
    })
  );

  addDelphiDomRule(
    iframe,
    ruleCallHeaderBackToChatLink()
  );

  /* OVERVIEW_mode view
  */
  addDelphiDomRule(
    iframe,
    ruleProfileHeaderHideDelphiLogo()
  );
  
}

/********************************************************************
 * Wait until iframe exists
 ********************************************************************/
function waitForIframe(selector, onFound) {
  dvLog("[delphi-styling] Waiting for iframe:", selector);

  const MAX_TIME = 15000;  // 15s timeout
  const INTERVAL = 200;

  const start = Date.now();

  const timer = setInterval(() => {
    const iframe = document.querySelector(selector);

    if (iframe) {
      dvLog("[delphi-styling] Iframe found:", iframe);

      // Give the iframe an initial MIN_IFRAME_VIEWPORT_RATIO% viewport height
      // so there is no visible jump when resizeIframe() runs
      // - applied the moment the iframe appears, before it loads
      // prevents the "jump" when there are no messages
      //(when no messages it used to jump from high up to bottom
      // with our MIN_IFRAME_VIEWPORT_RATIO% of height rule
      const initialMinHeight = Math.floor(window.innerHeight * MIN_IFRAME_VIEWPORT_RATIO);
      iframe.style.minHeight = initialMinHeight + "px";
      iframe.style.height = initialMinHeight + "px";
      iframe.style.width = "100%";
      
      clearInterval(timer);
      onFound(iframe);
      return;
    }

    if (Date.now() - start > MAX_TIME) {
      dvError("[delphi-styling] Timeout: iframe not found");
      clearInterval(timer);
    }
  }, INTERVAL);
}

/******************************************************************
 * Auto-resize strategy overview
 * ---------------------------------------------------------------
 * This system supports:
 * - Initial page load
 * - Direct deep links into chat
 * - Conversations with existing messages
 *
 * It achieves this through:
 * - Immediate sizing on init
 * - Periodic reconciliation (SPA-safe)
 * - Explicit correction when entering chat mode
 ******************************************************************/
function enableIframeAutoResize(iframe) {
  /******************************************************************
   * Install-once guard
   * ---------------------------------------------------------------
   * This function may be called multiple times:
   * - iframe load
   * - route/view changes inside Delphi
   * - defensive re-initializations
   *
   * We must ensure auto-resize logic is installed only once
   * per iframe instance to avoid duplicated intervals and listeners.
   ******************************************************************/
  if (iframe.__dvAutoResizeInstalled) return;
  iframe.__dvAutoResizeInstalled = true;

  /******************************************************************
   * Access iframe document
   * ---------------------------------------------------------------
   * Required for:
   * - reading content height
   * - detecting Delphi mode (chat / overview / call)
   ******************************************************************/
  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!doc) {
    dvWarn("[delphi-resize] iframe document not available");
    return;
  }

  /******************************************************************
   * Track current Delphi mode across executions
   * ---------------------------------------------------------------
   * Modes:
   * - "chat"     → scrolling + input pinned behavior required
   * - "overview" → static profile layout
   * - "voice"    → different layout again
   *
   * We only react when the mode actually changes.
   ******************************************************************/
  let lastMode = getDelphiMode(doc);
  dvLog("[delphi-resize] initial mode:", lastMode);

  /******************************************************************
   * Scroll state flags
   * ---------------------------------------------------------------
   * userHasScrolled:
   *   Becomes true once the user manually scrolls the outer page
   *   while in chat mode. Prevents auto-scroll from fighting the user.
   *
   * firstAutoScrollDone:
   *   Ensures auto-scroll runs only once per chat entry, even if
   *   resize logic executes multiple times.
   ******************************************************************/
  let userHasScrolled = false;
  let firstAutoScrollDone = false;

  /******************************************************************
   * Scroll outer page so iframe bottom aligns with viewport bottom
   * ---------------------------------------------------------------
   * This is what brings the composer into view in chat mode.
   ******************************************************************/
  function scrollOuterPageToIframeBottom() {
    const rect = iframe.getBoundingClientRect();
    const iframeBottomInPage = window.scrollY + rect.bottom;
    const targetScrollTop = iframeBottomInPage - window.innerHeight;

    if (targetScrollTop > 0) {
      dvLog("[delphi-resize] Auto-scrolling outer page to", targetScrollTop);
      window.scrollTo({ top: targetScrollTop, behavior: "auto" });
    }
  }

  /******************************************************************
   * Choose a better "height root" per mode
   * ---------------------------------------------------------------
   * In SPA UIs, documentElement.scrollHeight can stay stable even
   * when the visible view changes, because hidden views may remain
   * mounted in the DOM.
   *
   * So we try to measure the active view container first.
   ******************************************************************/
  function getActiveHeightRoot(mode) {
    if (mode === "chat_mode") {
      // Prefer the chat view container if present
      return (
        doc.querySelector(".delphi-chat-conversation") ||
        doc.querySelector("[data-sentry-component='Talk']") ||
        doc.body
      );
    }

    if (mode === "overview_mode") {
      return doc.querySelector(".delphi-profile-container") || doc.body;
    }

    if (mode === "call_mode") {
      return doc.querySelector(".delphi-call-container") || doc.body;
    }

    return doc.body || doc.documentElement;
  }

  /******************************************************************
   * resizeIframe()
   * ---------------------------------------------------------------
   * Core resizing logic:
   * - Never smaller than MIN_IFRAME_VIEWPORT_RATIO of viewport
   * - Grow with content of the active view
   * - Controlled auto-scroll in chat mode only
   ******************************************************************/
  function resizeIframe() {
    const mode = getDelphiMode(doc);

    const minHeight = Math.floor(window.innerHeight * MIN_IFRAME_VIEWPORT_RATIO);

    // Measure from the active view container when possible
    const root = getActiveHeightRoot(mode);

    // scrollHeight is still the most practical metric, but on a smaller subtree
    const contentHeight = root ? root.scrollHeight : doc.documentElement.scrollHeight;

    const finalHeight = Math.max(contentHeight, minHeight);

    iframe.style.height = finalHeight + "px";

    /**************************************************************
     * Auto-scroll logic (steady state)
     * -----------------------------------------------------------
     * When we are already in chat mode, we may need one correction
     * to keep the composer visible.
     
     * Auto-scroll logic (chat mode)
     * -----------------------------------------------------------
     * Ensures the composer is visible when entering chat.
     * Runs:
     * - Only in chat mode
     * - Only if the user has not scrolled manually
     * - Only once per chat entry
     *
     * Note:
     * This correction is performed even if the iframe height
     * does not exceed the viewport.
     **************************************************************/
    if (mode === "chat_mode" && !userHasScrolled && !firstAutoScrollDone) {
      scrollOuterPageToIframeBottom();
      firstAutoScrollDone = true;
    }
  }

  /******************************************************************
   * Detect manual user scroll
   * ---------------------------------------------------------------
   * If the user scrolls while in chat mode, disable auto-scroll
   * so we never fight the user.
   ******************************************************************/
  window.addEventListener(
    "scroll",
    () => {
      if (getDelphiMode(doc) === "chat_mode") {
        userHasScrolled = true;
      }
    },
    { passive: true }
  );

  /******************************************************************
   * Initial sizing
   ******************************************************************/
  resizeIframe();

  /******************************************************************
   * Periodic reconciliation loop
   * ---------------------------------------------------------------
   * Keeps us robust against Delphi SPA view changes.
   * Runs continuously to keep iframe size in sync with content.
   * Mode changes trigger additional corrective behavior.
   
   * Why polling?
   * ---------------------------------------------------------------
   * Delphi is a SPA with no stable public events for:
   * - View transitions (overview / chat / call)
   * - Message streaming
   * - Layout recalculations
   *
   * A lightweight polling loop ensures resilience without
   * coupling to internal Delphi implementation details.
   **************************************************************/
  iframe.__dvResizeIntervalId = setInterval(() => {
    const mode = getDelphiMode(doc);

    // Always keep size reasonably fresh
    resizeIframe();

    /**************************************************************
     * Mode transition handling
     **************************************************************/
    if (mode !== lastMode) {
      dvLog("[delphi-resize] mode change:", lastMode, "→", mode);

      /**********************************************************
       * Entering chat mode
       * -------------------------------------------------------
       * We force a fresh scroll correction regardless of height.
       * This fixes the case: start in overview, click Chat, and
       * the composer is below the fold.
       **********************************************************/
      if (mode === "chat_mode") {
        userHasScrolled = false;
        firstAutoScrollDone = false;

        // Let layout settle before correcting
        setTimeout(() => {
          resizeIframe();

          // Always do the correction when entering chat
          scrollOuterPageToIframeBottom();
          firstAutoScrollDone = true;
        }, 150);
      }

      lastMode = mode;
    }
  }, RESIZE_INTERVAL_MS);
}

/********************************************************************
 * Pre-inject CSS IMMEDIATELY to kill iframe scrollbar
 * This prevents the iframe scrollbar flash AND the scrollbar tip.
 ********************************************************************/
function preKillIframeScrollbar(iframe) {
  try {
    // Kill frame-level scrollbar
    iframe.setAttribute("scrolling", "no");
    iframe.style.overflow = "hidden";

    const doc = iframe.contentDocument || iframe.contentWindow.document;
    if (!doc) return;

    const style = doc.createElement("style");
    style.textContent = `
      /* HARD override to remove scrollbars inside the iframe instantly */
      html, body {
        scrollbar-width: none !important;      /* Firefox */
        -ms-overflow-style: none !important;   /* IE */
      }
      html::-webkit-scrollbar,
      body::-webkit-scrollbar {
        display: none !important;              /* Chrome / Safari */
      }
    `;
    doc.head.appendChild(style);
  } catch (e) {
    dvWarn("[delphi-styling] Cannot pre-inject scrollbar-kill CSS", e);
  }
}

/********************************************************************
 * Inject Over-rides into the iframe safely
 ********************************************************************/
function injectOverridesIntoIframe(iframe) {
  dvLog("[delphi-styling] injectOverridesIntoIframe called");

  // Kill iframe scrollbar as early as possible
  preKillIframeScrollbar(iframe);

  function doInject() {
    let doc;
    try {
      doc = iframe.contentDocument || iframe.contentWindow.document;
      dvLog("[delphi-styling] iframe.contentDocument is:", doc);
    } catch (e) {
      dvError("[delphi-styling] Cannot access iframe document", e);
      return;
    }

    if (!doc) {
      dvError("[delphi-styling] iframe document is NULL");
      return;
    }

    const head = doc.head;
    if (!head) {
      dvError("[delphi-styling] No <head> in iframe doc");
      return;
    }

    // CSS injections
    const INJECT_CSS_STYLE_ID = "dv-delphi-overrides";
    let style = doc.getElementById(INJECT_CSS_STYLE_ID);
    
    if (!style) {
      style = doc.createElement("style");
      style.id = INJECT_CSS_STYLE_ID;
      head.appendChild(style);
    }
    
    style.textContent = `
      /* Example: styling access confirmed */
      /* .delphi-talk-container { background: red !important; } */

      /* IMPORTANT: do NOT hide overflow here anymore or scrolling breaks */
      html, body {
        overflow: visible !important;
        height: auto !important;

        /* Keep scrollbars visually hidden but content still allowed to overflow */
        scrollbar-width: none !important;      /* Firefox */
        -ms-overflow-style: none !important;   /* IE */
      }
      html::-webkit-scrollbar,
      body::-webkit-scrollbar {
        display: none !important;              /* Chrome / Safari */
      }

      /* Remove the left Delphi logo button (desktop) AND the mobile one */
      button.delphi-header-logo {
        display: none !important;
      }
      
      /* Make the chat top nav a simple "left content / right actions" bar */
      nav.from-sand-1.bg-sand-1.grid {
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
      }
      
      /* Ensure the title block (avatar + hidden h1) sits on the left */
      nav.from-sand-1.bg-sand-1 .delphi-talk-title-link {
        justify-content: flex-start !important;
        width: auto !important;
      }
      
      /* Optional: avoid the middle container trying to center things */
      nav.from-sand-1.bg-sand-1 [data-sentry-component="TalkTitle"] {
        margin: 0 !important;
      }
      
      /* Set as invisible to make sure ven if we remove
      that it does not appear for a quick second before removal
      (optional but harmless - alreayd done inline) */
      h1.delphi-talk-title-text {
        visibility: hidden !important;
      }

      /* Keep existing title invisibility
      (optional but harmless - alreayd done inline) */
      h1.delphi-call-header-title {
        visibility: hidden !important;
      }
    `;
    
    dvLog("[delphi-styling] CSS injected into iframe"); 

    // Install + keep enforcing DOM rules (single observer)
    registerDelphiDomRules(iframe);

    // Enable automatic resizing after CSS injection
    enableIframeAutoResize(iframe);
  }

  doInject();
}

/********************************************************************
 * Start execution once the DOM is ready
 ********************************************************************/
document.addEventListener("DOMContentLoaded", () => {
  dvLog("[delphi-styling] DOMContentLoaded");

  waitForIframe("#delphi-frame", (iframe) => {
    // CSS + layout overrides (safe to re-run)
    injectOverridesIntoIframe(iframe);  
 
    // Re-run only CSS overrides on iframe reload
    iframe.addEventListener("load", () => {
      injectOverridesIntoIframe(iframe);
    });
  });

});
