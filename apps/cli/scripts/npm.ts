import { join } from "node:path";
import { releaseVersion } from "../src/release.ts";
import { root, stageNpm } from "./stage.ts";

const version = process.env["CERIUM_VERSION"];
const directory = join(root, "out", "npm");
await stageNpm(directory, version ? releaseVersion(version) : undefined);
console.log(`npm package ready at ${directory}`);
