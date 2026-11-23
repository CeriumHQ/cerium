import m0000 from "./20261021190217_initial/migration.sql";
import m0001 from "./20261025010641_far_orphan/migration.sql";
import m0002 from "./20261029131707_assistants/migration.sql";
import m0003 from "./20261118214852_thread_state/migration.sql";
import m0004 from "./20261123003306_headless_devices/migration.sql";

export default {
  migrations: {
    "20261021190217_initial": m0000,
    "20261025010641_far_orphan": m0001,
    "20261029131707_assistants": m0002,
    "20261118214852_thread_state": m0003,
    "20261123003306_headless_devices": m0004,
  },
};
