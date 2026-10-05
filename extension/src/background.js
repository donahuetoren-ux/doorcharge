/*
 * Background service worker.
 *
 * Blooket and Kahoot get the content script from the manifest. For your own
 * quiz pages you grant access per site from the popup ("Enable on this site");
 * this worker then registers the content script for every granted site and
 * injects it into tabs that are already open.
 */
'use strict';

const CONTENT_SCRIPTS = ['src/lib/text.js', 'src/lib/matcher.js', 'src/lib/storage.js', 'src/content/content.js'];
const BUILT_IN_SITES = ['*://*.blooket.com/*', '*://*.kahoot.it/*'];
const CUSTOM_SCRIPT_ID = 'quiz-autopilot-custom-sites';

const isBuiltIn = (pattern) => /(^|[^a-z0-9-])(blooket\.com|kahoot\.it)\//i.test(pattern);

async function customSites() {
  const { origins = [] } = await chrome.permissions.getAll();
  return origins.filter((origin) => !isBuiltIn(origin));
}

async function syncCustomSites() {
  const sites = await customSites();
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [CUSTOM_SCRIPT_ID] });
  if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [CUSTOM_SCRIPT_ID] });
  if (sites.length) {
    await chrome.scripting.registerContentScripts([
      {
        id: CUSTOM_SCRIPT_ID,
        matches: sites,
        excludeMatches: BUILT_IN_SITES,
        js: CONTENT_SCRIPTS,
        runAt: 'document_idle',
        persistAcrossSessions: true,
      },
    ]);
  }
  return sites;
}

async function injectIntoOpenTabs(patterns) {
  if (!patterns.length) return;
  const tabs = await chrome.tabs.query({ url: patterns });
  await Promise.all(
    tabs.map((tab) =>
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_SCRIPTS }).catch(() => {})
    )
  );
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const sites = await syncCustomSites();
  // Tabs opened before install/update don't get manifest content scripts until reloaded.
  await injectIntoOpenTabs(BUILT_IN_SITES.concat(sites));
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => {
  syncCustomSites();
});

chrome.permissions.onAdded.addListener(async ({ origins = [] }) => {
  await syncCustomSites();
  await injectIntoOpenTabs(origins.filter((origin) => !isBuiltIn(origin)));
});

chrome.permissions.onRemoved.addListener(() => {
  syncCustomSites();
});
