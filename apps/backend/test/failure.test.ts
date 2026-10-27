import { describe, expect, it } from "@effect/vitest";
import { Cause } from "effect";
import { ServeError } from "effect/http/HttpServerError";

import { StoreError } from "@cerium/store";

import { backendFailed, failureKind, messageChain } from "../src/failure.ts";

describe("failureKind", () => {
  it("tells the store's open and migration failures apart", () => {
    const open = new StoreError({ message: "Could not open C:/data/cerium.db", cause: new Error("locked") });
    const migrate = new StoreError({
      message: "Could not migrate the database",
      cause: new Error("no such table"),
    });
    expect(failureKind(open, false)).toBe("databaseOpen");
    expect(failureKind(migrate, false)).toBe("databaseMigrate");
  });

  it("names a server that couldn't listen", () => {
    expect(failureKind(new ServeError({ cause: new Error("EADDRINUSE") }), false)).toBe("listen");
  });

  it("calls anything else a startup failure before listening, and a crash after", () => {
    expect(failureKind(new Error("boom"), false)).toBe("startup");
    expect(failureKind(new Error("boom"), true)).toBe("crash");
  });
});

describe("messageChain", () => {
  it("follows the causes, naming each message once", () => {
    const error = new StoreError({
      message: "Could not migrate the database",
      cause: new Error("near line 3", { cause: new Error("near line 3") }),
    });
    expect(messageChain(error)).toBe("Could not migrate the database: near line 3");
  });

  it("reads something that isn't an error", () => {
    expect(messageChain("plain")).toBe("plain");
    expect(messageChain(undefined)).toBe("Unknown error");
  });
});

describe("backendFailed", () => {
  it("is the shell's message for a failed cause", () => {
    const cause = Cause.fail(new StoreError({ message: "Could not open x.db", cause: new Error("EBUSY") }));
    expect(backendFailed(cause, false)).toEqual({
      _tag: "BackendFailed",
      kind: "databaseOpen",
      message: "Could not open x.db: EBUSY",
    });
  });
});
