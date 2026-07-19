import { z } from "zod";

import type { UserActivity, UserPosition } from "../domain/types.js";
import { JsonHttpClient } from "./http-client.js";

const numberLike = z.union([z.number(), z.string()]);

const positionSchema = z
  .object({
    proxyWallet: z.string(),
    asset: z.string(),
    conditionId: z.string(),
    size: numberLike,
    avgPrice: numberLike.default("0"),
    initialValue: numberLike.default("0"),
    currentValue: numberLike.default("0"),
    curPrice: numberLike.default("0"),
    outcome: z.string().default(""),
    slug: z.string().default(""),
    eventSlug: z.string().default(""),
  })
  .passthrough();

const activitySchema = z
  .object({
    proxyWallet: z.string(),
    timestamp: z.number().int(),
    conditionId: z.string(),
    type: z.string(),
    size: numberLike,
    usdcSize: numberLike.default("0"),
    transactionHash: z.string(),
    price: numberLike,
    asset: z.string(),
    side: z.enum(["BUY", "SELL"]),
    outcome: z.string().default(""),
    slug: z.string().default(""),
    eventSlug: z.string().default(""),
  })
  .passthrough();

export class DataClient {
  public constructor(private readonly http: JsonHttpClient) {}

  public async getPositions(user: string, eventId: string): Promise<UserPosition[]> {
    const raw = await this.http.get("/positions", {
      user,
      eventId,
      sizeThreshold: 0,
      limit: 500,
    });
    const positions = z.array(positionSchema).parse(raw);
    return positions.map((position) => ({
      proxyWallet: position.proxyWallet.toLowerCase(),
      tokenId: position.asset,
      conditionId: position.conditionId,
      size: String(position.size),
      avgPrice: String(position.avgPrice),
      initialValue: String(position.initialValue),
      currentValue: String(position.currentValue),
      curPrice: String(position.curPrice),
      outcome: position.outcome,
      marketSlug: position.slug,
      eventSlug: position.eventSlug,
      raw: position,
    }));
  }

  public async getActivity(user: string, eventId: string, startTimestamp: number): Promise<UserActivity[]> {
    const raw = await this.http.get("/activity", {
      user,
      eventId,
      type: "TRADE",
      start: Math.max(0, startTimestamp),
      sortDirection: "ASC",
      limit: 500,
    });
    const activity = z.array(activitySchema).parse(raw);
    return activity.map((item) => ({
      proxyWallet: item.proxyWallet.toLowerCase(),
      timestamp: item.timestamp,
      conditionId: item.conditionId,
      type: item.type,
      size: String(item.size),
      usdcSize: String(item.usdcSize),
      transactionHash: item.transactionHash,
      price: String(item.price),
      tokenId: item.asset,
      side: item.side,
      outcome: item.outcome,
      marketSlug: item.slug,
      eventSlug: item.eventSlug,
      raw: item,
    }));
  }
}
