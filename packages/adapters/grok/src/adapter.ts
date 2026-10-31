import { makeAcpAdapter } from "@cerium/adapter-acp";
import type { HarnessAdapter } from "@cerium/harness";
import { Context, Layer } from "effect";

import { grokHarness } from "./harness.ts";
import { INSTALL_HINT } from "./manifest.ts";
import { grokModels } from "./models.ts";
import { probeGrok } from "./probe.ts";
import { listGrokSkills } from "./skills.ts";
import { readGrokUsage } from "./usage.ts";

export class GrokAdapter extends Context.Service<GrokAdapter, HarnessAdapter>()(
  "cerium/adapters/grok/GrokAdapter",
) {
  /** Requires the platform's `ChildProcessSpawner`, `FileSystem` and `Path` (e.g. `NodeServices.layer`). */
  static readonly layer = Layer.effect(
    GrokAdapter,
    makeAcpAdapter({
      harness: grokHarness,
      installHint: INSTALL_HINT,
      probe: probeGrok,
      models: grokModels,
      usage: readGrokUsage,
      listSkills: listGrokSkills,
    }),
  );
}
