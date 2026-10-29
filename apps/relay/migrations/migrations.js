import m0000 from "./20261021190217_initial/migration.sql";
import m0001 from "./20261025010641_far_orphan/migration.sql";
import m0002 from "./20261029131707_assistants/migration.sql";

export default {
  migrations: {
    "20261021190217_initial": m0000,
    "20261025010641_far_orphan": m0001,
    "20261029131707_assistants": m0002,
  },
};
