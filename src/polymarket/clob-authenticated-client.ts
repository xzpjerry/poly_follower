import {
  AssetType,
  Chain,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  type ApiKeyCreds,
  type BalanceAllowanceResponse,
  type TickSize,
} from "@polymarket/clob-client-v2";
import { Decimal } from "decimal.js";
import type { Logger } from "pino";
import { createWalletClient, http, isAddressEqual } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

import { calculateTakerFee } from "../domain/fees.js";
import type {
  DiscoveredEvent,
  FollowerTrade,
  PendingOrder,
  ReconciliationDecision,
  TrackedAsset,
} from "../domain/types.js";
import type { TradingCredentials } from "../security/credentials.js";

const CLOB_HOST = "https://clob.polymarket.com";
const TOKEN_DECIMALS = new Decimal(1_000_000);
const TICK_SIZES = new Set<TickSize>(["0.1", "0.01", "0.005", "0.0025", "0.001", "0.0001"]);
const gammaProfileSchema = z.object({
  proxyWallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
});
const apiCredentialsSchema = z.object({
  key: z.string().min(1),
  secret: z.string().min(1),
  passphrase: z.string().min(1),
});

export interface AuthenticatedAccountStatus {
  signerAddress: string;
  funderAddress: string;
  profileMappedProxyAddress: string;
  signatureType: SignatureTypeV2;
  credentialSource: "file" | "derived-in-memory";
  closedOnly: boolean;
  collateralBalanceUsd: string;
  collateralAllowanceCount: number;
}

export interface ExecutionReceipt {
  orderId: string;
  status: string;
  takingAmount: string;
  makingAmount: string;
  tradeIds: string[];
  transactionHashes: string[];
}

async function getProfileMappedProxyWallet(signerAddress: string): Promise<string> {
  const url = new URL("/public-profile", "https://gamma-api.polymarket.com");
  url.searchParams.set("address", signerAddress);
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "polymarket-weather-follower/0.1" },
  });
  if (!response.ok) {
    throw new Error(`Gamma public-profile identity lookup failed with HTTP ${response.status}`);
  }
  return gammaProfileSchema.parse(await response.json()).proxyWallet;
}

function parseTickSize(raw: string): TickSize {
  if (!TICK_SIZES.has(raw as TickSize)) {
    throw new Error(`Unsupported CLOB tick size: ${raw}`);
  }
  return raw as TickSize;
}

function toSafeNumber(raw: Decimal.Value, field: string): number {
  const value = new Decimal(raw);
  const converted = value.toNumber();
  if (!Number.isFinite(converted) || value.isNegative()) {
    throw new Error(`${field} cannot be represented as a non-negative finite number`);
  }
  return converted;
}

function toSixDecimalAmount(raw: Decimal.Value): number {
  return toSafeNumber(new Decimal(raw).toDecimalPlaces(6, Decimal.ROUND_DOWN), "order amount");
}

function availableBaseUnits(response: BalanceAllowanceResponse): Decimal {
  return new Decimal(response.balance);
}

function hasSufficientAllowance(response: BalanceAllowanceResponse, requiredBaseUnits: Decimal): boolean {
  return Object.values(response.allowances).some((allowance) => new Decimal(allowance).greaterThanOrEqualTo(requiredBaseUnits));
}

export class AuthenticatedClobClient {
  private constructor(
    private readonly client: ClobClient,
    private readonly logger: Logger,
    public readonly signerAddress: string,
    public readonly funderAddress: string,
    public readonly profileMappedProxyAddress: string,
    public readonly signatureType: SignatureTypeV2,
    public readonly credentialSource: "file" | "derived-in-memory",
  ) {}

  public static async connect(
    credentials: TradingCredentials,
    followerProfileWallet: string,
    signatureType: SignatureTypeV2,
    logger: Logger,
  ): Promise<AuthenticatedClobClient> {
    const account = privateKeyToAccount(credentials.privateKey);
    const profileMappedProxyAddress = await getProfileMappedProxyWallet(account.address);
    if (!isAddressEqual(profileMappedProxyAddress as `0x${string}`, followerProfileWallet as `0x${string}`)) {
      throw new Error(
        "Gamma signer-to-profile mapping does not match configured follower profile wallet",
      );
    }

    const signer = createWalletClient({
      account,
      transport: http(process.env.POLYGON_RPC_URL?.trim() || "https://polygon-rpc.com"),
    });
    let apiCredentials: ApiKeyCreds;
    let credentialSource: "file" | "derived-in-memory";
    if (credentials.clob) {
      apiCredentials = credentials.clob;
      credentialSource = "file";
    } else {
      const l1Client = new ClobClient({
        host: CLOB_HOST,
        chain: Chain.POLYGON,
        signer,
        useServerTime: true,
        retryOnError: false,
        // The SDK's createOrDerive helper only reaches derive when create
        // returns an error object; throwOnError=true prevents that fallback.
        throwOnError: false,
      });
      apiCredentials = apiCredentialsSchema.parse(await l1Client.createOrDeriveApiKey());
      credentialSource = "derived-in-memory";
    }

    const client = new ClobClient({
      host: CLOB_HOST,
      chain: Chain.POLYGON,
      signer,
      creds: apiCredentials,
      signatureType,
      funderAddress: followerProfileWallet,
      useServerTime: true,
      retryOnError: false,
      throwOnError: true,
    });
    const authenticated = new AuthenticatedClobClient(
      client,
      logger,
      account.address.toLowerCase(),
      followerProfileWallet.toLowerCase(),
      profileMappedProxyAddress.toLowerCase(),
      signatureType,
      credentialSource,
    );

    return authenticated;
  }

  public async getAccountStatus(): Promise<AuthenticatedAccountStatus> {
    // The CLOB balance endpoint serves a cache. Refresh it before reporting
    // account readiness so a newly funded or migrated pUSD balance is not
    // mistaken for zero. This endpoint does not submit an onchain transaction.
    await this.client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const [banStatus, collateral] = await Promise.all([
      this.client.getClosedOnlyMode(),
      this.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
    ]);
    return {
      signerAddress: this.signerAddress,
      funderAddress: this.funderAddress,
      profileMappedProxyAddress: this.profileMappedProxyAddress,
      signatureType: this.signatureType,
      credentialSource: this.credentialSource,
      closedOnly: banStatus.closed_only,
      collateralBalanceUsd: availableBaseUnits(collateral).div(TOKEN_DECIMALS).toFixed(6),
      collateralAllowanceCount: Object.keys(collateral.allowances).length,
    };
  }

  public async getOpenOrders(event: DiscoveredEvent): Promise<PendingOrder[]> {
    const assetByToken = new Map(event.assets.map((asset) => [asset.tokenId, asset]));
    const allowedConditions = new Set(event.assets.map((asset) => asset.conditionId.toLowerCase()));
    const orders = await this.client.getOpenOrders();
    const pending: PendingOrder[] = [];

    for (const order of orders) {
      const asset = assetByToken.get(order.asset_id);
      if (!asset || !allowedConditions.has(order.market.toLowerCase())) {
        continue;
      }
      const remaining = Decimal.max(0, new Decimal(order.original_size).minus(order.size_matched));
      if (remaining.isZero()) {
        continue;
      }
      const side = order.side.toUpperCase();
      if (side !== "BUY" && side !== "SELL") {
        throw new Error(`CLOB returned unsupported order side for ${order.id}`);
      }
      const reservedDebit =
        side === "BUY"
          ? remaining.mul(order.price).plus(calculateTakerFee(remaining, order.price, asset.feeSchedule))
          : new Decimal(0);
      pending.push({
        orderId: order.id,
        tokenId: order.asset_id,
        side,
        remainingShares: remaining.toFixed(),
        reservedDebit: reservedDebit.toFixed(),
      });
    }
    return pending;
  }

  public async getTrades(event: DiscoveredEvent): Promise<FollowerTrade[]> {
    const allowedTokens = new Set(event.assets.map((asset) => asset.tokenId));
    const conditionIds = [...new Set(event.assets.map((asset) => asset.conditionId))];
    const pages = await Promise.all(conditionIds.map((market) => this.client.getTrades({ market })));
    const trades: FollowerTrade[] = [];

    for (const trade of pages.flat()) {
      if (!allowedTokens.has(trade.asset_id)) {
        continue;
      }
      const side = String(trade.side).toUpperCase();
      if (side !== "BUY" && side !== "SELL") {
        throw new Error(`CLOB returned unsupported trade side for ${trade.id}`);
      }
      trades.push({
        tradeId: trade.id,
        tokenId: trade.asset_id,
        side,
        size: trade.size,
        price: trade.price,
        traderSide: trade.trader_side,
        matchedAt: trade.match_time_nano ?? trade.match_time,
        raw: trade,
      });
    }
    return trades;
  }

  public async preflightFok(decision: ReconciliationDecision): Promise<void> {
    if (decision.action !== "BUY" && decision.action !== "SELL") {
      throw new Error("Only actionable reconciliation decisions can be executed");
    }
    if (decision.worstPrice === null) {
      throw new Error("Actionable decision is missing a worst price");
    }
    const parameters =
      decision.action === "BUY"
        ? { asset_type: AssetType.COLLATERAL }
        : { asset_type: AssetType.CONDITIONAL, token_id: decision.tokenId };
    await this.client.updateBalanceAllowance(parameters);
    const balance = await this.client.getBalanceAllowance(parameters);
    const required =
      decision.action === "BUY"
        ? new Decimal(decision.estimatedDebit).mul(TOKEN_DECIMALS).ceil()
        : new Decimal(decision.deltaSize).abs().mul(TOKEN_DECIMALS).ceil();

    if (availableBaseUnits(balance).lessThan(required)) {
      throw new Error(`${decision.action} preflight failed: insufficient funder balance`);
    }
    if (!hasSufficientAllowance(balance, required)) {
      throw new Error(`${decision.action} preflight failed: insufficient exchange allowance`);
    }
  }

  public async executeFok(decision: ReconciliationDecision, asset: TrackedAsset): Promise<ExecutionReceipt> {
    if (decision.action !== "BUY" && decision.action !== "SELL") {
      throw new Error("Only actionable reconciliation decisions can be executed");
    }
    if (decision.worstPrice === null) {
      throw new Error("Actionable decision is missing a worst price");
    }

    const side = decision.action === "BUY" ? Side.BUY : Side.SELL;
    const amount =
      decision.action === "BUY" ? decision.estimatedDebit : new Decimal(decision.deltaSize).abs().toFixed();
    this.logger.info(
      {
        tokenId: decision.tokenId,
        side: decision.action,
        amount,
        worstPrice: decision.worstPrice,
        orderType: OrderType.FOK,
      },
      "Submitting guarded FOK order",
    );
    const response = await this.client.createAndPostMarketOrder(
      {
        tokenID: decision.tokenId,
        amount: toSixDecimalAmount(amount),
        price: toSafeNumber(decision.worstPrice, "worst price"),
        side,
        orderType: OrderType.FOK,
      },
      { tickSize: parseTickSize(asset.tickSize), negRisk: asset.negRisk },
      OrderType.FOK,
      false,
    );
    if (!response.success) {
      throw new Error(`CLOB rejected FOK order: ${response.errorMsg || response.status || "unknown error"}`);
    }
    return {
      orderId: response.orderID,
      status: response.status,
      takingAmount: response.takingAmount,
      makingAmount: response.makingAmount,
      tradeIds: response.tradeIDs ?? [],
      transactionHashes: response.transactionsHashes ?? [],
    };
  }
}
