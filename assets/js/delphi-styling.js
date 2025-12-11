/********************************************************************
 * 1. Wait until iframe exists
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

      // NEW: give the iframe an initial 80% viewport height
      // so there is no visible jump when resizeIframe() runs
      //(when no messages it used to jump from high up to bottom with our 80% of height rule
      const initialMinHeight = Math.floor(window.innerHeight * 0.8);
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
 * 2. Resize the iframe so scrolling happens on the high-level page
 *    (not inside the iframe) and enforce:
 *    - min height = 80% of viewport
 *    - grow with content
 *    - scroll to bottom once on load if user hasn’t scrolled
 ********************************************************************/
function enableIframeAutoResize(iframe) {
  console.log("[delphi-resize] Initializing auto-resize");

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

      // 1) Compute real content height inside Delphi
      const contentHeight = doc.documentElement.scrollHeight;

      // 2) Minimum: 80% of current viewport height
      const minHeight = Math.floor(window.innerHeight * 0.8);

      // 3) Final height: whichever is larger
      const finalHeight = Math.max(contentHeight, minHeight);

      iframe.style.height = finalHeight + "px";
      iframe.style.maxHeight = "none";
      iframe.style.width = "100%";

      console.log("[delphi-resize] Updated iframe height →", finalHeight);

      // 4) Auto-scroll ONCE to bring the input/footer into view
      //    (only if user hasn't started scrolling themselves)
      if (!firstAutoScrollDone && !userHasScrolled) {
        const rect = iframe.getBoundingClientRect();
        const iframeBottomInPage = window.scrollY + rect.bottom;
        const targetScrollTop = iframeBottomInPage - window.innerHeight;
  
        if (targetScrollTop > 0) {
          console.log("[delphi-resize] Auto-scrolling outer page to", targetScrollTop);
          window.scrollTo({ top: targetScrollTop, behavior: "auto" });
  
          // Mark auto-scroll as done ONLY when we really scrolled
          firstAutoScrollDone = true;
        } else {
          console.log("[delphi-resize] No auto-scroll needed (iframe shorter than viewport)");
          // Do NOT flip firstAutoScrollDone here; we may need it later
        }
      }
    } catch (e) {
      console.error("[delphi-resize] Failed to resize iframe", e);
    }
  }

  // Run resize when iframe loads, and again a bit later to catch late content
  iframe.addEventListener("load", () => {
    console.log("[delphi-resize] iframe load event");
    resizeIframe();
    setTimeout(resizeIframe, 200);
    setTimeout(resizeIframe, 800);
  });

  // Recalculate when viewport size changes
  window.addEventListener("resize", resizeIframe);

  // Periodic re-check in case Delphi changes layout after messages stream in
  setInterval(resizeIframe, 1500);
}


/********************************************************************
 * 2B. Pre-inject CSS IMMEDIATELY to kill iframe scrollbar
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
 * 3. Inject CSS into the iframe safely
 ********************************************************************/
function injectCssIntoIframe(iframe) {
  console.log("[delphi-styling] injectCssIntoIframe called");

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

    const style = doc.createElement("style");
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
    `;

    head.appendChild(style);
    console.log("[delphi-styling] CSS injected into iframe");

    // Enable automatic resizing after CSS injection
    enableIframeAutoResize(iframe);
  }

  // If iframe already loaded, inject immediately
  if (iframe.contentDocument && iframe.contentDocument.readyState === "complete") {
    console.log("[delphi-styling] iframe already complete");
    doInject();
  } else {
    console.log("[delphi-styling] Waiting for iframe load");
    iframe.addEventListener("load", () => {
      console.log("[delphi-styling] iframe load event fired (inject)");
      doInject();
    });
  }
}


/********************************************************************
 * 4. Start execution once the DOM is ready
 ********************************************************************/
document.addEventListener("DOMContentLoaded", () => {
  console.log("[delphi-styling] DOMContentLoaded");

  // Delphi injects iframe dynamically → waiting for it
  waitForIframe("#delphi-frame", injectCssIntoIframe);
});
