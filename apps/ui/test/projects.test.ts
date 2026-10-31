import { describe, expect, it } from "@effect/vitest";

import { projectName, projectPlace, rankProjects } from "../src/features/composer/projectList.ts";

describe("projectName and projectPlace", () => {
  it("name the folder and show where it sits, shortened past three folders", () => {
    expect(projectName("C:\\Users\\me\\Projects\\Apps\\cerium")).toBe("cerium");
    expect(projectPlace("C:\\Users\\me\\Projects\\Apps\\cerium")).toBe("…\\Projects\\Apps");
    expect(projectPlace("C:\\code\\site")).toBe("C:\\code");
    expect(projectPlace("D:\\site")).toBe("D:\\");
    expect(projectPlace("/home/me/site")).toBe("/home/me");
  });
});

describe("rankProjects", () => {
  const paths = [
    "C:\\Users\\me\\Temp\\cerium-scratch\\e2e",
    "C:\\Users\\me\\Projects\\Apps\\cerium",
    "C:\\Users\\me\\Projects\\Apps\\site-cerium",
    "D:\\work\\api",
  ];

  it("puts names that start with the query first, then names containing it, then path matches", () => {
    expect(rankProjects(paths, "Cer")).toEqual([
      "C:\\Users\\me\\Projects\\Apps\\cerium",
      "C:\\Users\\me\\Projects\\Apps\\site-cerium",
      "C:\\Users\\me\\Temp\\cerium-scratch\\e2e",
    ]);
  });

  it("matches every word against the path, whichever slashes are typed", () => {
    expect(rankProjects(paths, "apps/ site")).toEqual(["C:\\Users\\me\\Projects\\Apps\\site-cerium"]);
    expect(rankProjects(paths, "nothing")).toEqual([]);
  });
});
