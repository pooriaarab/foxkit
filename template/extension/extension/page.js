// Shows the value that background.js stored, so the E2E test can read it.
browser.storage.local.get("fixture").then(({ fixture }) => {
  document.getElementById("value").textContent = fixture ?? "missing";
});
