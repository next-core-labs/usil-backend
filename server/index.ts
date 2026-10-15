// Loads .env for local runs. In Docker, compose-injected vars win — dotenv never overrides existing values.
import 'dotenv/config';
import { createApp } from './app.ts';

// Paths resolve against the working directory, not this file: the bundled
// server runs as `node build/server.cjs` from the project root, so `data/`,
// `dist/` and `public/` sit beside the process, not beside the source.
// On Cloudflare the app is built by `worker/index.ts` instead.
const PORT = process.env.PORT || 3000;

createApp({ rootDir: process.cwd() }).listen(Number(PORT), '0.0.0.0', () => {
  console.log(`🚀 يوصل (Usil) يعمل بكامل ميزاته على بورت ${PORT}`);
});
