document.addEventListener("DOMContentLoaded", () => {
  alert("[delphi-styling] DOMContentLoaded fired");

  const iframe = document.getElementById("delphi-frame");
  console.log("[delphi-styling] iframe element:", iframe);

  if (!iframe) {
    console.error("[delphi-styling] #delphi-frame not found in DOM");
    alert("[delphi-styling] ERROR: iframe with id delphi-frame not found");
    return;
  }

  // Helper that does the actual injection
  function injectCssIntoIframe() {
    alert("[delphi-styling] injectCssIntoIframe called");

    let doc;
    try {
      doc = iframe.contentDocument || iframe.contentWindow.document;
      console.log("[delphi-styling] iframe.contentDocument:", doc);
    } catch (e) {
      console.error("[delphi-styling] Error accessing iframe document", e);
      alert("[delphi-styling] ERROR accessing iframe document: " + e.message);
      return;
    }

    if (!doc) {
      console.error("[delphi-styling] iframe document is null/undefined");
      alert("[delphi-styling] ERROR: iframe document is null");
      return;
    }

    const head = doc.head || doc.getElementsByTagName("head")[0];
    console.log("[delphi-styling] iframe <head>:", head);

    if (!head) {
      console.error("[delphi-styling] No <head> found in iframe document");
      alert("[delphi-styling] ERROR: no <head> in iframe document");
      return;
    }

    const style = doc.createElement("style");
    style.textContent = `
      .delphi-profile-container {
        background-color: red !important;
      }
    `;

    head.appendChild(style);
    console.log("[delphi-styling] Style element injected into iframe head");
    alert("[delphi-styling] Style injected into iframe");
  }

  // Case 1: iframe already loaded before we attach the listener
  if (iframe.contentDocument && iframe.contentDocument.readyState === "complete") {
    console.log("[delphi-styling] iframe already loaded, injecting immediately");
    alert("[delphi-styling] iframe already loaded, injecting CSS now");
    injectCssIntoIframe();
  } else {
    // Case 2: normal flow – wait for iframe load
    console.log("[delphi-styling] Attaching iframe load listener");
    iframe.addEventListener("load", () => {
      console.log("[delphi-styling] iframe load event fired");
      alert("[delphi-styling] iframe load event fired");
      injectCssIntoIframe();
    });
  }
});
