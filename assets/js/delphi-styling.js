function waitForIframe(selector, onFound) {
  console.log("[delphi-styling] Waiting for iframe with selector:", selector);

  const MAX_TIME = 15000;  // 15s timeout safety
  const INTERVAL = 200;    // check every 200ms

  const start = Date.now();

  const timer = setInterval(() => {
    const iframe = document.querySelector(selector);

    if (iframe) {
      //console.log("[delphi-styling] Iframe found:", iframe);
      clearInterval(timer);
      onFound(iframe);
      return;
    }

    if (Date.now() - start > MAX_TIME) {
      console.error("[delphi-styling] Timeout: iframe not found within 15s");
      clearInterval(timer);
    }
  }, INTERVAL);
}

function injectCssIntoIframe(iframe) {
  console.log("[delphi-styling] injectCssIntoIframe called");

  function doInject() {
    let doc;
    try {
      doc = iframe.contentDocument || iframe.contentWindow.document;
      //console.log("[delphi-styling] iframe.contentDocument:", doc);
    } catch (e) {
      //console.error("[delphi-styling] Error accessing iframe document", e);
      return;
    }

    if (!doc) {
      //console.error("[delphi-styling] iframe document is null/undefined");
      return;
    }

    const head = doc.head || doc.getElementsByTagName("head")[0];
    //console.log("[delphi-styling] iframe <head>:", head);

    if (!head) {
      //console.error("[delphi-styling] No <head> found in iframe document");
      return;
    }

    const style = doc.createElement("style");
    style.textContent = `
      .delphi-talk-container {
        background-color: red !important;
      }
      html {
        overflow:hidden; /*hide scrollbar from Delphi iframe*/
      }
    `;

    head.appendChild(style);
    //console.log("[delphi-styling] Style element injected into iframe head");
  }

  // If iframe already fully loaded, inject immediately
  if (iframe.contentDocument && iframe.contentDocument.readyState === "complete") {
    //console.log("[delphi-styling] iframe already loaded, injecting immediately");
    doInject();
  } else {
    //console.log("[delphi-styling] Attaching iframe load listener");
    iframe.addEventListener("load", () => {
      //console.log("[delphi-styling] iframe load event fired");
      doInject();
    });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  //console.log("[delphi-styling] DOMContentLoaded fired");

  // We don't assume iframe exists yet – Delphi injects it later
  waitForIframe("#delphi-frame", injectCssIntoIframe);
});
