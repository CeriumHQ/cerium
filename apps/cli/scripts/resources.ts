import { copyFile, cp, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const migrations = resolve(root, "migrations");
await rm(migrations, { recursive: true, force: true });
await cp(resolve(root, "../../packages/store/migrations"), migrations, { recursive: true });
await copyFile(resolve(root, "../../LICENSE"), resolve(root, "LICENSE"));
