// The runtime packages' specs run their services, pipes and tokens through
// TestBed in JIT mode: the compiler compiles each decorated class as a spec
// first touches it, which is enough for code with no templates of its own.
import '@angular/compiler';
import { getTestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';

getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

// Node has a `localStorage` global of its own, which is undefined unless Node
// was given a file to keep it in, and Vitest leaves it in place of jsdom's when
// it copies the DOM onto the global object. The services under test persist
// choices there, so they get jsdom's, from the JSDOM instance Vitest exposes.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;
if (!dom) {
  throw new Error('The Angular specs need Vitest’s jsdom environment.');
}
for (const storage of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, storage, {
    value: dom.window[storage],
    configurable: true,
    writable: true,
  });
}
