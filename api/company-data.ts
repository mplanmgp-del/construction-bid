// Keep company-history endpoints in one Vercel Function; public URLs are rewrites.
export { nodeApiHandler as default } from '../server/http.ts';
