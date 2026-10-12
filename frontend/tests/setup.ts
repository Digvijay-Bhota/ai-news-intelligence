/**
 * Shared setup for the jsdom UI suite (vitest.ui.config.ts).
 *
 * The suite runs without Vitest globals, so neither of these registers itself:
 * - jest-dom matchers (toBeInTheDocument, ...) need the Vitest entry point;
 * - Testing Library only auto-cleans when a global afterEach exists, so
 *   without this, rendered DOM would leak into the next test.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
