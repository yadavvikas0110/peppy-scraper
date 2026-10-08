import type { ScrapeDoBrowserAction } from '../../shared/scrapedo/scrapedo.types';

// Generic playWithBrowser action builders shared by dining platforms. Pure: they only build
// action arrays; nothing here sends requests. Results come back in returnJSON `actionResults`.

const DEFAULT_TIMEOUT_MS = 10000;

export function clickAction(selector: string): ScrapeDoBrowserAction {
  return { Action: 'Click', Selector: selector };
}

export function waitForSelectorAction(selector: string, timeoutMs = DEFAULT_TIMEOUT_MS): ScrapeDoBrowserAction {
  return { Action: 'WaitSelector', WaitSelector: selector, Timeout: timeoutMs };
}

export function scrollToAction(selector: string): ScrapeDoBrowserAction {
  return { Action: 'ScrollTo', Selector: selector };
}

export function scrollByAction(pixels: number): ScrapeDoBrowserAction {
  return { Action: 'ScrollY', Value: pixels };
}

export function waitAction(ms: number): ScrapeDoBrowserAction {
  return { Action: 'Wait', Timeout: ms };
}

// Runs a script in the page; its return value is reported in actionResults.
export function executeAction(script: string): ScrapeDoBrowserAction {
  return { Action: 'Execute', Execute: script };
}

// Reads the *computed* background-image of every element matching `selector`
// (covers images applied by stylesheets or lazy-loading, which inline-style parsing misses).
// Returns [{ label, url }] where label is the element's aria-label (or null).
export function computedBackgroundImagesAction(selector: string): ScrapeDoBrowserAction {
  const sel = JSON.stringify(selector);
  return executeAction(
    `Array.from(document.querySelectorAll(${sel})).map(function(el){` +
      `var m=/url\\(["']?(.*?)["']?\\)/.exec(getComputedStyle(el).backgroundImage||'');` +
      `return {label:el.getAttribute('aria-label'),url:m?m[1]:null};})`
  );
}

// Scrolls the page in steps so lazy-loaded images get rendered before the HTML is captured.
export function scrollPageActions(steps: number, stepPx: number, pauseMs: number): ScrapeDoBrowserAction[] {
  const actions: ScrapeDoBrowserAction[] = [];
  for (let i = 0; i < steps; i++) actions.push(scrollByAction(stepPx), waitAction(pauseMs));
  return actions;
}
