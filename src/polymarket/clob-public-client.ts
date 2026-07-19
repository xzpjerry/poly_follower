import { z } from "zod";

import type { OrderBook } from "../domain/types.js";
import { JsonHttpClient } from "./http-client.js";

const numberLike = z.union([z.number(), z.string()]);
const levelSchema = z.object({ price: numberLike, size: numberLike }).passthrough();
const bookSchema = z
  .object({
    market: z.string().default(""),
    asset_id: z.string(),
    timestamp: numberLike.default("0"),
    bids: z.array(levelSchema).default([]),
    asks: z.array(levelSchema).default([]),
    min_order_size: numberLike.optional(),
    tick_size: numberLike.optional(),
    neg_risk: z.boolean().optional(),
  })
  .passthrough();

function normalizeTimestamp(value: string | number): number {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) {
    return 0;
  }
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}

export class ClobPublicClient {
  public constructor(private readonly http: JsonHttpClient) {}

  public async getOrderBook(tokenId: string): Promise<OrderBook> {
    const raw = await this.http.get("/book", { token_id: tokenId });
    const receivedAtMs = Date.now();
    const book = bookSchema.parse(raw);
    if (book.asset_id !== tokenId) {
      throw new Error(`CLOB returned order book for unexpected token ${book.asset_id}`);
    }

    return {
      tokenId,
      market: book.market,
      sourceTimestampMs: normalizeTimestamp(book.timestamp),
      // A successful REST snapshot is fresh when received even if the CLOB's
      // source timestamp reflects the last book mutation in a quiet market.
      timestampMs: receivedAtMs,
      bids: book.bids
        .map((level) => ({ price: String(level.price), size: String(level.size) }))
        .sort((left, right) => Number(right.price) - Number(left.price)),
      asks: book.asks
        .map((level) => ({ price: String(level.price), size: String(level.size) }))
        .sort((left, right) => Number(left.price) - Number(right.price)),
      ...(book.min_order_size === undefined ? {} : { minOrderSize: String(book.min_order_size) }),
      ...(book.tick_size === undefined ? {} : { tickSize: String(book.tick_size) }),
      ...(book.neg_risk === undefined ? {} : { negRisk: book.neg_risk }),
      raw,
    };
  }
}
