import { describe, expect, test } from "bun:test";
import {
  commandListboxId,
  commandOptionId,
  resolveCommandActiveOptionId,
  sanitizeComboboxIdSegment,
} from "../commandComboboxAria";

describe("commandComboboxAria", () => {
  test("sanitizes React useId segments for selector-safe IDs", () => {
    expect(sanitizeComboboxIdSegment(":r0:")).toBe("r0");
    expect(sanitizeComboboxIdSegment("r_1-2")).toBe("r_1-2");
    expect(sanitizeComboboxIdSegment("")).toBe("");
  });

  test("builds stable collision-safe listbox and option IDs", () => {
    const listboxId = commandListboxId("r0");
    expect(listboxId).toBe("command-listbox-r0");
    expect(commandOptionId(listboxId, 0)).toBe("command-listbox-r0-option-0");
    expect(commandOptionId(listboxId, 2)).toBe("command-listbox-r0-option-2");
    expect(commandListboxId("")).toBe("command-listbox-commands");
  });

  test("resolves the active option only under the palette valid conditions", () => {
    const listboxId = commandListboxId("r0");
    expect(
      resolveCommandActiveOptionId({
        loading: false,
        hasSelectedCommand: true,
        selectedIndex: 1,
        listboxId,
      }),
    ).toBe("command-listbox-r0-option-1");
    expect(
      resolveCommandActiveOptionId({
        loading: true,
        hasSelectedCommand: true,
        selectedIndex: 1,
        listboxId,
      }),
    ).toBeUndefined();
    expect(
      resolveCommandActiveOptionId({
        loading: false,
        hasSelectedCommand: false,
        selectedIndex: 0,
        listboxId,
      }),
    ).toBeUndefined();
  });
});
