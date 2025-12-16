document.addEventListener("DOMContentLoaded", () => {
  const iframe = document.getElementById("delphi-frame");
  if (!iframe) return;

  iframe.addEventListener("load", () => {
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    if (!doc) return;

    // Inject CSS into the iframe’s DOM
    const style = doc.createElement("style");
    style.textContent = `
      /* Example override */
      .delphi-profile-container {
        background-color: red !important;
      }

      /* Add more rules here as needed */
    `;
    doc.head.appendChild(style);
  });
});
