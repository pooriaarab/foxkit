// Runs when Firefox installs the extension. The E2E test reads this value
// back through page.html.
browser.runtime.onInstalled.addListener(() => {
  browser.storage.local.set({ fixture: "installed" });
});
