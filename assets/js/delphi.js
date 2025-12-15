/********************************************************************
 * Constants 
 ********************************************************************/
const MIN_IFRAME_VIEWPORT_RATIO = 0.87;
const INTRO_TITLE = "Hi, I'm Michael";

/********************************************************************
 * Delphi DOM Watchers (extensible rules, single observer)
 ********************************************************************/
function getIframeDoc(iframe) {
  try {
    return iframe.contentDocument || iframe.contentWindow?.document || null;
  } catch (e) {
    console.warn("[delphi] Cannot access iframe document", e);
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
        console.warn(`[delphi] Rule failed: ${rule.name}`, e);
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
        console.log(`[delphi] ${name}: text updated`);
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
        console.log(`[delphi] ${name}: hidden (layout preserved)`);
      }
    },
  };
}

/********************************************************************
 * Register all DOM enforcement rules
 ********************************************************************/
function registerDelphiDomRules(iframe) {
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
  console.log("[delphi-styling] Waiting for iframe:", selector);

  const MAX_TIME = 15000;  // 15s timeout
  const INTERVAL = 200;

  const start = Date.now();

  const timer = setInterval(() => {
    const iframe = document.querySelector(selector);

    if (iframe) {
      console.log("[delphi-styling] Iframe found:", iframe);

      // Give the iframe an initial 80% viewport height
      // so there is no visible jump when resizeIframe() runs
      // - applied the moment the iframe appears, before it loads
      // prevents the "jump" when there are no messages
      //(when no messages it used to jump from high up to bottom with our 80% of height rule
      const initialMinHeight = Math.floor(window.innerHeight * MIN_IFRAME_VIEWPORT_RATIO);
      iframe.style.minHeight = initialMinHeight + "px";
      iframe.style.height = initialMinHeight + "px";
      iframe.style.width = "100%";
      
      clearInterval(timer);
      onFound(iframe);
      return;
    }

    if (Date.now() - start > MAX_TIME) {
      console.error("[delphi-styling] Timeout: iframe not found");
      clearInterval(timer);
    }
  }, INTERVAL);
}


/********************************************************************
 * Resize the iframe so scrolling happens on the high-level page
 *    (not inside the iframe) and enforce:
 *    - min height = 80% of viewport
 *    - grow with content
 *    - scroll to bottom once on load if user hasn’t scrolled
 ********************************************************************/
function enableIframeAutoResize(iframe) {  
  console.log("[delphi-resize] Initializing auto-resize");

  //Add "install once" guard to auto-resize
  //First install still runs; Subsequent injects become no-ops; Prevents exponential listeners
  if (iframe.__dvAutoResizeInstalled) {
    return;
  }
  iframe.__dvAutoResizeInstalled = true;

  let firstAutoScrollDone = false;
  let userHasScrolled = false;

  // Detect user scrolling – if user scrolls, we stop auto-scrolling
  window.addEventListener(
    "scroll",
    () => {
      userHasScrolled = true;
    },
    { passive: true }
  );

  function resizeIframe() {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow.document;
      if (!doc) {
        console.warn("[delphi-resize] No iframe document yet");
        return;
      }
      
      const contentHeight = doc.documentElement.scrollHeight;
      //ensures layout stays consistent when Delphi loads content
      //Later, when messages exist OR when the user types, Delphi's
      //content height changes dynamically. At that point, the system must ensure:
      // the iframe grows to fit content, BUT never shrinks below 80% of viewport height.
      const minHeight = Math.floor(window.innerHeight * MIN_IFRAME_VIEWPORT_RATIO);
      const finalHeight = Math.max(contentHeight, minHeight);
  
      iframe.style.height = finalHeight + "px";
      iframe.style.maxHeight = "none";
      iframe.style.width = "100%";
  
      console.log("[delphi-resize] Updated iframe height →", finalHeight);
    } catch (e) {
      console.error("[delphi-resize] Failed to resize iframe", e);
    }
  }

  // Scroll outer page so iframe bottom is aligned with viewport bottom
  function scrollOuterPageToIframeBottom() {
    const rect = iframe.getBoundingClientRect();
    const iframeBottomInPage = window.scrollY + rect.bottom;
    const targetScrollTop = iframeBottomInPage - window.innerHeight;

    if (targetScrollTop > 0) {
      console.log("[delphi-resize] Auto-scrolling outer page to", targetScrollTop);
      window.scrollTo({ top: targetScrollTop, behavior: "auto" });
      firstAutoScrollDone = true;
    } else {
      console.log("[delphi-resize] No auto-scroll needed (iframe shorter than viewport)");
    }
  }

  iframe.addEventListener("load", () => {
    console.log("[delphi-resize] iframe load event");
    // Only resize on load, do NOT auto-scroll here
    resizeIframe();
  });

  // Watch Delphi message list and react when new messages are added
  try {
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    if (!doc) {
      console.warn("[delphi-resize] No doc for MutationObserver");
      return;
    }

    /**
     * Attach the observer to .delphi-chat-conversation once it exists.
     * Called both immediately and from a body-level observer.
     */
    function attachConversationObserverIfReady() {
      const conversation = doc.querySelector(".delphi-chat-conversation");
      if (!conversation) {
        return false;
      }

      console.log("[delphi-resize] Attaching MutationObserver to .delphi-chat-conversation");

      const observer = new MutationObserver((mutations) => {
        let hasAddedNodes = false;

        for (const m of mutations) {
          if (m.type === "childList" && m.addedNodes && m.addedNodes.length > 0) {
            hasAddedNodes = true;
            break;
          }
        }

        if (!hasAddedNodes) return;

        console.log("[delphi-resize] New Delphi messages detected → resizing + possible auto-scroll");
        resizeIframe();

        // Only auto-scroll if user has not started scrolling yet
        if (!firstAutoScrollDone && !userHasScrolled) {
          scrollOuterPageToIframeBottom();
        }
      });

      observer.observe(conversation, { childList: true });

      // NEW: do one immediate resize + auto-scroll when we first
      // discover the conversation (covers the "many messages already there" case)
      console.log("[delphi-resize] Conversation found → initial resize + possible auto-scroll");
      resizeIframe();
      if (!firstAutoScrollDone && !userHasScrolled) {
        scrollOuterPageToIframeBottom();
      }

      return true;
    }

    // 1) Try immediately (conversation may already be there)
    if (attachConversationObserverIfReady()) {
      // All good, no need for a second observer
      console.log("[delphi-resize] Conversation found immediately");
    } else {
      // 2) If not found yet, watch the whole body until it appears
      console.log("[delphi-resize] .delphi-chat-conversation not yet present → watching body");

      const bodyObserver = new MutationObserver(() => {
        if (attachConversationObserverIfReady()) {
          console.log("[delphi-resize] Conversation appeared later → body observer disconnected");
          bodyObserver.disconnect();
        }
      });

      bodyObserver.observe(doc.body || doc.documentElement, {
        childList: true,
        subtree: true,
      });
    }
  } catch (e) {
    console.warn("[delphi-resize] Failed to attach MutationObserver", e);
  }

  // Recalculate when viewport size changes
  window.addEventListener("resize", resizeIframe);

  // Periodic re-check in case Delphi changes layout after messages stream in
  setInterval(resizeIframe, 1500);

  // In case iframe is already fully loaded when we attach:
  try {
    const readyDoc = iframe.contentDocument || iframe.contentWindow.document;
    if (readyDoc && readyDoc.readyState === "complete") {
      console.log("[delphi-resize] iframe already complete → initial resize only");
      // Only resize here, do NOT auto-scroll
      resizeIframe();
    }
  } catch (e) {
    console.warn("[delphi-resize] Initial immediate resize check failed", e);
  }

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
    console.warn("[delphi-styling] Cannot pre-inject scrollbar-kill CSS", e);
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
//         console.log("[delphi] Title hidden (layout preserved)");
//       }
//     };

//     // Apply immediately
//     apply();

//     // Re-apply if Delphi re-renders the header
//     const obs = new MutationObserver(apply);
//     obs.observe(doc.body || doc.documentElement, { childList: true, subtree: true });
//   } catch (e) {
//     console.warn("[delphi] Failed to hide iframe title", e);
//   }
// }

/********************************************************************
 * Inject Over-rides into the iframe safely
 ********************************************************************/
function injectOverridesIntoIframe(iframe) {
  console.log("[delphi-styling] injectOverridesIntoIframe called");

  // Kill iframe scrollbar as early as possible
  preKillIframeScrollbar(iframe);

  function doInject() {
    let doc;
    try {
      doc = iframe.contentDocument || iframe.contentWindow.document;
      console.log("[delphi-styling] iframe.contentDocument is:", doc);
    } catch (e) {
      console.error("[delphi-styling] Cannot access iframe document", e);
      return;
    }

    if (!doc) {
      console.error("[delphi-styling] iframe document is NULL");
      return;
    }

    const head = doc.head;
    if (!head) {
      console.error("[delphi-styling] No <head> in iframe doc");
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
    
    console.log("[delphi-styling] CSS injected into iframe"); 

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
  console.log("[delphi-styling] DOMContentLoaded");

  waitForIframe("#delphi-frame", (iframe) => {
    // CSS + layout overrides (safe to re-run)
    injectOverridesIntoIframe(iframe);  
 
    // Re-run only CSS overrides on iframe reload
    iframe.addEventListener("load", () => {
      injectOverridesIntoIframe(iframe);
    });
  });

});
