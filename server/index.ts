import { createChatServer } from "./app.js";
import { configFromEnv } from "./config.js";

const config = configFromEnv();
const app = await createChatServer({
  config,
  devAssets: process.env.NODE_ENV !== "production" && process.env.SERVE_DEV_ASSETS !== "0"
});

const address = await app.listen();
console.info(`[410] listening on http://${address.host}:${address.port}`);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await app.close();
  process.exit(0);
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
