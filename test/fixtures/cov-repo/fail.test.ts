import { expect, it } from "vitest";
import { add } from "./src/add";

it("fails on purpose", () => {
  expect(add(1, 1)).toBe(3);
});
