import { Mutex } from "async-mutex"
import axios from "axios"

import {
  InvalidTickerError,
  ExchangeServiceError,
  InvalidExchangeResponseError,
  UnknownExchangeServiceError,
} from "@domain/exchanges"
import { toPrice, toSeconds, toTimestamp } from "@domain/primitives"
import { LocalCacheService } from "@services/cache"
import { CacheKeys } from "@domain/cache"
import { baseLogger } from "@services/logger"
import IbexClient, { IbexUrls } from "ibex-client"
import { AuthenticationError } from "ibex-client/dist/errors"
import { IBEX } from "@config"

import { AuthCache } from "../ibex/cache"
import { getIbexId, IbexExchangeService } from "../ibex"

const mutex = new Mutex()

type SwapRatesHttpResult = { status: number; body: unknown }

// GET /rates covers fewer currencies than the legacy Rates v2 endpoint: JMD,
// HTG and CAD (among others) answer 400 "to currency is not supported"
// (verified live against sandbox). Those are not transient, and JMD is the
// home market — failing them here would leave the app pricing Jamaica off a
// mid-market FX provider instead of IBEX's own rate. Detect that answer and
// serve the pair from the legacy provider instead.
const isUnsupportedCurrencyBody = (body: unknown): boolean => {
  if (!body || typeof body !== "object") return false
  const { error } = body as { error?: unknown }
  return typeof error === "string" && /not supported/i.test(error)
}

// IBEX "Swap Rates" provider (docs.poweredbyibex.io/reference/swap-rates).
//
// Unlike the legacy `ibex` provider (Rates v2, mid-market-ish, display-only),
// GET /rates returns *fee/spread-inclusive* rates for both directions, i.e.
// the prices IBEX will actually execute swaps at. Keeping it as a separate
// provider lets ops A/B the two via config without touching `ibex`.
export const IbexSwapExchangeService = async ({
  base,
  quote,
  config,
}: IbexSwapExchangeServiceArgs): Promise<IExchangeService | ExchangeServiceError> => {
  const cacheSeconds = Number(config?.cacheSeconds || 180)
  const timeout = Number(config?.timeout || 5000)

  // Same credentials, environment resolution and (redis-backed) token cache as
  // the legacy `ibex` provider — ibex-client owns the oauth client-credentials
  // flow. The lib does not expose GET /rates, so we issue that call ourselves
  // against the same hub base URL, inside the lib's withAuth wrapper.
  const Ibex = new IbexClient(
    {
      clientId: IBEX.clientId,
      clientSecret: IBEX.clientSecret,
      environment: IBEX.environment,
    },
    AuthCache,
  )
  const baseUrl = IbexUrls[IBEX.environment].hubUrl

  const cacheKey = `${CacheKeys.CurrentTicker}:IbexSwap:${base}:${quote}`
  const cacheTtlSecs = Number(cacheSeconds)
  const cacheKeyStatus = `${cacheKey}:status`

  // Set once, when Swap Rates tells us this pair is unsupported; from then on
  // every fetch for this instance is served by the legacy provider. The
  // exchange factory memoises one service per base/quote, so this is per pair.
  let legacyFallback: IExchangeService | null = null

  const fetchViaLegacyProvider = async (): Promise<Ticker | ServiceError> => {
    if (!legacyFallback) {
      const legacy = await IbexExchangeService({ base, quote, config })
      if (legacy instanceof Error) return legacy
      legacyFallback = legacy
      baseLogger.info(
        { base, quote },
        "IbexSwap: pair unsupported by Swap Rates, using legacy Ibex rates",
      )
    }
    return legacyFallback.fetchTicker()
  }

  const getCachedRates = async (): Promise<IbexSwapRates | undefined> => {
    const cachedRates = await LocalCacheService().get<IbexSwapRates>(cacheKey)
    if (cachedRates instanceof Error) return undefined
    return cachedRates
  }

  const getLastRequestStatus = async (): Promise<number> => {
    const status = await LocalCacheService().get<number>(cacheKeyStatus)
    if (status instanceof Error) return 0
    return status
  }

  const fetchTicker = async (): Promise<Ticker | ServiceError> => {
    // Swap Rates responses carry no timestamp — rates are quoted "now"
    const timestamp = new Date().getTime()

    try {
      // Established fallback wins over everything else, including the cached
      // error status below — that pair never comes back from Swap Rates.
      if (legacyFallback) return fetchViaLegacyProvider()

      const cachedRates = await getCachedRates()
      if (cachedRates) return tickerFromRaw({ ...cachedRates, timestamp })

      // back off until the status cache expires if the last request errored
      const lastCachedStatus = await getLastRequestStatus()
      if (lastCachedStatus >= 400)
        return new UnknownExchangeServiceError(
          `Previous request failed. Error ${lastCachedStatus}`,
        )

      const fromId = getIbexId(base)
      const toId = getIbexId(quote)
      if (fromId === undefined)
        return new ExchangeServiceError(`Ibex Id not found for currency ${base}`)
      if (toId === undefined)
        return new ExchangeServiceError(`Ibex Id not found for currency ${quote}`)

      const swapRatesRequest = async (): Promise<{ data: SwapRatesHttpResult }> => {
        const token = await Ibex.authentication.storage.getAccessToken()
        if (typeof token !== "string")
          throw unauthorizedError("No IBEX access token in cache")

        const response = await axios.get(`${baseUrl}/rates`, {
          // IBEX expects the raw JWT: its openapi security scheme is an apiKey
          // header named "Authorization", not http-bearer. A "Bearer " prefix
          // is rejected with 401 (verified live against sandbox).
          headers: { Authorization: token },
          params: { from: fromId, to: toId },
          timeout,
          validateStatus: () => true, // HTTP errors are handled below
        })

        // a thrown { status: 401 } makes withAuth refresh the token and retry once
        if (response.status === 401)
          throw unauthorizedError("IBEX swap rates request unauthorized")

        return { data: { status: response.status, body: response.data } }
      }

      // Reuse ibex-client's auth plumbing (cached token, refresh + single retry
      // on 401). withAuth only ever reads `.data` off the response, so passing
      // our plain { data } envelope through the cast is safe.
      const authResp = await Ibex.authentication.withAuth(
        swapRatesRequest as unknown as Parameters<typeof Ibex.authentication.withAuth>[0],
      )
      if (authResp instanceof AuthenticationError)
        return new ExchangeServiceError(authResp.message)

      const { status, body } = authResp as SwapRatesHttpResult
      if (status === 400 && isUnsupportedCurrencyBody(body)) {
        return fetchViaLegacyProvider()
      }
      if (status >= 400) {
        await LocalCacheService().set<number>({
          key: cacheKeyStatus,
          value: status,
          ttlSecs: toSeconds(cacheTtlSecs > 0 ? cacheTtlSecs : 300),
        })
        return new UnknownExchangeServiceError(`Invalid response. Status ${status}`)
      }

      if (!isSwapRatesBodyValid(body))
        return new InvalidExchangeResponseError(
          "Invalid response. Missing rate or inverseRate.",
        )

      const rates: IbexSwapRates = { rate: body.rate, inverseRate: body.inverseRate }
      await LocalCacheService().set<IbexSwapRates>({
        key: cacheKey,
        value: rates,
        ttlSecs: toSeconds(cacheTtlSecs > 0 ? cacheTtlSecs : 300),
      })

      return tickerFromRaw({ ...rates, timestamp })
    } catch (error) {
      baseLogger.error({ error }, "IbexSwap unknown error")
      return new UnknownExchangeServiceError(error.message || error)
    }
  }

  return {
    fetchTicker: () => mutex.runExclusive(fetchTicker),
  }
}

const unauthorizedError = (message: string): Error & { status: number } =>
  Object.assign(new Error(message), { status: 401 })

const isSwapRatesBodyValid = (body: unknown): body is IbexSwapRates => {
  if (!body || typeof body !== "object") return false
  const { rate, inverseRate } = body as { rate?: unknown; inverseRate?: unknown }
  return (
    typeof rate === "number" &&
    Number.isFinite(rate) &&
    rate > 0 &&
    typeof inverseRate === "number" &&
    Number.isFinite(inverseRate) &&
    inverseRate > 0
  )
}

const tickerFromRaw = ({
  rate,
  inverseRate,
  timestamp,
}: {
  rate: number
  inverseRate: number
  timestamp: number
}): Ticker | InvalidTickerError => {
  if (rate > 0 && inverseRate > 0 && timestamp > 0) {
    // For from=base&to=quote, BOTH fields are quoted in quote-per-base units
    // (verified live on sandbox: BTC→USD returned rate=63968.8481,
    // inverseRate=64870.7251, with the Rates v2 mid ~64,407 sitting between):
    //   rate        = executable base→quote side (selling base — the bid)
    //   inverseRate = the other side of the same market (buying base — the ask)
    // `inverseRate` is NOT a reciprocal — each side carries its own
    // fee/spread — so there is no 1/x here; min/max keeps bid <= ask
    // however fees land.
    return {
      bid: toPrice(Math.min(rate, inverseRate)),
      ask: toPrice(Math.max(rate, inverseRate)),
      timestamp: toTimestamp(timestamp),
    }
  }

  return new InvalidTickerError()
}
