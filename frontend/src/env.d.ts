declare module 'cloudflare:workers' {
  export const env: {
    HMAC_SECRET: string;
    BACKEND_API: {
      fetch: (request: Request | string, init?: RequestInit) => Promise<Response>;
    };
  };
}
