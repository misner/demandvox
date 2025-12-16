/********************************************************************
 * Constants 
 ********************************************************************/
const MIN_IFRAME_VIEWPORT_RATIO = 0.87;
const INTRO_TITLE = "Hi, I'm Michael";
const RESIZE_INTERVAL_MS = 1500;

/********************************************************************
 * Environment + logging
 * ------------------------------------------------------------------
 * We want verbose logs on preview instances (*.pages.dev)
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
    dvLog("[delphi] entering Chat mode");
    return "chat_mode";
  }

  // OVERVIEW / PROFILE view
  if (doc.querySelector(".delphi-profile-container")) {
    dvLog("[delphi] entering Overview/profile mode");
    return "overview_mode";
  }

  if (doc.querySelector(".delphi-call-container")) {
    dvLog("[delphi] entering Call mode");
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

/********************************************************************
 * Register all DOM enforcement rules
 ********************************************************************/
function registerDelphiDomRules(iframe) {
  //Add “install once” guard to DOM watcher runtime
  if (iframe.__dvDomRulesInstalled) return;
  iframe.__dvDomRulesInstalled = true;

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
  addDelphiDomRule(
    iframe,
    ruleHideButKeepLayout({
      name: "chat-header-title-hidden",
      selector: "h1.delphi-talk-title-text",
    })
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


/********************************************************************
 * Resize the iframe so scrolling happens on the high-level page
 *    (not inside the iframe) and enforce:
 *    - min height = MIN_IFRAME_VIEWPORT_RATIO% of viewport
 *    - grow with content
 *    - scroll to bottom once on load if user hasn’t scrolled
 ********************************************************************/
// function enableIframeAutoResize(iframe) {  
//   dvLog("[delphi-resize] Initializing auto-resize");

//   //Add "install once" guard to auto-resize
//   //First install still runs; Subsequent injects become no-ops; Prevents exponential listeners
//   if (iframe.__dvAutoResizeInstalled) {
//     return;
//   }
//   iframe.__dvAutoResizeInstalled = true;

//   let firstAutoScrollDone = false;
//   let userHasScrolled = false;

//   // Detect user scrolling – if user scrolls, we stop auto-scrolling - only in Chat Mode
//   window.addEventListener(
//     "scroll",
//     () => {
//       // Only disable auto-scroll if the user scrolls WHILE IN CHAT MODE
//       // this ensures Scrolling on Profile does not poison Chat behavior
//       if (getDelphiMode(doc) === "chat_mode") {
//         userHasScrolled = true;
//       }
//     },
//     { passive: true }
//   );
 

//   function resizeIframe() {
//     try {
//       const doc = iframe.contentDocument || iframe.contentWindow.document;
//       if (!doc) {
//         dvWarn("[delphi-resize] No iframe document yet");
//         return;
//       }
      
//       const contentHeight = doc.documentElement.scrollHeight;
//       //ensures layout stays consistent when Delphi loads content
//       //Later, when messages exist OR when the user types, Delphi's
//       //content height changes dynamically. At that point, the system must ensure:
//       // the iframe grows to fit content, BUT never shrinks below MIN_IFRAME_VIEWPORT_RATIO% of viewport height.
//       const minHeight = Math.floor(window.innerHeight * MIN_IFRAME_VIEWPORT_RATIO);
//       const finalHeight = Math.max(contentHeight, minHeight);
  
//       iframe.style.height = finalHeight + "px";
//       iframe.style.maxHeight = "none";
//       iframe.style.width = "100%";
  
//       dvLog("[delphi-resize] Updated iframe height →", finalHeight);
//     } catch (e) {
//       dvError("[delphi-resize] Failed to resize iframe", e);
//     }
//   }

//   // Scroll outer page so iframe bottom is aligned with viewport bottom
//   function scrollOuterPageToIframeBottom() {
//     const rect = iframe.getBoundingClientRect();
//     const iframeBottomInPage = window.scrollY + rect.bottom;
//     const targetScrollTop = iframeBottomInPage - window.innerHeight;

//     if (targetScrollTop > 0) {
//       dvLog("[delphi-resize] Auto-scrolling outer page to", targetScrollTop);
//       window.scrollTo({ top: targetScrollTop, behavior: "auto" });
//       firstAutoScrollDone = true;
//     } else {
//       dvLog("[delphi-resize] No auto-scroll needed (iframe shorter than viewport)");
//     }
//   }

//   iframe.addEventListener("load", () => {
//     dvLog("[delphi-resize] iframe load event");
//     // Only resize on load, do NOT auto-scroll here
//     resizeIframe();
//   });

//   // Watch Delphi message list and react when new messages are added
//   try {
//     const doc = iframe.contentDocument || iframe.contentWindow.document;
//     if (!doc) {
//       dvWarn("[delphi-resize] No doc for MutationObserver");
//       return;
//     }

//     /**
//      * Attach the observer to .delphi-chat-conversation once it exists.
//      * Called both immediately and from a body-level observer.
//      */
//     function attachConversationObserverIfReady() {
//       const conversation = doc.querySelector(".delphi-chat-conversation");
//       if (!conversation) {
//         return false;
//       }

//       dvLog("[delphi-resize] Attaching MutationObserver to .delphi-chat-conversation");

//       const observer = new MutationObserver((mutations) => {
//         let hasAddedNodes = false;

//         for (const m of mutations) {
//           if (m.type === "childList" && m.addedNodes && m.addedNodes.length > 0) {
//             hasAddedNodes = true;
//             break;
//           }
//         }

//         if (!hasAddedNodes) return;

//         dvLog("[delphi-resize] New Delphi messages detected → resizing + possible auto-scroll");
//         resizeIframe();

//         // Only auto-scroll if user has not started scrolling yet
//         if (!firstAutoScrollDone && !userHasScrolled) {
//           scrollOuterPageToIframeBottom();
//         }
//       });

//       observer.observe(conversation, { childList: true });

//       // NEW: do one immediate resize + auto-scroll when we first
//       // discover the conversation (covers the "many messages already there" case)
//       dvLog("[delphi-resize] Conversation found → initial resize + possible auto-scroll");
//       resizeIframe();
//       if (!firstAutoScrollDone && !userHasScrolled) {
//         scrollOuterPageToIframeBottom();
//       }

//       return true;
//     }

//     // 1) Try immediately (conversation may already be there)
//     if (attachConversationObserverIfReady()) {
//       // All good, no need for a second observer
//       dvLog("[delphi-resize] Conversation found immediately");
//     } else {
//       // 2) If not found yet, watch the whole body until it appears
//       dvLog("[delphi-resize] .delphi-chat-conversation not yet present → watching body");

//       const bodyObserver = new MutationObserver(() => {
//         if (attachConversationObserverIfReady()) {
//           dvLog("[delphi-resize] Conversation appeared later → body observer disconnected");
//           bodyObserver.disconnect();
//         }
//       });

//       bodyObserver.observe(doc.body || doc.documentElement, {
//         childList: true,
//         subtree: true,
//       });
//     }
//   } catch (e) {
//     dvWarn("[delphi-resize] Failed to attach MutationObserver", e);
//   }

//   // Recalculate when viewport size changes
//   window.addEventListener("resize", resizeIframe);

//   // Periodic re-check in case Delphi changes Mode after messages stream in
//   setInterval(resizeIframe, 1500);

//   // In case iframe is already fully loaded when we attach:
//   try {
//     const readyDoc = iframe.contentDocument || iframe.contentWindow.document;
//     if (readyDoc && readyDoc.readyState === "complete") {
//       dvLog("[delphi-resize] iframe already complete → initial resize only");
//       // Only resize here, do NOT auto-scroll
//       resizeIframe();
//     }
//   } catch (e) {
//     dvWarn("[delphi-resize] Initial immediate resize check failed", e);
//   }

// }

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
   * - detecting Delphi "mode" (chat / overview / voice)
   *
   * If unavailable, resizing cannot function safely.
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

  /******************************************************************
   * Scroll state flags
   * ---------------------------------------------------------------
   * userHasScrolled:
   *   Becomes true once the user manually scrolls the outer page.
   *   Prevents auto-scroll from fighting the user.
   *
   * firstAutoScrollDone:
   *   Ensures we auto-scroll only once per chat entry.
   ******************************************************************/
  let userHasScrolled = false;
  let firstAutoScrollDone = false;

  /******************************************************************
   * resizeIframe()
   * ---------------------------------------------------------------
   * Core resizing logic:
   * - Ensure iframe is never smaller than MIN_IFRAME_VIEWPORT_RATIO% of viewport height
   * - Grow naturally when content exceeds viewport
   * - Perform controlled auto-scroll in chat mode only
   ******************************************************************/
  function resizeIframe() {
    // Actual content height inside the iframe
    const contentHeight = doc.documentElement.scrollHeight;

    // Minimum height rule (chat UX requirement)
    const minHeight = Math.floor(window.innerHeight * MIN_IFRAME_VIEWPORT_RATIO);

    // Final height is the larger of content or minimum
    const finalHeight = Math.max(contentHeight, minHeight);

    iframe.style.height = finalHeight + "px";

    /**************************************************************
     * Auto-scroll logic
     * -----------------------------------------------------------
     * Conditions:
     * - Only in chat mode
     * - Only if user has NOT scrolled manually
     * - Only once per chat entry
     * - Only if iframe exceeds viewport height
     **************************************************************/
    if (
      getDelphiMode(doc) === "chat" &&
      !userHasScrolled &&
      !firstAutoScrollDone &&
      finalHeight > window.innerHeight
    ) {
      scrollOuterPageToIframeBottom();
      firstAutoScrollDone = true;
    }
  }

  /******************************************************************
   * Detect manual user scroll
   * ---------------------------------------------------------------
   * If the user scrolls while in chat mode, we permanently disable
   * auto-scroll for the current chat session.
   ******************************************************************/
  window.addEventListener(
    "scroll",
    () => {
      if (getDelphiMode(doc) === "chat") {
        userHasScrolled = true;
      }
    },
    { passive: true }
  );

  /******************************************************************
   * Initial sizing
   * ---------------------------------------------------------------
   * Handles:
   * - Page load
   * - Direct deep links
   * - Conversations with many existing messages
   ******************************************************************/
  resizeIframe();

  /******************************************************************
   * Periodic reconciliation loop
   * ---------------------------------------------------------------
   * Why polling?
   * - Delphi is a SPA
   * - No stable events for:
   *   - view changes
   *   - message streaming
   *   - layout recalculations
   *
   * Every 1.5s we:
   * - Resize iframe
   * - Detect mode changes
   * - React only when mode changes
   ******************************************************************/
  iframe.__dvResizeIntervalId = setInterval(() => {
    resizeIframe();

    const mode = getDelphiMode(doc);

    /**************************************************************
     * Mode transition handling
     * -----------------------------------------------------------
     * Only triggered when Delphi switches view:
     * - overview → chat
     * - chat → overview
     * - chat → voice
     **************************************************************/
    if (mode !== lastMode) {
      dvLog("[delphi-resize] mode change:", lastMode, "→", mode);

      /**********************************************************
       * Entering chat mode
       * -------------------------------------------------------
       * Reset scroll logic so the input field is visible
       * after layout stabilizes.
       **********************************************************/
      if (mode === "chat") {
        userHasScrolled = false;
        firstAutoScrollDone = false;

        // Let React/layout settle before correcting scroll
        setTimeout(() => {
          resizeIframe();
          scrollOuterPageToIframeBottom();
          firstAutoScrollDone = true;
        }, 50);
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
 * Override Delphi copy
 ********************************************************************/
// function hideTitleInTextChat(iframe) {
//   try {
//     const doc = iframe.contentDocument || iframe.contentWindow?.document;
//     if (!doc) return;

//     const apply = () => {
//       const h1 = doc.querySelector("h1.delphi-talk-title-text");
//       if (!h1) return;

//       // Keep layout space so other header items don't shift
//       if (h1.style.visibility !== "hidden") {
//         h1.style.visibility = "hidden";
//         dvLog("[delphi] Title hidden (layout preserved)");
//       }
//     };

//     // Apply immediately
//     apply();

//     // Re-apply if Delphi re-renders the header
//     const obs = new MutationObserver(apply);
//     obs.observe(doc.body || doc.documentElement, { childList: true, subtree: true });
//   } catch (e) {
//     dvWarn("[delphi] Failed to hide iframe title", e);
//   }
// }

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
      
      /* Keep existing title invisibility (you already did it inline) */
      h1.delphi-talk-title-text {
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
