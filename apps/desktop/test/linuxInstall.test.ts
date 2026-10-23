import { describe, expect, it } from "@effect/vitest";

import { linuxInstallFrom } from "../src/linuxInstall.ts";

describe("linuxInstallFrom", () => {
  it("knows an AppImage by the file its runtime names", () => {
    expect(linuxInstallFrom("/home/me/Cerium.AppImage", undefined, "/tmp/.mount_x/cerium")).toEqual({
      kind: "appimage",
      program: "/home/me/Cerium.AppImage",
    });
  });

  it("knows a package by the kind electron-builder wrote, and starts the installed program", () => {
    expect(linuxInstallFrom(undefined, "deb\n", "/opt/Cerium/cerium")).toEqual({
      kind: "deb",
      program: "/opt/Cerium/cerium",
    });
    expect(linuxInstallFrom("", "rpm", "/opt/Cerium/cerium")).toEqual({
      kind: "rpm",
      program: "/opt/Cerium/cerium",
    });
  });

  it("finds no install for a build run from a folder or a package it can't update", () => {
    expect(linuxInstallFrom(undefined, undefined, "/home/me/cerium/linux-unpacked/cerium")).toBeUndefined();
    expect(linuxInstallFrom(undefined, "pacman", "/opt/Cerium/cerium")).toBeUndefined();
  });
});
