import { Mutex } from "async-mutex"

import {
  InvalidTickerError,
  ExchangeServiceError,
  UnknownExchangeServiceError,
  InvalidExchangeConfigError,
} from "@domain/exchanges"
import { toPrice, toSeconds, toTimestamp } from "@domain/primitives"
import { LocalCacheService } from "@services/cache"
import { CacheKeys } from "@domain/cache"
import { baseLogger } from "@services/logger"
import IbexClient from "ibex-client"
import { ApiError, AuthenticationError } from "ibex-client/dist/errors"
import { IBEX } from "@config"

import { AuthCache } from "./cache"

const mutex = new Mutex()

// The Rates v2 cap, shared by every caller that builds this provider:
// `createIbex` in the exchange factory and the legacy fallback leg in
// `../ibex-swap`. One constant so tightening it cannot leave a path behind —
// the `default.yaml` Ibex entry mirrors it and says so, and a test asserts the
// two match.
//
// What `Ibex.ibex.config({ timeout })` actually bounds: the **Rates v2
// request** only. `withAuth` runs an OAuth token request first, and that is a
// bare global `fetch` with no signal and no relation to the sdk core
// (ibex-client/dist/authentication/index.js:28) — so on a cold token cache or
// an expiry refresh, a stalled auth host is not bounded by this value at all.
// That leg is bounded instead by racing `fetchTicker` against this same number
// inside the mutex (see `fetchTickerCapped` below), which is what keeps a hung
// OAuth call from parking every pair on the module-scoped lock.
//
// Why not the 5000 every other provider defaults to: until now this provider
// dropped `timeout` on the floor, and — contrary to the sdk's own JSDoc
// ("Override the default `fetch` request timeout of 30 seconds") — `api`'s core
// only installs an AbortController `if (this.config.timeout)`, which starts as
// `{}` and which `ibex-client` never sets. So Rates v2 in prod today runs with
// *no* client-side abort at all: bounded only by undici's ~300s defaults, and
// doubled by withAuth's single 401 retry. The step this PR takes is therefore
// unbounded -> bounded, not 30s -> something tighter, and anything below the
// documented 30s could start aborting calls that today wait and succeed —
// dropping JMD onto a mid-market FX provider, the exact regression this PR
// exists to prevent. 30000 is the value the code was believed to enforce, so
// the first rollout changes nothing observable. Measure Rates v2's latency
// distribution on that rollout, then tighten with data in hand (a test pins
// this number so the change is deliberate).
export const IBEX_RATES_V2_DEFAULT_TIMEOUT_MS = 30000

// Only reached when a caller builds this service with no `timeout` at all, or
// with one that cannot be used (see below). Both real callers pass
// IBEX_RATES_V2_DEFAULT_TIMEOUT_MS.
const UNCONFIGURED_TIMEOUT_MS = 5000

export const IbexExchangeService = async ({
  base,
  quote,
  config,
}: IbexExchangeServiceArgs): Promise<IExchangeService | ExchangeServiceError> => {
  const cacheSeconds = config?.cacheSeconds || 180
  // Fail *closed* on an unusable value. A YAML `timeout: 10s` — or anything
  // else non-numeric a helm values file can hand through — parses to NaN, and
  // the previous `if (timeout > 0)` guard turned that into "configure nothing",
  // i.e. silently restored the uncapped pre-PR behaviour this change exists to
  // remove, with nothing logged.
  const configuredTimeout = Number(config?.timeout)
  const timeoutIsUsable = Number.isFinite(configuredTimeout) && configuredTimeout > 0
  const timeout = timeoutIsUsable ? configuredTimeout : UNCONFIGURED_TIMEOUT_MS
  if (config?.timeout !== undefined && !timeoutIsUsable) {
    baseLogger.warn(
      { base, quote, configuredTimeout: config.timeout, timeout },
      "Ibex: unusable `timeout` in exchange config, using the default cap instead",
    )
  }

  if (!IBEX.clientId || !IBEX.clientSecret) {
    return new InvalidExchangeConfigError("IBEX client credentials are required")
  }

  const Ibex = new IbexClient(
    {
      clientId: IBEX.clientId,
      clientSecret: IBEX.clientSecret,
      environment: IBEX.environment,
    },
    AuthCache,
  )

  // The sdk installs its abort controller only when a timeout is configured,
  // and nothing configured one — so every Rates v2 call has been uncapped,
  // and withAuth's single 401 retry doubles that. The exchange factory has
  // always passed a `timeout`; this provider ignored it until now. Honour it,
  // unconditionally. This matters beyond this provider: `ibex-swap` serves the
  // pairs Swap Rates does not support (JMD, HTG, CAD) through here, on the
  // polling loop's 15s tick.
  //
  // This bounds the Rates v2 request and nothing else — the token request
  // inside withAuth is a bare `fetch` the sdk core never sees. `fetchTickerCapped`
  // below bounds the rest.
  //
  // Rollout note: this is a live behaviour change for the `ibex` provider,
  // which prod still runs — it goes from no client-side cap to whatever is
  // configured. See IBEX_RATES_V2_DEFAULT_TIMEOUT_MS above before tightening.
  Ibex.ibex.config({ timeout })

  const cacheKey = `${CacheKeys.CurrentTicker}:Ibex:${base}:${quote}`
  const cacheTtlSecs = Number(cacheSeconds)
  const cacheKeyStatus = `${cacheKey}:status`

  const getCachedRates = async (): Promise<IbexRates | undefined> => {
    const cachedTickers = await LocalCacheService().get<IbexRates>(cacheKey)
    if (cachedTickers instanceof Error) return undefined
    return cachedTickers
  }

  const getLastRequestStatus = async (): Promise<number> => {
    const status = await LocalCacheService().get<number>(cacheKeyStatus)
    if (status instanceof Error) return 0
    return status
  }

  const fetchTicker = async (): Promise<Ticker | ServiceError> => {
    // We cant use response.data.response.date because
    // CurrencyBeacon does not behave like a bitcoin exchange
    const timestamp = new Date().getTime()

    try {
      const cachedRates = await getCachedRates()
      if (cachedRates) return tickerFromRaw({ rate: cachedRates[quote], timestamp })

      // avoid cloudflare ban if apiKey is no longer valid
      const lastCachedStatus = await getLastRequestStatus()
      if (lastCachedStatus >= 400)
        return new UnknownExchangeServiceError(
          `Previous request failed. Error ${lastCachedStatus}`,
        )

      const primary_currency_id = getIbexId(base)
      const secondary_currency_id = getIbexId(quote)
      if (primary_currency_id === undefined)
        return new ExchangeServiceError(`Ibex Id not found for currency ${base}`)
      if (secondary_currency_id === undefined)
        return new ExchangeServiceError(`Ibex Id not found for currency ${quote}`)
      const ibexResp = await Ibex.getRate({
        primary_currency_id: primary_currency_id,
        secondary_currency_id: secondary_currency_id,
      })
      console.log(`ibexResp = ${JSON.stringify(ibexResp)}`)

      if (ibexResp instanceof ApiError) {
        await LocalCacheService().set<number>({
          key: cacheKeyStatus,
          value: 0,
          ttlSecs: toSeconds(cacheTtlSecs > 0 ? cacheTtlSecs : 300),
        })
        return new UnknownExchangeServiceError(ibexResp.message)
      }
      if (ibexResp instanceof AuthenticationError)
        return new ExchangeServiceError(ibexResp.message)

      if (!ibexResp.rate)
        return new UnknownExchangeServiceError("Invalid Response. No rate found.")
      await LocalCacheService().set<IbexRates>({
        key: cacheKey,
        value: { [quote]: ibexResp.rate },
        ttlSecs: toSeconds(cacheTtlSecs > 0 ? cacheTtlSecs : 300),
      })

      // return tickerFromRaw({ rate: rates[quote], timestamp })
      return tickerFromRaw({
        rate: ibexResp.rate,
        timestamp: ibexResp.updatedAtUnix || new Date().getTime(),
      })
    } catch (error) {
      baseLogger.error({ error }, "Ibex unknown error")
      return new UnknownExchangeServiceError(error.message || error)
    }
  }

  // Bound the *mutex hold*, not just the sdk call. `Ibex.ibex.config({ timeout })`
  // reaches the Rates v2 request only; the OAuth token request `withAuth` runs
  // first is a bare global `fetch` with no signal
  // (ibex-client/dist/authentication/index.js:28), so a stalled
  // `auth.hub.poweredbyibex.io` would hang on undici's ~300s defaults while
  // holding this lock. The lock is module-scoped — one for every base/quote
  // pair — and `ibex-swap` routes its legacy leg through here, so an unbounded
  // hold stalls the ticker of every pair either provider serves. Racing here
  // releases the lock on schedule even though there is nothing to abort a bare
  // `fetch` with.
  //
  // The losing branch keeps running: it cannot reject (`fetchTicker` catches
  // everything and returns an error value), and it only ever writes this pair's
  // own cache keys. Note this also caps withAuth's 401 retry into the same
  // budget rather than letting it double — the point is a bounded worst case.
  const fetchTickerCapped = async (): Promise<Ticker | ServiceError> => {
    let capTimer: ReturnType<typeof setTimeout> | undefined
    const cap = new Promise<ServiceError>((resolve) => {
      capTimer = setTimeout(() => {
        baseLogger.warn(
          { base, quote, timeout },
          "Ibex: request exceeded the configured timeout, releasing the shared lock",
        )
        resolve(new UnknownExchangeServiceError(`Ibex request exceeded ${timeout}ms`))
      }, timeout)
    })

    try {
      return await Promise.race([fetchTicker(), cap])
    } finally {
      if (capTimer !== undefined) clearTimeout(capTimer)
    }
  }

  return {
    fetchTicker: () => mutex.runExclusive(fetchTickerCapped),
  }
}

const tickerFromRaw = ({
  rate,
  timestamp,
}: {
  rate: number
  timestamp: number
}): Ticker | InvalidTickerError => {
  if (rate > 0 && timestamp > 0) {
    return {
      bid: toPrice(rate),
      ask: toPrice(rate),
      timestamp: toTimestamp(timestamp),
    }
  }

  return new InvalidTickerError()
}

export const getIbexId = (name: string) =>
  ibexCurrencies.find((el) => el.name === name)?.id
// prettier-ignore
const ibexCurrencies = [
      {
          "id": 0,
          "name": "MSAT",
          "isFiat": false,
          "symbol": "MSAT",
          "accountEnabled": true
      },
      {
          "id": 1,
          "name": "SATS",
          "isFiat": false,
          "symbol": "SATs",
          "accountEnabled": false
      },
      {
          "id": 2,
          "name": "BTC",
          "isFiat": false,
          "symbol": "₿",
          "accountEnabled": false
      },
      {
          "id": 3,
          "name": "USD",
          "isFiat": true,
          "symbol": "$",
          "accountEnabled": true
      },
      {
          "id": 4,
          "name": "GTQ",
          "isFiat": true,
          "symbol": "Q",
          "accountEnabled": true
      },
      {
          "id": 5,
          "name": "MXN",
          "isFiat": true,
          "symbol": "MX$",
          "accountEnabled": true
      },
      {
          "id": 6,
          "name": "PLN",
          "isFiat": true,
          "symbol": "zł",
          "accountEnabled": false
      },
      {
          "id": 7,
          "name": "HNL",
          "isFiat": true,
          "symbol": "L",
          "accountEnabled": false
      },
      {
          "id": 9,
          "name": "ARS",
          "isFiat": true,
          "symbol": "ARS$",
          "accountEnabled": false
      },
      {
          "id": 10,
          "name": "ARS_PA",
          "isFiat": true,
          "symbol": "ARS$",
          "accountEnabled": false
      },
      {
          "id": 11,
          "name": "BRL",
          "isFiat": true,
          "symbol": "R$",
          "accountEnabled": false
      },
      {
          "id": 12,
          "name": "KES",
          "isFiat": true,
          "symbol": "KSh",
          "accountEnabled": false
      },
      {
          "id": 13,
          "name": "CHF",
          "isFiat": true,
          "symbol": "CHf",
          "accountEnabled": false
      },
      {
          "id": 14,
          "name": "COP",
          "isFiat": true,
          "symbol": "COL$",
          "accountEnabled": false
      },
      {
          "id": 15,
          "name": "NGN",
          "isFiat": true,
          "symbol": "₦",
          "accountEnabled": false
      },
      {
          "id": 16,
          "name": "SEK",
          "isFiat": true,
          "symbol": "kr",
          "accountEnabled": false
      },
      {
          "id": 17,
          "name": "AUD",
          "isFiat": true,
          "symbol": "AU $",
          "accountEnabled": false
      },
      {
          "id": 18,
          "name": "CAD",
          "isFiat": true,
          "symbol": "CA $",
          "accountEnabled": false
      },
      {
          "id": 19,
          "name": "DKK",
          "isFiat": true,
          "symbol": "Kr.",
          "accountEnabled": false
      },
      {
          "id": 20,
          "name": "HTG",
          "isFiat": true,
          "symbol": "G",
          "accountEnabled": true
      },
      {
          "id": 24,
          "name": "ZAR",
          "isFiat": true,
          "symbol": "R",
          "accountEnabled": false
      },
      {
          "id": 25,
          "name": "PHP",
          "isFiat": true,
          "symbol": "₱",
          "accountEnabled": false
      },
      {
          "id": 22,
          "name": "PEN",
          "isFiat": true,
          "symbol": "S/",
          "accountEnabled": false
      },
      {
          "id": 23,
          "name": "MKD",
          "isFiat": true,
          "symbol": "ден",
          "accountEnabled": false
      },
      {
          "id": 26,
          "name": "SRD",
          "isFiat": true,
          "symbol": "Sur$",
          "accountEnabled": false
      },
      {
          "id": 27,
          "name": "NOK",
          "isFiat": true,
          "symbol": "NKr",
          "accountEnabled": false
      },
      {
          "id": 28,
          "name": "JMD",
          "isFiat": true,
          "symbol": "J$",
          "accountEnabled": false
      },
      {
          "id": 21,
          "name": "GBP",
          "isFiat": true,
          "symbol": "£",
          "accountEnabled": true
      },
      {
          "id": 8,
          "name": "EUR",
          "isFiat": true,
          "symbol": "€",
          "accountEnabled": true
      },
      {
          "id": 29,
          "name": "USDT",
          "isFiat": false,
          "symbol": "USD₮",
          "accountEnabled": true
      }
]
