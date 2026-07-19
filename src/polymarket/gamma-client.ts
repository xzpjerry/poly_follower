import { z } from "zod";

import type { DiscoveredEvent, FeeSchedule, TrackedAsset } from "../domain/types.js";
import { JsonHttpClient } from "./http-client.js";

const numberLike = z.union([z.number(), z.string()]);
const stringArrayLike = z.union([z.array(z.string()), z.string()]);

const marketSchema = z
  .object({
    question: z.string().default(""),
    conditionId: z.string().min(1),
    slug: z.string().min(1),
    endDate: z.string().default(""),
    outcomes: stringArrayLike,
    clobTokenIds: stringArrayLike,
    negRisk: z.boolean().default(false),
    orderPriceMinTickSize: numberLike.default("0.01"),
    orderMinSize: numberLike.default("5"),
    acceptingOrders: z.boolean().default(false),
    feesEnabled: z.boolean().default(false),
    feeSchedule: z
      .object({
        exponent: z.number().default(1),
        rate: numberLike.default("0"),
        takerOnly: z.boolean().default(true),
      })
      .optional(),
  })
  .passthrough();

const eventSchema = z
  .object({
    id: numberLike,
    slug: z.string().min(1),
    title: z.string().default(""),
    eventDate: z.string().nullish().transform((value) => value ?? ""),
    seriesSlug: z.string().nullish().transform((value) => value ?? ""),
    active: z.boolean().default(false),
    closed: z.boolean().default(false),
    archived: z.boolean().nullish().transform((value) => value ?? false),
    endDate: z.string().default(""),
    markets: z.array(marketSchema),
  })
  .passthrough();
const eventKeysetSchema = z.object({
  events: z.array(eventSchema),
  next_cursor: z.string().nullable().optional(),
});
const seriesSchema = z
  .object({
    id: numberLike,
    slug: z.string().min(1),
    title: z.string().nullish().transform((value) => value ?? ""),
    recurrence: z.string().nullish().transform((value) => value ?? ""),
  })
  .passthrough();
const seriesListSchema = z.array(seriesSchema);
type GammaEvent = z.infer<typeof eventSchema>;

function parseStringArray(value: string[] | string, fieldName: string): string[] {
  if (Array.isArray(value)) {
    return value;
  }
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`${fieldName} is not a string array`);
  }
  return parsed;
}

function normalizeFeeSchedule(
  enabled: boolean,
  raw: { exponent: number; rate: string | number; takerOnly: boolean } | undefined,
): FeeSchedule {
  return {
    enabled,
    rate: enabled ? String(raw?.rate ?? "0") : "0",
    exponent: raw?.exponent ?? 1,
    takerOnly: raw?.takerOnly ?? true,
  };
}

export class GammaClient {
  private readonly seriesIds = new Map<string, string>();

  public constructor(private readonly http: JsonHttpClient) {}

  public async getEventBySlug(
    eventSlug: string,
    outcomeFilter: { includeYes: boolean; includeNo: boolean },
  ): Promise<DiscoveredEvent> {
    const raw = await this.http.get(`/events/slug/${encodeURIComponent(eventSlug)}`);
    const event = eventSchema.parse(raw);

    if (event.slug !== eventSlug) {
      throw new Error(`Gamma returned unexpected event slug ${event.slug}`);
    }

    return this.expandEvent(event, outcomeFilter);
  }

  public async getEventBySeriesDate(
    seriesSlug: string,
    eventDate: string,
    outcomeFilter: { includeYes: boolean; includeNo: boolean },
  ): Promise<DiscoveredEvent> {
    const seriesId = await this.getSeriesId(seriesSlug);
    const raw = await this.http.get("/events/keyset", {
      series_id: seriesId,
      event_date: `${eventDate}T00:00:00Z`,
      limit: 20,
    });
    const response = eventKeysetSchema.parse(raw);
    const candidates = response.events.filter(
      (event) => event.seriesSlug === seriesSlug && event.eventDate === eventDate,
    );
    if (candidates.length !== 1) {
      throw new Error(
        `Expected exactly one Gamma event for series ${seriesSlug} on ${eventDate}; found ${candidates.length}`,
      );
    }
    const event = candidates[0];
    if (!event) {
      throw new Error(`Gamma event candidate disappeared for series ${seriesSlug} on ${eventDate}`);
    }
    return this.expandEvent(event, outcomeFilter);
  }

  private async getSeriesId(seriesSlug: string): Promise<string> {
    const cached = this.seriesIds.get(seriesSlug);
    if (cached) {
      return cached;
    }
    const raw = await this.http.get("/series", { slug: seriesSlug });
    const matches = seriesListSchema.parse(raw).filter((series) => series.slug === seriesSlug);
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one Gamma series for slug ${seriesSlug}; found ${matches.length}`);
    }
    const series = matches[0];
    if (!series) {
      throw new Error(`Gamma series candidate disappeared for slug ${seriesSlug}`);
    }
    const seriesId = String(series.id);
    this.seriesIds.set(seriesSlug, seriesId);
    return seriesId;
  }

  private expandEvent(
    event: GammaEvent,
    outcomeFilter: { includeYes: boolean; includeNo: boolean },
  ): DiscoveredEvent {
    const eventId = String(event.id);
    const assets: TrackedAsset[] = [];

    for (const market of event.markets) {
      const outcomes = parseStringArray(market.outcomes, `${market.slug}.outcomes`);
      const tokenIds = parseStringArray(market.clobTokenIds, `${market.slug}.clobTokenIds`);
      if (outcomes.length !== tokenIds.length) {
        throw new Error(`Outcome/token length mismatch for market ${market.slug}`);
      }

      const feeSchedule = normalizeFeeSchedule(market.feesEnabled, market.feeSchedule);
      for (let index = 0; index < tokenIds.length; index += 1) {
        const tokenId = tokenIds[index];
        const outcome = outcomes[index];
        if (!tokenId || !outcome) {
          throw new Error(`Missing outcome/token mapping for market ${market.slug}`);
        }
        const normalizedOutcome = outcome.toLowerCase();
        if (normalizedOutcome === "yes" && !outcomeFilter.includeYes) {
          continue;
        }
        if (normalizedOutcome === "no" && !outcomeFilter.includeNo) {
          continue;
        }

        assets.push({
          eventId,
          eventSlug: event.slug,
          marketSlug: market.slug,
          marketTitle: market.question,
          conditionId: market.conditionId,
          tokenId,
          outcome,
          negRisk: market.negRisk,
          tickSize: String(market.orderPriceMinTickSize),
          minOrderSize: String(market.orderMinSize),
          acceptingOrders: market.acceptingOrders,
          endDate: market.endDate || event.endDate,
          feeSchedule,
        });
      }
    }

    if (assets.length === 0) {
      throw new Error(`Event ${event.slug} has no tracked outcome assets`);
    }

    return {
      eventId,
      eventSlug: event.slug,
      title: event.title,
      active: event.active,
      closed: event.closed,
      endDate: event.endDate,
      assets,
      raw: event,
    };
  }
}
