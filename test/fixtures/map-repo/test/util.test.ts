import { it } from "vitest";
import { helped } from "./helper";
import { util } from "../src/util";

it("never runs — static-analysis fixture", () => {
  void (util(1) + helped());
});
