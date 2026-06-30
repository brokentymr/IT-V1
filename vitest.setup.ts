import { loadEnv } from "./lib/env";

// Make .env (DATABASE_URL credentials, ANTHROPIC_API_KEY, etc.) available to tests.
loadEnv();
