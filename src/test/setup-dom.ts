/**
 * Test-only DOM bootstrap. Loaded with `node --import` *before* any test module
 * (and therefore before `react-dom`), so React finds a browser-like global
 * environment. Kept out of the app bundle: nothing under `src/app` imports it.
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost:3000/room/ABCDEF",
  pretendToBeVisual: true,
});

const browserGlobals = globalThis as unknown as Record<string, unknown>;

for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in browserGlobals) continue;
  const value = (dom.window as unknown as Record<string, unknown>)[key];
  Object.defineProperty(browserGlobals, key, {
    value,
    writable: true,
    configurable: true,
  });
}

// Node 24 defines a read-only `navigator`; React and the app read userAgent.
Object.defineProperty(browserGlobals, "navigator", {
  value: dom.window.navigator,
  writable: true,
  configurable: true,
});

browserGlobals.IS_REACT_ACT_ENVIRONMENT = true;
