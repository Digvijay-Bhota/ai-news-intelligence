/** Test-only stand-in for the Workers runtime module; tests override `env` via vi.mock. */
export const env: Record<string, unknown> = {};
