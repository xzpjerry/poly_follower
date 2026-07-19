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

  it("resolves exactly one daily event through Series ID and eventDate", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/series") {
        expect(url.searchParams.get("slug")).toBe("shenzhen-daily-weather");
        return new Response(
          JSON.stringify([
            {
              id: "11366",
              slug: "shenzhen-daily-weather",
              title: "Shenzhen Daily Weather",
              recurrence: "daily",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      expect(url.pathname).toBe("/events/keyset");
      expect(url.searchParams.get("series_id")).toBe("11366");
      expect(url.searchParams.get("event_date")).toBe("2026-07-19T00:00:00Z");
      return new Response(
        JSON.stringify({
          events: [
            {
              id: "712468",
              slug: "highest-temperature-in-shenzhen-on-july-19-2026",
              title: "Highest temperature in Shenzhen on July 19?",
              eventDate: "2026-07-19",
              seriesSlug: "shenzhen-daily-weather",
              active: true,
              closed: false,
              endDate: "2026-07-19T12:00:00Z",
              markets: [
                {
                  question: "Will the highest temperature be 32°C?",
                  conditionId: "0xcondition",
                  slug: "highest-temperature-in-shenzhen-on-july-19-2026-32c",
                  endDate: "2026-07-19T12:00:00Z",
                  outcomes: ["Yes", "No"],
                  clobTokenIds: ["yes-token", "no-token"],
                  negRisk: true,
                  acceptingOrders: true,
                },
              ],
            },
          ],
          next_cursor: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const logger = pino({ enabled: false });
    const client = new GammaClient(new JsonHttpClient("https://gamma-api.polymarket.com", 1000, logger, 1));
    const event = await client.getEventBySeriesDate("shenzhen-daily-weather", "2026-07-19", {
      includeYes: true,
      includeNo: true,
    });

    expect(event.eventId).toBe("712468");
    expect(event.eventSlug).toBe("highest-temperature-in-shenzhen-on-july-19-2026");
    expect(event.assets).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when Series/date discovery is ambiguous", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/series") {
        return new Response(JSON.stringify([{ id: "11366", slug: "shenzhen-daily-weather" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const candidate = {
        id: "712468",
        slug: "highest-temperature-in-shenzhen-on-july-19-2026",
        eventDate: "2026-07-19",
        seriesSlug: "shenzhen-daily-weather",
        markets: [],
      };
      return new Response(JSON.stringify({ events: [candidate, { ...candidate, id: "712469" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const logger = pino({ enabled: false });
    const client = new GammaClient(new JsonHttpClient("https://gamma-api.polymarket.com", 1000, logger, 1));
    await expect(
      client.getEventBySeriesDate("shenzhen-daily-weather", "2026-07-19", {
        includeYes: true,
        includeNo: true,
      }),
    ).rejects.toThrow("found 2");
  });
});
