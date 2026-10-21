import { defineConfig } from "drizzle-kit";

// The Account object's migrations, with the `migrations.js` that bundles them into the Worker.
export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/schema.ts",
  out: "./migrations",
});
