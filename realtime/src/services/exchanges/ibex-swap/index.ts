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

// Module-scoped: shared by every base/quote pair of this provider. Only the
// Swap Rates leg runs inside it — see `fetchTicker` at the bottom.
const mutex = new Mutex()

type SwapRatesHttpResult = { status: number; body: unknown }

// Returned by the mutex-guarded Swap Rates leg so the caller can run the legacy
// leg *outside* the mutex.
const UNSUPPORTED_PAIR = Symbol("swap-rates-unsupported-pair")

// How long a pair stays pinned to the legacy provider before Swap Rates is
// probed again. IBEX adding a missing pair (JMD above all) is the expected
// outcome, not a hypothetical, so the decision has to expire on its own rather
// than wait for a pod restart. Override with `config.unsupportedTtlSeconds`.
const DEFAULT_UNSUPPORTED_TTL_SECS = 3600

// GET /rates covers fewer currencies than the legacy Rates v2 endpoint: JMD,
// HTG and CAD (among others) answer 400 {"error":"to currency is not
// supported"} (verified live against sandbox). Those are not transient, and JMD
// is the home market — failing them here would leave the app pricing Jamaica
// off a mid-market FX provider instead of IBEX's own rate. Detect that answer
// and serve the pair from the legacy provider instead.
//
// Matched on the full "currency is not supported" phrase rather than a bare
// "not supported": an unrelated 400 (an entitlement or account-scope error,
// say) must not divert a pair that Swap Rates can actually price.
const isUnsupportedCurrencyBody = (body: unknown): boolean => {
  if (!body || typeof body !== "object") return false
  const { error } = body as { error?: unknown }
  return typeof error === "string" && /currency is not supported/i.test(error)
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
  const configuredUnsupportedTtl = Number(config?.unsupportedTtlSeconds)
  const unsupportedTtlSecs =
    configuredUnsupportedTtl > 0 ? configuredUnsupportedTtl : DEFAULT_UNSUPPORTED_TTL_SECS

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
  const cacheKeyUnsupported = `${cacheKey}:unsupported`

  // Memoises the legacy service *instance* only — building it is the expensive
  // part. Whether we use it is decided by the TTL'd `:unsupported` cache entry,
  // never by this variable, so a pair that gains Swap Rates support recovers
  // without a restart.
  let legacyService: IExchangeService | null = null

  // Set once Swap Rates has told us this pair is unsupported. It never
  // suppresses a probe — the TTL'd `:unsupported` entry alone decides that —
  // it only decides what we serve when a probe *fails*. Without it, the hour
  // the flag ages out is an hour in which any non-400 answer (a transient 500,
  // a timeout) returns an error and poisons `:status`, taking the home market
  // off IBEX rates for the whole status TTL. A pair that genuinely gains Swap
  // Rates support probes successfully and stops reaching this at all.
  let hasFallenBack = false

  const cacheErrorStatus = async (status: number) => {
    await LocalCacheService().set<number>({
      key: cacheKeyStatus,
      value: status,
      ttlSecs: toSeconds(cacheTtlSecs > 0 ? cacheTtlSecs : 300),
    })
  }

  const markPairUnsupported = async () => {
    hasFallenBack = true
    await LocalCacheService().set<number>({
      key: cacheKeyUnsupported,
      value: 1,
      ttlSecs: toSeconds(unsupportedTtlSecs),
    })
    baseLogger.info(
      { base, quote, reprobeInSecs: unsupportedTtlSecs },
      "IbexSwap: pair unsupported by Swap Rates, using legacy Ibex rates",
    )
  }

  const isPairUnsupported = async (): Promise<boolean> => {
    const flag = await LocalCacheService().get<number>(cacheKeyUnsupported)
    if (flag instanceof Error) return false
    return !!flag
  }

  const legacyTicker = async (): Promise<Ticker | ServiceError> => {
    if (!legacyService) {
      // The legacy leg gets its own cap rather than inheriting this probe's.
      // `createIbexSwap` defaults `timeout` to 5s for GET /rates, but
      // `createIbex` deliberately ships 10s for Rates v2 (its latency is
      // unmeasured, and cutting it drops the pair onto a mid-market FX
      // provider — the exact outcome this fallback exists to prevent).
      // Forwarding `config` verbatim would hand the JMD fallback the 5s cap.
      const configuredLegacyTimeout = Number(config?.legacyTimeout)
      const legacyTimeout =
        Number.isFinite(configuredLegacyTimeout) && configuredLegacyTimeout > 0
          ? configuredLegacyTimeout
          : 10000
      const legacy = await IbexExchangeService({
        base,
        quote,
        config: { ...config, timeout: legacyTimeout },
      })
      if (legacy instanceof Error) return legacy
      legacyService = legacy
    }
    return legacyService.fetchTicker()
  }

  const fetchViaLegacyProvider = async (): Promise<Ticker | ServiceError> => {
    const result = await legacyTicker()
    // Both legs are down: back the pair off like any other failure here, so the
    // Swap Rates probe is not retried on every 15s tick while the legacy
    // provider cannot even be constructed. 503 is a synthetic marker — no Swap
    // Rates request produced it — and it only gates the probe, never the legacy
    // leg above.
    if (result instanceof Error) await cacheErrorStatus(503)
    return result
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

  const fetchViaSwapRates = async (): Promise<
    Ticker | ServiceError | typeof UNSUPPORTED_PAIR
  > => {
    // Swap Rates responses carry no timestamp — rates are quoted "now"
    const timestamp = new Date().getTime()

    try {
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
        await markPairUnsupported()
        return UNSUPPORTED_PAIR
      }
      if (status >= 400) {
        await cacheErrorStatus(status)
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

  const fetchTicker = async (): Promise<Ticker | ServiceError> => {
    // A pair Swap Rates has told us it does not support goes straight to the
    // legacy provider, ahead of the cached-error backoff inside
    // `fetchViaSwapRates` — a transient 500 on BTC:JMD must not knock the home
    // market onto a mid-market FX provider for the length of the status TTL.
    //
    // Deliberately outside `mutex`: that mutex is module-scoped, i.e. one lock
    // for every base/quote pair of this provider. The legacy leg has its own
    // (`../ibex`) plus a retry inside withAuth, so holding this one across it
    // would let a slow Rates v2 call for one fallen-back pair queue up every
    // other pair Swap Rates does serve.
    if (await isPairUnsupported()) return fetchViaLegacyProvider()

    const result = await mutex.runExclusive(fetchViaSwapRates)
    if (result === UNSUPPORTED_PAIR) return fetchViaLegacyProvider()
    // The re-probe above runs every time the `:unsupported` flag ages out, and
    // a probe can fail for reasons that have nothing to do with the pair being
    // supported again (5xx, timeout, malformed body). For a pair we have
    // already fallen back once, that answer must not become the tick's result:
    // it would both serve an error for the home market and — via the `:status`
    // write inside `fetchViaSwapRates` — suppress the legacy leg for the whole
    // status TTL. Keep serving legacy until a probe actually succeeds.
    if (result instanceof Error && hasFallenBack) return fetchViaLegacyProvider()
    return result
  }

  return { fetchTicker }
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
