import { describe, expect, it } from "vitest";

import { resolveEventDate } from "../src/domain/event-selector.js";

describe("event date selector", () => {
  const afterHongKongMidnight = Date.parse("2026-07-18T16:30:00Z");

  it("resolves today in the configured market timezone", () => {
    expect(resolveEventDate("today", "Asia/Hong_Kong", afterHongKongMidnight)).toBe("2026-07-19");
  });

  it("resolves tomorrow as the next calendar day", () => {
    expect(resolveEventDate("tomorrow", "Asia/Hong_Kong", afterHongKongMidnight)).toBe("2026-07-20");
  });

  it("leaves an explicit event date unchanged", () => {
    expect(resolveEventDate("2026-08-01", "Asia/Hong_Kong", afterHongKongMidnight)).toBe("2026-08-01");
  });
});
