// function waitForIframe(selector, onFound) {
//   console.log("[delphi-styling] Waiting for iframe with selector:", selector);

//   const MAX_TIME = 15000;  // 15s timeout safety
//   const INTERVAL = 200;    // check every 200ms

//   const start = Date.now();

//   const timer = setInterval(() => {
//     const iframe = document.querySelector(selector);

//     if (iframe) {
//       console.log("[delphi-styling] Iframe found:", iframe);
//       clearInterval(timer);
//       onFound(iframe);
//       return;
//     }

//     if (Date.now() - start > MAX_TIME) {
//       console.error("[delphi-styling] Timeout: iframe not found within 15s");
//       clearInterval(timer);
//     }
//   }, INTERVAL);
// }

// function injectCssIntoIframe(iframe) {
//   console.log("[delphi-styling] injectCssIntoIframe called");

//   function doInject() {
//     let doc;
//     try {
//       doc = iframe.contentDocument || iframe.contentWindow.document;
//       console.log("[delphi-styling] iframe.contentDocument doc=:", doc);
//     } catch (e) {
//       console.error("[delphi-styling] Error accessing iframe document", e);
//       return;
//     }

//     if (!doc) {
//       console.error("[delphi-styling] iframe document is null/undefined");
//       return;
//     }

//     const head = doc.head || doc.getElementsByTagName("head")[0];
//     console.log("[delphi-styling] iframe <head>:", head);

//     if (!head) {
//       console.error("[delphi-styling] No <head> found in iframe document");
//       return;
//     }

//     const style = doc.createElement("style");
//     style.textContent = `
//       /*.delphi-talk-container {
//         background-color: red !important;
//       }*/
//       body {
        
//       }      
//       html {
//         /*overflow:hidden !important; hide scrollbar from Delphi iframe*/
//       }
//     `;

//     head.appendChild(style);
//     console.log("[delphi-styling] Style element injected into iframe head");
//   }

//   // If iframe already fully loaded, inject immediately
//   if (iframe.contentDocument && iframe.contentDocument.readyState === "complete") {
//     //console.log("[delphi-styling] iframe already loaded, injecting immediately");
//     doInject();
//   } else {
//     //console.log("[delphi-styling] Attaching iframe load listener");
//     iframe.addEventListener("load", () => {
//       //console.log("[delphi-styling] iframe load event fired");
//       doInject();
//     });
//   }
// }

// document.addEventListener("DOMContentLoaded", () => {
//   //console.log("[delphi-styling] DOMContentLoaded fired");

//   // We don't assume iframe exists yet – Delphi injects it later
//   waitForIframe("#delphi-frame", injectCssIntoIframe);
// });



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
 * 2. Resize the iframe so scrolling happens on your page (not inside)
 ********************************************************************/
function enableIframeAutoResize(iframe) {
  console.log("[delphi-resize] Initializing auto-resize");

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

      // Optional full width
      iframe.style.width = "100%";

      console.log("[delphi-resize] Updated iframe height →", height);
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

  // Delphi injects iframe dynamically → we wait for it
  waitForIframe("#delphi-frame", injectCssIntoIframe);
});
