# CI test failures

Record each test failure fixed from November 21 through December 4, 2026. A caught regression identifies broken behavior. A change detector fails on an implementation change while the tested behavior still works. Record the failing evidence before removing a change detector. Keep tests for authorization, privacy, migrations and concurrency.

| Date (UTC) | Test                                              | Classification    | Evidence                                                                                                                                        |
| ---------- | ------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-21 | Browser closes gracefully and removes its profile | Caught regression | Chrome could write its profile after cleanup. Pausing Chrome for two seconds after its close acknowledgement reproduced the leftover directory. |
