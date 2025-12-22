/********************************************************************
 * Constants 
 ********************************************************************/
const MIN_IFRAME_VIEWPORT_RATIO = 0.87;
const INTRO_TITLE = "Hi, I'm Michael";
const RESIZE_INTERVAL_MS = 1500;
const IFRAME_GO_TO_PROFILE = "Back to chat center";

/**
 * Flicker/jump reduction on SPA mode transitions:
 * - We hide the iframe briefly while we:
 *   1) pre-reset height (break dvh feedback loops)
 *   2) measure until stable (a few RAF ticks)
 * - Then we reveal once the height is stable.
 */
const MODE_ENTRY_STABILIZE_MAX_MS = 450; // cap total stabilization time
const MODE_ENTRY_STABLE_FRAMES = 2;      // how many consecutive stable frames required
const MODE_ENTRY_STABLE_EPS_PX = 2;      // "stable" tolerance in px

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
function isElementVisible(el, view) {
  if (!el) return false;
  try {
    const cs = view?.getComputedStyle ? view.getComputedStyle(el) : null;
    if (cs) {
      if (cs.display === "none") return false;
      if (cs.visibility === "hidden") return false;
    }
    // getClientRects() is a good proxy for "is it currently rendered/laid out"
    return el.getClientRects().length > 0;
  } catch {
    // If we cannot compute, fallback to presence
    return true;
  }
}

function queryVisible(doc, selector) {
  const view = doc?.defaultView || window;
  const el = doc?.querySelector(selector);
  return isElementVisible(el, view) ? el : null;
}

function getDelphiMode(doc) {
  if (!doc) return "unknown_mode";

  // Prefer "what is visible" rather than "what exists in DOM"
  // because Delphi is a SPA and can keep previous screens mounted.

  // 1) Call mode
  if (queryVisible(doc, ".delphi-call-container")) return "call_mode";

  // 2) Chat mode
  if (
    queryVisible(doc, ".delphi-chat-conversation") ||
    queryVisible(doc, "[data-sentry-component='Talk']")
  ) {
    return "chat_mode";
  }

  // 3) Overview / Profile mode
  if (queryVisible(doc, ".delphi-profile-container")) return "overview_mode";

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
 * Note on when to use Rules and when to use CSS_INJECT futher below
 *   Use Rules to change/remove an element; use CSS_INJECT to do a css injection noably 
 *   when it's on a Tailwind utility class (ex: pt6) and we want an !important override 
 *   that reliably beats class-based styling.
 *   Why we don't need a separate DOM rule for padding, because: tailwind css is class-driven, so inline el.style.paddingTop 
 *   can still lose if later renders re-apply classes/styles and CSS_INJECT use! important
 *   making it stable across re-renders.
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

      // Idempotency guard in case the node is re-mounted quickly
      if (el.__dvRemoved) return;
      el.__dvRemoved = true;

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

function ruleCallModeRemoveNameH2() {
  return ruleRemoveElement({
    name: "call-mode-name-h2-removed",
    selector:
      "div.delphi-call-container h2.delphi-call-clone-indicator-title",
  });
}

function ruleRemoveScrollToBottomButton() {
  return ruleRemoveElement({
    name: "scroll-to-bottom-removed",
    selector: ".delphi-scroll-to-bottom",
  });
}


/********************************************************************
 * Register all DOM enforcement rules
 ********************************************************************/
function registerDelphiDomRules(iframe) {
  //Add “install once” guard to DOM watcher runtime
  if (iframe.__dvDomRulesInstalled) return;
  iframe.__dvDomRulesInstalled = true;

  /* OVERVIEW_mode view
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
  
  addDelphiDomRule(
    iframe,
    ruleProfileHeaderHideDelphiLogo()
  );
  
  /* CHAT_mode view 
  */  
  addDelphiDomRule(
    iframe,
    ruleRemoveElement({
      name: "chat-header-title-removed",
      selector: "h1.delphi-talk-title-text",
    })
  );
  
  /* GLOBAL – remove Delphi "scroll to bottom" arrow */
  addDelphiDomRule(
    iframe,
    ruleRemoveScrollToBottomButton()
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

  addDelphiDomRule(
    iframe,
    ruleCallModeRemoveNameH2()
  );
  
}

/********************************************************************
 * Iframe Helpers
 ********************************************************************/
function setIframeBusy(iframe, isBusy) {
  if (!iframe) return;

  // Make hide immediate (avoid "fade then jump still visible")
  if (isBusy) {
    iframe.style.transition = "none";
    iframe.style.opacity = "0";
    iframe.style.pointerEvents = "none";
  } else {
    // Restore a subtle fade-in only when revealing
    iframe.style.transition = "opacity 120ms ease";
    iframe.style.opacity = "1";
    iframe.style.pointerEvents = "auto";
  }
}

//used to wait SP mounts iframe
//wait for next paint (or two)” instead of “wait N ms” with a simple interval
//It typically reduces variability and avoids feeling sluggish.
function afterNextPaint(fn) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

/********************************************************************
 * Outer scroll state tracker (parent page)
 * ---------------------------------------------------------------
 * Keeps a flag that tells us whether the OUTER page is at bottom.
 * We use it to decide whether to block Delphi's native autoscroll.
 ********************************************************************/
function ensureOuterScrollTracker() {
  // Install-once guard
  if (window.__dvOuterScrollTrackerInstalled) return;
  window.__dvOuterScrollTrackerInstalled = true;

  window.__dvOuterAtBottom = true; // default optimistic

  const compute = () => {
    const docEl = document.documentElement;
    const body = document.body;

    const scrollTop =
      window.pageYOffset ||
      docEl.scrollTop ||
      body.scrollTop ||
      0;

    const viewportH = window.innerHeight || docEl.clientHeight || 0;

    const scrollH = Math.max(
      body.scrollHeight || 0,
      docEl.scrollHeight || 0
    );

    // Small tolerance because browsers can land at (scrollHeight - 1)
    const tolerance = 2;

    const atBottom = scrollTop + viewportH >= scrollH - tolerance;
    window.__dvOuterAtBottom = atBottom;
  };

  // Compute immediately and on every scroll/resize
  compute();
  window.addEventListener("scroll", compute, { passive: true });
  window.addEventListener("resize", compute);

  dvLog("[delphi-scroll] Outer scroll tracker installed");
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
   * Choose a better "height root" per mode
   * ---------------------------------------------------------------
   * In SPA UIs, documentElement.scrollHeight can stay stable even
   * when the visible view changes, because hidden views may remain
   * mounted in the DOM.
   *
   * So we try to measure the active view container first.
   ******************************************************************/  
  function getActiveHeightRoot(mode) {
    // Match the (now visibility-based) mode detection.
    // This prevents “mounted but hidden” screens from polluting height.
    if (mode === "call_mode") {
      return queryVisible(doc, ".delphi-call-container") || doc.body;
    }

    if (mode === "chat_mode") {
      return (
        queryVisible(doc, ".delphi-chat-conversation") ||
        queryVisible(doc, "[data-sentry-component='Talk']") ||
        doc.body
      );
    }

    if (mode === "overview_mode") {
      return queryVisible(doc, ".delphi-profile-container") || doc.body;
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

    // In chat_mode, the main content can live inside an internal scroll container.
    // If we measure only that subtree, we may under-measure and lose access to the true top
    // of the conversation on long threads (outer page can't scroll far enough).
    // We therefore take the max across multiple roots (document + likely containers).
    let contentHeight;
    if (mode === "chat_mode") {
      
      /*****************************************************************       
       * Chat height should be driven by the conversation content,
       * not by document/body scrollHeight (those can include other
       * hidden views and inflate the iframe height).
       *****************************************************************/
      const convo = doc.querySelector(".delphi-chat-conversation");
      const talk = doc.querySelector("[data-sentry-component='Talk']");
      const convoH = convo?.scrollHeight || 0;
      const talkH = talk?.scrollHeight || 0;
      const rootH = root?.scrollHeight || 0;
      const docH = doc.documentElement?.scrollHeight || 0;

      // Primary measurement: visible chat content
      let best = Math.max(convoH, talkH, rootH);

      // Defensive fallback: only trust docH if it's close to the best value,
      // or if we couldn't find any meaningful chat root at all.
      if (best === 0 || docH <= best * 1.2) {
        best = Math.max(best, docH);
      }

      contentHeight = best;
      
    } else {
      // scrollHeight is still the most practical metric, but on a smaller subtree
      contentHeight = root ? root.scrollHeight : doc.documentElement.scrollHeight;
    }

    const finalHeight = Math.max(contentHeight, minHeight);
    iframe.style.height = finalHeight + "px";
    
  }

  /**
   * Stabilize height on mode entry (call/overview):
   * - hide iframe immediately
   * - pre-reset to baseline height
   * - measure across RAF until height stops changing
   * - set final height once stable, then reveal
   */
  function stabilizeHeightOnModeEntry(targetMode) {
    const startedAt = performance.now();
    const minHeight = Math.floor(window.innerHeight * MIN_IFRAME_VIEWPORT_RATIO);

    setIframeBusy(iframe, true);

    // Break dvh feedback loop right away
    iframe.style.height = minHeight + "px";
    dvLog("[delphi-resize] stabilize: pre-reset height", minHeight, "for", targetMode);

    let lastMeasured = -1;
    let stableFrames = 0;

    const tick = () => {
      const now = performance.now();
      const modeNow = getDelphiMode(doc);

      // If the mode changed again while stabilizing, abort safely
      if (modeNow !== targetMode) {
        dvLog("[delphi-resize] stabilize: aborted (mode changed)", targetMode, "→", modeNow);
        setIframeBusy(iframe, false);
        return;
      }

      // Measure using the active root for this mode
      const root = getActiveHeightRoot(modeNow);
      const contentHeight = root ? root.scrollHeight : doc.documentElement.scrollHeight;
      const nextHeight = Math.max(contentHeight, minHeight);

      // Apply during stabilization, but keep hidden
      iframe.style.height = nextHeight + "px";

      if (lastMeasured >= 0 && Math.abs(nextHeight - lastMeasured) <= MODE_ENTRY_STABLE_EPS_PX) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
      }

      lastMeasured = nextHeight;

      const elapsed = now - startedAt;
      const done = stableFrames >= MODE_ENTRY_STABLE_FRAMES || elapsed >= MODE_ENTRY_STABILIZE_MAX_MS;

      if (done) {
        dvLog("[delphi-resize] stabilize: done", {
          mode: modeNow,
          finalHeight: nextHeight,
          stableFrames,
          elapsed: Math.round(elapsed),
        });

        // Reveal after final height is already applied
        requestAnimationFrame(() => setIframeBusy(iframe, false));
        return;
      }

      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  }

  /**
   * Factorized mode-change handler so both:
   * - MutationObserver (immediate)
   * - setInterval (fallback)
   * can share exactly the same logic.
   */
  function handleModeChange(nextMode, source) {
    dvLog("[delphi-resize] mode change:", lastMode, "→", nextMode, `(source=${source})`);

    if (nextMode === "chat_mode") {
      // resize after the view mounts
      afterNextPaint(() => {
        resizeIframe();
      });
    }

    if (nextMode === "call_mode" || nextMode === "overview_mode") {
      stabilizeHeightOnModeEntry(nextMode);
    }

    lastMode = nextMode;
  }

  /**
   * Immediate mode detection via MutationObserver:
   * triggers stabilization as soon as Delphi swaps screens,
   * instead of waiting for the 1.5s interval tick.
   */
  if (!doc.__dvModeObserverInstalled && doc.body) {
    doc.__dvModeObserverInstalled = true;

    let scheduled = false;

    const scheduleCheck = () => {
      if (scheduled) return;
      scheduled = true;

      requestAnimationFrame(() => {
        scheduled = false;

        const modeNow = getDelphiMode(doc);
        if (modeNow !== lastMode) {
          handleModeChange(modeNow, "mutation");
        }
      });
    };

    const modeObserver = new MutationObserver(scheduleCheck);
    modeObserver.observe(doc.body, { childList: true, subtree: true, attributes: true });

    // Optional: run once quickly after install (covers very fast transitions)
    scheduleCheck();

    doc.__dvModeObserver = modeObserver;
    dvLog("[delphi-resize] Mode observer installed");
  } 

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
  // Periodic safety net:
  // - Catches missed SPA transitions
  // - Reconciles height if DOM mutates outside observers
  iframe.__dvResizeIntervalId = setInterval(() => {
    // Always keep size fresh as a fallback
    resizeIframe();
    
    const mode = getDelphiMode(doc);

    // Fallback mode detection (in case mutations are missed)
    if (mode !== lastMode) {
      handleModeChange(mode, "interval");
    }    
  }, RESIZE_INTERVAL_MS);//note
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
    
  } catch (e) {
    dvWarn("[delphi-styling] Cannot pre-inject scrollbar-kill CSS", e);
  }
}

/********************************************************************
 * Inject Over-rides into the iframe safely
 ********************************************************************/

// Block Delphi native programmatic autoscroll (iframe)
// Delphi likely uses scrollIntoView / scrollTo during streaming.
// We block those calls ONLY when:
// - we're in chat_mode, AND
// - the outer page is NOT at bottom (user is reading above).
// This reduces the "yank to bottom of answer" effect.
function installIframeAutoScrollBlocker(iframe) {
  let win;
  let doc;

  try {
    win = iframe.contentWindow;
    doc = iframe.contentDocument || win?.document;
  } catch (e) {
    dvWarn("[delphi-scroll] Cannot access iframe window for blocker", e);
    return () => {};
  }

  if (!win || !doc) return () => {};

  // Install-once per iframe window
  if (win.__dvAutoScrollBlockerInstalled) {
    dvLog("[delphi-scroll] AutoScroll blocker already installed");
    return win.__dvAutoScrollBlockerUninstall || (() => {});
  }
  win.__dvAutoScrollBlockerInstalled = true;

  // --------------------------
  // Configuration
  // --------------------------
  const STREAM_IDLE_MS = 650; // unlock after no chat DOM changes for this long
  const DEBUG = true;

  // --------------------------
  // State
  // --------------------------
  let lockActive = false;
  let lockedOuterTop = 0;

  let lockedScroller = null;
  let lockedScrollerTop = 0;

  let guardRaf = 0;
  let idleTimer = 0;
  let streamObserver = null;

  // User intent tracking: if the user is actively scrolling, we should not fight them.
  let lastUserIntentTs = 0;
  const USER_INTENT_GRACE_MS = 450; // during this window we assume scroll is user-driven

  function markUserIntent(reason) {
    lastUserIntentTs = Date.now();
    if (DEBUG) dvLog("[delphi-scroll] user intent", reason);
  }

  function recentlyUserIntent() {
    return Date.now() - lastUserIntentTs < USER_INTENT_GRACE_MS;
  }


  const inChatMode = () => getDelphiMode(doc) === "chat_mode";

  function getOuterScrollTop() {
    const docEl = document.documentElement;
    const body = document.body;
    return (
      window.pageYOffset ||
      docEl.scrollTop ||
      body.scrollTop ||
      0
    );
  }

  function findChatScroller() {
    try {
      const candidates = [
        doc.querySelector(".delphi-chat-conversation"),
        doc.querySelector("[data-sentry-component='Talk']"),
      ].filter(Boolean);

      // fallback: any scrollable element with meaningful scrollHeight
      const all = Array.from(doc.querySelectorAll("div, main, section, ul"));
      for (const el of all) {
        const cs = win.getComputedStyle(el);
        const oy = cs?.overflowY;
        const canScrollY = oy === "auto" || oy === "scroll";
        if (!canScrollY) continue;
        if (el.scrollHeight <= el.clientHeight + 2) continue;
        candidates.push(el);
      }

      let best = null;
      let bestH = 0;
      for (const el of candidates) {
        const h = el.scrollHeight || 0;
        if (h > bestH) {
          bestH = h;
          best = el;
        }
      }
      return best;
    } catch (e) {
      dvWarn("[delphi-scroll] findChatScroller failed", e);
      return null;
    }
  }

  function ensureLockedScroller() {
    if (lockedScroller && doc.contains(lockedScroller)) return lockedScroller;
    lockedScroller = findChatScroller();
    if (lockedScroller) {
      lockedScrollerTop = lockedScroller.scrollTop || 0;
      dvLog("[delphi-scroll] lockedScroller set:", lockedScroller);
    } else {
      dvWarn("[delphi-scroll] No scrollable chat scroller found (OK if iframe has no internal scroll)");
    }
    return lockedScroller;
  }

  function startLock(reason) {
    if (!inChatMode()) {
      if (DEBUG) dvLog("[delphi-scroll] startLock ignored (not chat_mode)", reason);
      return;
    }

    // Capture positions immediately
    lockedOuterTop = getOuterScrollTop();

    const scroller = ensureLockedScroller();
    lockedScrollerTop = scroller ? (scroller.scrollTop || 0) : 0;

    lockActive = true;

    if (DEBUG) {
      dvLog("[delphi-scroll] LOCK ON", {
        reason,
        lockedOuterTop,
        lockedScrollerTop,
        hasScroller: Boolean(scroller),
      });
    }

    // Start guard immediately (microtask) + sustained (rAF)
    queueMicrotask(enforceLockOnce);
    startGuardLoop();

    // Start/refresh stream idle timer and observer
    armStreamObserver();
    bumpIdleTimer();
  }

  function stopLock(reason) {
    if (!lockActive) return;

    lockActive = false;

    if (guardRaf) cancelAnimationFrame(guardRaf);
    guardRaf = 0;

    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = 0;

    if (streamObserver) {
      try { streamObserver.disconnect(); } catch {}
      streamObserver = null;
    }

    if (DEBUG) dvLog("[delphi-scroll] LOCK OFF", { reason });
  }

  function bumpIdleTimer() {
    if (!lockActive) return;

    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stopLock("stream-idle");
    }, STREAM_IDLE_MS);
  }

  function armStreamObserver() {
    if (streamObserver) return;

    const root =
      doc.querySelector(".delphi-chat-conversation") ||
      doc.querySelector("[data-sentry-component='Talk']") ||
      doc.body;

    if (!root) return;

    streamObserver = new MutationObserver(() => {
      // Any DOM change during streaming extends the lock window
      if (!lockActive) return;
      bumpIdleTimer();
    });

    streamObserver.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: false,
    });

    if (DEBUG) dvLog("[delphi-scroll] stream observer armed");
  }

  function enforceLockOnce() {
    if (!lockActive) return;

    const userActive = recentlyUserIntent();

    // OUTER page: only block *downward* movement that is not user-driven
    const outerTop = getOuterScrollTop();

    if (userActive) {
      // User is scrolling: accept new baseline
      lockedOuterTop = outerTop;
    } else {
      // Delphi/programmatic scroll usually pushes downward; block only that direction
      if (outerTop > lockedOuterTop + 1) {
        window.scrollTo(0, lockedOuterTop);
        if (DEBUG) dvLog("[delphi-scroll] REVERT outer scroll down", { from: outerTop, to: lockedOuterTop });
      } else if (outerTop < lockedOuterTop - 1) {
        // Upward movement: allow and update baseline (prevents “sticky ceiling”)
        lockedOuterTop = outerTop;
      }
    }

    // Internal scroller (if any): only block *downward* movement that is not user-driven
    const scroller = ensureLockedScroller();
    if (scroller) {
      const cur = scroller.scrollTop || 0;

      if (userActive) {
        lockedScrollerTop = cur;
      } else {
        if (cur > lockedScrollerTop + 1) {
          scroller.scrollTop = lockedScrollerTop;
          if (DEBUG) dvLog("[delphi-scroll] REVERT scroller scroll down", { from: cur, to: lockedScrollerTop });
        } else if (cur < lockedScrollerTop - 1) {
          lockedScrollerTop = cur;
        }
      }
    }
  }


  function startGuardLoop() {
    if (guardRaf) return;

    const tick = () => {
      guardRaf = 0;
      if (!lockActive) return;

      enforceLockOnce();
      guardRaf = requestAnimationFrame(tick);
    };

    guardRaf = requestAnimationFrame(tick);
  }

  // --------------------------
  // Send detection (multiple signals)
  // --------------------------
  function onKeyDownCapture(e) {
    if (!inChatMode()) return;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      startLock("enter-send");
      // Do NOT stop propagation; Delphi must still receive Enter to send.
    }
  }

  function onClickCapture(e) {
    if (!inChatMode()) return;

    const t = e.target;
    if (!t) return;

    // Common patterns: button[type=submit], form submit button, send icon button
    const btn = t.closest?.("button");
    if (!btn) return;

    const type = (btn.getAttribute("type") || "").toLowerCase();
    if (type === "submit") {
      startLock("click-submit");
      return;
    }

    // Heuristic: aria-label mentions send
    const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
    if (aria.includes("send")) {
      startLock("click-send-aria");
      return;
    }
  }

  function onSubmitCapture(e) {
    if (!inChatMode()) return;
    startLock("form-submit");
  }

  doc.addEventListener("keydown", onKeyDownCapture, true);
  doc.addEventListener("click", onClickCapture, true);
  doc.addEventListener("submit", onSubmitCapture, true);

  // User intent signals (capture phase)
  const onWheelCapture = () => markUserIntent("wheel");
  const onTouchMoveCapture = () => markUserIntent("touchmove");

  const onKeyIntentCapture = (e) => {
    // Keys that typically scroll
    const keys = ["PageDown", "PageUp", "Home", "End", "ArrowDown", "ArrowUp", " "];
    if (keys.includes(e.key)) markUserIntent("key:" + e.key);
  };

  doc.addEventListener("wheel", onWheelCapture, { capture: true, passive: true });
  doc.addEventListener("touchmove", onTouchMoveCapture, { capture: true, passive: true });
  doc.addEventListener("keydown", onKeyIntentCapture, true);


  // --------------------------
  // Patch programmatic scroll APIs (secondary safety)
  // --------------------------
  const origScrollIntoView = win.Element?.prototype?.scrollIntoView;
  const origScrollTo = win.scrollTo;
  const origScrollBy = win.scrollBy;

  if (origScrollIntoView) {
    win.Element.prototype.scrollIntoView = function (...args) {
      if (lockActive && inChatMode()) {
        if (DEBUG) dvLog("[delphi-scroll] BLOCK scrollIntoView", this);
        return;
      }
      return origScrollIntoView.apply(this, args);
    };
  }

  if (typeof origScrollTo === "function") {
    win.scrollTo = function (...args) {
      if (lockActive && inChatMode()) {
        if (DEBUG) dvLog("[delphi-scroll] BLOCK iframe window.scrollTo", args);
        return;
      }
      return origScrollTo.apply(this, args);
    };
  }

  if (typeof origScrollBy === "function") {
    win.scrollBy = function (...args) {
      if (lockActive && inChatMode()) {
        if (DEBUG) dvLog("[delphi-scroll] BLOCK iframe window.scrollBy", args);
        return;
      }
      return origScrollBy.apply(this, args);
    };
  }

  dvLog("[delphi-scroll] AutoScroll blocker installed (HARD LOCK on send)");

  const uninstall = () => {
    try {
      stopLock("uninstall");

      doc.removeEventListener("keydown", onKeyDownCapture, true);
      doc.removeEventListener("click", onClickCapture, true);
      doc.removeEventListener("submit", onSubmitCapture, true);

      doc.removeEventListener("wheel", onWheelCapture, true);
      doc.removeEventListener("touchmove", onTouchMoveCapture, true);
      doc.removeEventListener("keydown", onKeyIntentCapture, true);


      if (origScrollIntoView && win.Element?.prototype) {
        win.Element.prototype.scrollIntoView = origScrollIntoView;
      }
      if (typeof origScrollTo === "function") win.scrollTo = origScrollTo;
      if (typeof origScrollBy === "function") win.scrollBy = origScrollBy;

      dvLog("[delphi-scroll] AutoScroll blocker uninstalled");
    } catch (e) {
      dvWarn("[delphi-scroll] Failed to uninstall blocker", e);
    }
  };

  win.__dvAutoScrollBlockerUninstall = uninstall;
  return uninstall;
}



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

    // Block Delphi native programmatic autoscroll (chat_mode only, conditional)
    installIframeAutoScrollBlocker(iframe);

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
      /* GENERAL e.g. across different Modes
      */ 

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
      
      /* OVERVIEW_MODE
      */ 

      /* CHAT_MODE
      */
      
      /*Set as invisible to make sure ven if we remove
      that it does not appear for a quick second before removal
      (optional but harmless - alrady done inline) */
      h1.delphi-talk-title-text {
        visibility: hidden !important;
      }

      /* CALL_MODE
      */ 

      /* Ensure the title block (avatar + hidden h1) sits on the left */
      nav.from-sand-1.bg-sand-1 .delphi-talk-title-link {
        justify-content: flex-start !important;
        width: auto !important;
      }
      
      /* Optional: avoid the middle container trying to center things */
      nav.from-sand-1.bg-sand-1 [data-sentry-component="TalkTitle"] {
        margin: 0 !important;
      }

      /* Keep existing title invisibility
      (optional but harmless - alreayd done inline) */
      h1.delphi-call-header-title {
        visibility: hidden !important;
      }

      /* Remove extra top padding after we remove the H2 
          to have the CTA button 'start' closer from large picture */
      .delphi-call-container .delphi-call-idle-container {
        padding-top: 0 !important;
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

  ensureOuterScrollTracker();

  waitForIframe("#delphi-frame", (iframe) => {
    // CSS + layout overrides (safe to re-run)
    injectOverridesIntoIframe(iframe);  
 
    // Re-run only CSS overrides on iframe reload
    iframe.addEventListener("load", () => {
      injectOverridesIntoIframe(iframe);
    });
  });

});
