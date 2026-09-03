import { describe, expect, test } from "bun:test";

import {
  maxPositionalNumber,
  nextPositionalVariable,
  promptVariableChips,
  restSliceVariable,
} from "./promptVariables";

describe("promptVariables", () => {
  test("starts at $1 when no positional is present", () => {
    expect(nextPositionalVariable("")).toBe("$1");
    expect(nextPositionalVariable("Review this $@ please")).toBe("$1");
    expect(nextPositionalVariable("Use ${@:2} here")).toBe("$1");
  });

  test("continues from the highest positional present", () => {
    expect(nextPositionalVariable("Do $1 then $2")).toBe("$3");
    expect(nextPositionalVariable("$2 before $1")).toBe("$3");
    expect(nextPositionalVariable("Take $10")).toBe("$11");
  });

  test("ignores brace defaults without a bare positional", () => {
    expect(maxPositionalNumber("Hello ${1:-friend}")).toBe(0);
    expect(nextPositionalVariable("Hello ${1:-friend}")).toBe("$1");
  });

  test("resolves the first chip to the next argument", () => {
    const chips = promptVariableChips("Do $1 and $2");
    expect(chips[0]).toEqual({ value: "$3", label: "$3", hint: "Insert $3, the next argument" });
    expect(chips.map((chip) => chip.value)).toEqual(["$3", "$@", "${@:3}"]);
  });

  test("resolves the first chip to $1 for fresh content", () => {
    const chips = promptVariableChips("");
    expect(chips[0]).toEqual({ value: "$1", label: "$1", hint: "Insert $1, the next argument" });
    expect(chips.map((chip) => chip.value)).toEqual(["$1", "$@"]);
  });

  test("resolves the rest slice after the positional ones in use", () => {
    expect(restSliceVariable("")).toBeNull();
    expect(restSliceVariable("Review $@")).toBeNull();
    expect(restSliceVariable("Do $1")).toBe("${@:2}");
    expect(restSliceVariable("Do $1 and $2 then $3")).toBe("${@:4}");
  });

  test("shows the rest chip only once a positional is in use", () => {
    expect(promptVariableChips("").map((chip) => chip.value)).toEqual(["$1", "$@"]);
    const chips = promptVariableChips("Take $1");
    expect(chips[2]).toEqual({
      value: "${@:2}",
      label: "${@:2}",
      hint: "Insert ${@:2}, all arguments after the positional ones",
    });
  });
});
