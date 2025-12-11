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
 * 2. Resize the iframe so scrolling happens on the high-level page (not inside the iframe)
 ********************************************************************/
function enableIframeAutoResize(iframe) {
  console.log("[delphi-resize] Initializing auto-resize");

  // We only auto-scroll the very first time we successfully resize.
  let firstResizeDone = false;

  function resizeIframe() {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow.document;
      if (!doc) {
        console.warn("[delphi-resize] No iframe document yet");
        return;
      }

      const height = doc.documentElement.scrollHeight;
      iframe.style.height = height + "px";
      iframe.style.maxHeight = "none";
      iframe.style.width = "100%";

      console.log("[delphi-resize] Updated iframe height →", height);

      // --- New part: auto-scroll so the iframe bottom is at viewport bottom ---
      if (!firstResizeDone) {
        firstResizeDone = true;

        // Where is the iframe relative to the viewport?
        const rect = iframe.getBoundingClientRect();
        const iframeBottomInPage = window.scrollY + rect.bottom;

        // We want iframe bottom == window.innerHeight + scrollY
        const targetScrollTop = iframeBottomInPage - window.innerHeight;

        if (targetScrollTop > 0) {
          console.log("[delphi-resize] Auto-scrolling to show input at bottom:", targetScrollTop);
          window.scrollTo({
            top: targetScrollTop,
            behavior: "instant" in window ? "instant" : "auto" // fallback
          });
        }
      }
      // -----------------------------------------------------------------------
    } catch (e) {
      console.error("[delphi-resize] Failed to resize iframe", e);
    }
  }

  // Run at load
  iframe.addEventListener("load", () => {
    console.log("[delphi-resize] iframe load event");
    resizeIframe();
    setTimeout(resizeIframe, 200);
    setTimeout(resizeIframe, 1000);
  });

  // Also resize when window resizes
  window.addEventListener("resize", resizeIframe);

  // Extra periodic check (iframe UI may auto-expand)
  setInterval(resizeIframe, 1500);
}



/********************************************************************
 * 3. Inject CSS into the iframe safely
 ********************************************************************/
function injectCssIntoIframe(iframe) {
  console.log("[delphi-styling] injectCssIntoIframe called");

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
      console.log("[delphi-styling] iframe load event fired");
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
