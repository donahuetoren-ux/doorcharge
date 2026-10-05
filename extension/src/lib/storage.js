/*
 * Settings and answer keys live in chrome.storage.local:
 *   settings: see DEFAULT_SETTINGS
 *   sets:     [{ id, name, enabled, createdAt, entries: [{ q, options, correct, correctIdx, n }] }]
 */
(function (root) {
  'use strict';

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true, // master switch
    autoClick: true, // false = only highlight the correct answer
    delayMs: 500, // wait before clicking
    fuzzy: true, // allow approximate question matches
    showPanel: true, // status panel on the page
  });

  function withDefaults(settings) {
    return Object.assign({}, DEFAULT_SETTINGS, settings || {});
  }

  async function load() {
    const data = await chrome.storage.local.get(['settings', 'sets']);
    return { settings: withDefaults(data.settings), sets: Array.isArray(data.sets) ? data.sets : [] };
  }

  async function saveSettings(patch) {
    const { settings } = await chrome.storage.local.get('settings');
    const next = withDefaults(Object.assign({}, settings, patch));
    await chrome.storage.local.set({ settings: next });
    return next;
  }

  async function saveSets(sets) {
    await chrome.storage.local.set({ sets });
  }

  root.QAStorage = { DEFAULT_SETTINGS, withDefaults, load, saveSettings, saveSets };
})(typeof self !== 'undefined' ? self : this);
