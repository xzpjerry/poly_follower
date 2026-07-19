import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GammaClient } from "../src/polymarket/gamma-client.js";
import { JsonHttpClient } from "../src/polymarket/http-client.js";

describe("GammaClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the events endpoint for an event slug and expands child markets", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      expect(url).toContain("/events/slug/sample-weather-event");
      expect(url).not.toContain("/markets/slug/sample-weather-event");
      return new Response(
        JSON.stringify({
          id: "event-123",
          slug: "sample-weather-event",
          title: "Sample weather event",
          active: true,
          closed: false,
          endDate: "2026-07-19T12:00:00Z",
          markets: [
            {
              question: "Will the sample temperature be 32°C?",
              conditionId: "0xcondition",
              slug: "sample-weather-event-32c",
              endDate: "2026-07-19T12:00:00Z",
              outcomes: '["Yes", "No"]',
              clobTokenIds: '["yes-token", "no-token"]',
              negRisk: true,
              orderPriceMinTickSize: 0.01,
              orderMinSize: 5,
              acceptingOrders: true,
              feesEnabled: true,
              feeSchedule: { exponent: 1, rate: 0.05, takerOnly: true },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const logger = pino({ enabled: false });
    const client = new GammaClient(new JsonHttpClient("https://gamma-api.polymarket.com", 1000, logger, 1));
    const event = await client.getEventBySlug("sample-weather-event", {
      includeYes: true,
      includeNo: true,
    });

    expect(event.eventId).toBe("event-123");
    expect(event.assets).toHaveLength(2);
    expect(event.assets.map((asset) => asset.tokenId)).toEqual(["yes-token", "no-token"]);
  });
});
