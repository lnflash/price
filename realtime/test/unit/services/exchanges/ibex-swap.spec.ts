import axios from "axios"

import { toPrice, toTimestamp } from "@domain/primitives"
import {
  ExchangeServiceError,
  InvalidExchangeResponseError,
  UnknownExchangeServiceError,
} from "@domain/exchanges"
import { CacheKeys } from "@domain/cache"

import * as LocalCacheServiceImpl from "@services/cache"
import { IbexSwapExchangeService } from "@services/exchanges/ibex-swap"
import * as IbexImpl from "@services/exchanges/ibex"

// Live sandbox response for GET /rates?from=2&to=3 (BTC→USD). BOTH fields are
// in USD-per-BTC: rate = selling BTC (bid side), inverseRate = the other side
// of the same market (ask side) — NOT a reciprocal, each side has its own fee.
// (The USD→BTC direction returns both sides in BTC-per-USD the same way,
// e.g. { rate: 0.00001542, inverseRate: 0.00001563 }.)
const mockSwapRatesBody = {
  rate: 63968.8481,
  inverseRate: 64870.7251,
}

const mockAxiosResponse = {
  data: mockSwapRatesBody,
  status: 200,
}

jest.mock("axios")

jest.mock("ibex-client", () => {
  // minimal stand-in for IbexAuthentication.withAuth: unwraps `.data`,
  // refreshes + retries exactly once when the call throws { status: 401 }
  const withAuth = jest.fn(
    async (apiCall: () => Promise<{ data: unknown }>): Promise<unknown> => {
      try {
        return (await apiCall()).data
      } catch (err) {
        if ((err as { status?: number })?.status === 401) return (await apiCall()).data
        throw err
      }
    },
  )
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      // `ibex` is the generated api-sdk instance; the providers call
      // `.config({ timeout })` on it to cap the sdk's 30s default
      ibex: { config: jest.fn() },
      authentication: {
        withAuth,
        storage: { getAccessToken: jest.fn(async () => "test-token") },
      },
    })),
    IbexUrls: {
      production: { hubUrl: "https://ibexhub-api.poweredbyibex.io" },
      sandbox: { hubUrl: "https://ibexhub-api.sandbox.poweredbyibex.io" },
    },
  }
})

const mockLocalCache = ({
  get = () => Promise.resolve(new Error()),
  set = jest.fn(),
}: {
  get?: <T>(key: string) => Promise<T | Error>
  set?: jest.Mock
} = {}) => {
  jest.spyOn(LocalCacheServiceImpl, "LocalCacheService").mockImplementation(() => ({
    get: get as never,
    getOrSet: jest.fn(),
    set,
    clear: jest.fn(),
  }))
  return { set }
}

// Read-your-writes cache double: the provider's `:unsupported` flag is written
// on one fetch and read on the next, so tests covering that hand-off need a
// store rather than a fixed `get`.
const mockStatefulLocalCache = () => {
  const store = new Map<string, unknown>()
  const set = jest.fn(async ({ key, value }: { key: string; value: unknown }) => {
    store.set(key, value)
    return value
  })
  const get = jest.fn(async (key: string) =>
    store.has(key) ? store.get(key) : new Error("not found"),
  )
  jest.spyOn(LocalCacheServiceImpl, "LocalCacheService").mockImplementation(() => ({
    get: get as never,
    getOrSet: jest.fn(),
    set: set as never,
    clear: jest.fn(),
  }))
  return { store, get, set }
}

describe("IbexSwapExchangeService", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockLocalCache()
  })

  // `clearAllMocks` wipes call records but leaves spy implementations installed,
  // so without this a `jest.spyOn(IbexImpl, ...)` from one test would leak into
  // every test after it.
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("should return a bid/ask ticker from rate and inverseRate", async () => {
    ;(axios.get as jest.Mock).mockResolvedValue(mockAxiosResponse)

    const service = await IbexSwapExchangeService({
      base: "BTC",
      quote: "USD",
      config: { cacheSeconds: 300 },
    })
    if (service instanceof Error) throw service

    const result = await service.fetchTicker()
    expect(axios.get).toHaveBeenCalledWith(
      // hubUrl of whichever environment @config resolves (post-#9 the default
      // without IBEX_ENVIRONMENT is production) — what matters here is the
      // hub host family + /rates path, not the env.
      expect.stringMatching(
        /^https:\/\/ibexhub-api(\.sandbox)?\.poweredbyibex\.io\/rates$/,
      ),
      expect.objectContaining({
        // raw JWT — IBEX rejects a "Bearer " prefix (apiKey-in-header scheme)
        headers: { Authorization: "test-token" },
        params: { from: 2, to: 3 }, // IBEX currency ids for BTC / USD
        timeout: 5000,
      }),
    )
    expect(result).toEqual({
      bid: toPrice(63968.8481),
      ask: toPrice(64870.7251),
      timestamp: toTimestamp(expect.any(Number)),
    })
  })

  it("should keep bid <= ask regardless of which side is larger", async () => {
    ;(axios.get as jest.Mock).mockResolvedValue({
      // pathological direction: rate side above the inverseRate side
      data: { rate: 64870.7251, inverseRate: 63968.8481 },
      status: 200,
    })

    const service = await IbexSwapExchangeService({
      base: "BTC",
      quote: "USD",
      config: {},
    })
    if (service instanceof Error) throw service

    const result = await service.fetchTicker()
    if (result instanceof Error) throw result
    expect(result.bid).toBeLessThanOrEqual(result.ask)
    expect(result.bid).toBeCloseTo(63968.8481)
    expect(result.ask).toBeCloseTo(64870.7251)
  })

  it("should return ExchangeServiceError if currency has no IBEX id", async () => {
    const service = await IbexSwapExchangeService({
      base: "BTC",
      quote: "XXX",
      config: {},
    })
    if (service instanceof Error) throw service

    const result = await service.fetchTicker()
    expect(result).toBeInstanceOf(ExchangeServiceError)
    expect(axios.get).not.toHaveBeenCalled()
  })

  it("should return UnknownExchangeServiceError and cache the status on HTTP error", async () => {
    ;(axios.get as jest.Mock).mockResolvedValue({ data: {}, status: 500 })
    const { set } = mockLocalCache()

    const service = await IbexSwapExchangeService({
      base: "BTC",
      quote: "USD",
      config: {},
    })
    if (service instanceof Error) throw service

    const result = await service.fetchTicker()
    expect(result).toBeInstanceOf(UnknownExchangeServiceError)
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ value: 500 }))
  })

  it("should back off without calling the API if the last request errored", async () => {
    mockLocalCache({
      get: <T>(key: string) =>
        Promise.resolve(key.endsWith(":status") ? (503 as T) : new Error()),
    })

    const service = await IbexSwapExchangeService({
      base: "BTC",
      quote: "USD",
      config: {},
    })
    if (service instanceof Error) throw service

    const result = await service.fetchTicker()
    expect(result).toBeInstanceOf(UnknownExchangeServiceError)
    expect(axios.get).not.toHaveBeenCalled()
  })

  it("should return UnknownExchangeServiceError if the request fails", async () => {
    ;(axios.get as jest.Mock).mockRejectedValue(new Error("timeout of 5000ms exceeded"))

    const service = await IbexSwapExchangeService({
      base: "BTC",
      quote: "USD",
      config: {},
    })
    if (service instanceof Error) throw service

    const result = await service.fetchTicker()
    expect(result).toBeInstanceOf(UnknownExchangeServiceError)
  })

  it("should return InvalidExchangeResponseError if body is malformed", async () => {
    ;(axios.get as jest.Mock).mockResolvedValue({
      data: { rate: "not-a-number" },
      status: 200,
    })

    const service = await IbexSwapExchangeService({
      base: "BTC",
      quote: "USD",
      config: {},
    })
    if (service instanceof Error) throw service

    const result = await service.fetchTicker()
    expect(result).toBeInstanceOf(InvalidExchangeResponseError)
  })

  it("should retry once through withAuth when the API returns 401", async () => {
    ;(axios.get as jest.Mock)
      .mockResolvedValueOnce({ data: {}, status: 401 })
      .mockResolvedValueOnce(mockAxiosResponse)

    const service = await IbexSwapExchangeService({
      base: "BTC",
      quote: "USD",
      config: {},
    })
    if (service instanceof Error) throw service

    const result = await service.fetchTicker()
    expect(axios.get).toHaveBeenCalledTimes(2)
    expect(result).toEqual({
      bid: toPrice(63968.8481),
      ask: toPrice(64870.7251),
      timestamp: toTimestamp(expect.any(Number)),
    })
  })

  it("should return UnknownExchangeServiceError if still 401 after the retry", async () => {
    ;(axios.get as jest.Mock).mockResolvedValue({ data: {}, status: 401 })

    const service = await IbexSwapExchangeService({
      base: "BTC",
      quote: "USD",
      config: {},
    })
    if (service instanceof Error) throw service

    const result = await service.fetchTicker()
    expect(axios.get).toHaveBeenCalledTimes(2)
    expect(result).toBeInstanceOf(UnknownExchangeServiceError)
  })

  it("should use cached rates without calling the API", async () => {
    mockLocalCache({
      get: <T>(key: string) =>
        Promise.resolve(
          key.endsWith(":status") || key.endsWith(":unsupported")
            ? (new Error() as unknown as T)
            : ({ rate: 63968.8481, inverseRate: 64870.7251 } as T),
        ),
    })

    const service = await IbexSwapExchangeService({
      base: "BTC",
      quote: "USD",
      config: { cacheSeconds: 300 },
    })
    if (service instanceof Error) throw service

    const result = await service.fetchTicker()
    expect(axios.get).not.toHaveBeenCalled()
    expect(result).toEqual({
      bid: toPrice(63968.8481),
      ask: toPrice(64870.7251),
      timestamp: toTimestamp(expect.any(Number)),
    })
  })

  it("should cache fetched rates for cacheSeconds", async () => {
    ;(axios.get as jest.Mock).mockResolvedValue(mockAxiosResponse)
    const { set } = mockLocalCache()

    const service = await IbexSwapExchangeService({
      base: "BTC",
      quote: "USD",
      config: { cacheSeconds: 300 },
    })
    if (service instanceof Error) throw service

    await service.fetchTicker()
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        value: { rate: 63968.8481, inverseRate: 64870.7251 },
        ttlSecs: 300,
      }),
    )
  })
  describe("currencies Swap Rates does not support", () => {
    // Verified live against sandbox: GET /rates?from=2&to=28 (JMD) answers
    // 400 {"error":"to currency is not supported"} — likewise HTG and CAD.
    // JMD is the home market, so this pair must still price off IBEX rather
    // than falling through to a mid-market FX provider.
    const unsupported = {
      status: 400,
      data: { error: "to currency is not supported" },
    }

    const legacyTicker = {
      bid: toPrice(9_900_000),
      ask: toPrice(9_950_000),
      timestamp: toTimestamp(1_700_000_000_000),
    }

    const unsupportedKey = `${CacheKeys.CurrentTicker}:IbexSwap:BTC:JMD:unsupported`
    const statusKey = `${CacheKeys.CurrentTicker}:IbexSwap:BTC:JMD:status`

    it("serves the pair from the legacy Ibex provider instead of erroring", async () => {
      ;(axios.get as jest.Mock).mockResolvedValue(unsupported)
      const legacyFetchTicker = jest.fn(async () => legacyTicker)
      jest
        .spyOn(IbexImpl, "IbexExchangeService")
        .mockResolvedValue({ fetchTicker: legacyFetchTicker })

      const service = await IbexSwapExchangeService({
        base: "BTC",
        quote: "JMD",
        config: { cacheSeconds: 300 },
      })
      if (service instanceof Error) throw service

      await expect(service.fetchTicker()).resolves.toEqual(legacyTicker)
      expect(legacyFetchTicker).toHaveBeenCalledTimes(1)
    })

    it("stops calling Swap Rates for that pair once the fallback is established", async () => {
      mockStatefulLocalCache()
      ;(axios.get as jest.Mock).mockResolvedValue(unsupported)
      const legacyFetchTicker = jest.fn(async () => legacyTicker)
      const legacyFactory = jest
        .spyOn(IbexImpl, "IbexExchangeService")
        .mockResolvedValue({ fetchTicker: legacyFetchTicker })

      const service = await IbexSwapExchangeService({
        base: "BTC",
        quote: "JMD",
        config: { cacheSeconds: 300 },
      })
      if (service instanceof Error) throw service

      await service.fetchTicker()
      await service.fetchTicker()
      await service.fetchTicker()

      // one probe, then straight to the legacy provider — and the legacy
      // service is built once, not per fetch
      expect((axios.get as jest.Mock).mock.calls).toHaveLength(1)
      expect(legacyFactory).toHaveBeenCalledTimes(1)
      expect(legacyFetchTicker).toHaveBeenCalledTimes(3)
    })

    it("marks the pair unsupported with a TTL rather than for the pod's lifetime", async () => {
      const { set } = mockStatefulLocalCache()
      ;(axios.get as jest.Mock).mockResolvedValue(unsupported)
      jest
        .spyOn(IbexImpl, "IbexExchangeService")
        .mockResolvedValue({ fetchTicker: jest.fn(async () => legacyTicker) })

      const service = await IbexSwapExchangeService({
        base: "BTC",
        quote: "JMD",
        config: { cacheSeconds: 300, unsupportedTtlSeconds: 1800 },
      })
      if (service instanceof Error) throw service

      await service.fetchTicker()
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({ key: unsupportedKey, value: 1, ttlSecs: 1800 }),
      )
    })

    it("re-probes Swap Rates once the unsupported flag expires", async () => {
      const { store } = mockStatefulLocalCache()
      ;(axios.get as jest.Mock).mockResolvedValue(unsupported)
      jest
        .spyOn(IbexImpl, "IbexExchangeService")
        .mockResolvedValue({ fetchTicker: jest.fn(async () => legacyTicker) })

      const service = await IbexSwapExchangeService({
        base: "BTC",
        quote: "JMD",
        config: { cacheSeconds: 300 },
      })
      if (service instanceof Error) throw service

      await expect(service.fetchTicker()).resolves.toEqual(legacyTicker)

      // IBEX adds the pair; the flag ages out and Swap Rates starts answering
      store.delete(unsupportedKey)
      ;(axios.get as jest.Mock).mockClear()
      ;(axios.get as jest.Mock).mockResolvedValue(mockAxiosResponse)

      const result = await service.fetchTicker()
      expect(axios.get).toHaveBeenCalledTimes(1)
      expect(result).toEqual({
        bid: toPrice(63968.8481),
        ask: toPrice(64870.7251),
        timestamp: toTimestamp(expect.any(Number)),
      })
    })

    it("keeps serving the legacy provider when the post-expiry re-probe fails", async () => {
      // The TTL guarantees the `:unsupported` flag dies every hour, so the
      // re-probe is a recurring event, not an edge case. If that probe answers
      // anything other than a clean 400-unsupported it is *not* evidence the
      // pair is priceable again — and worse, it writes `:status`, which would
      // short-circuit every later tick into the backoff error. JMD must stay
      // on IBEX rates across the whole episode.
      const { store } = mockStatefulLocalCache()
      ;(axios.get as jest.Mock).mockResolvedValue(unsupported)
      const legacyFetchTicker = jest.fn(async () => legacyTicker)
      jest
        .spyOn(IbexImpl, "IbexExchangeService")
        .mockResolvedValue({ fetchTicker: legacyFetchTicker })

      const service = await IbexSwapExchangeService({
        base: "BTC",
        quote: "JMD",
        config: { cacheSeconds: 300 },
      })
      if (service instanceof Error) throw service

      await expect(service.fetchTicker()).resolves.toEqual(legacyTicker)

      // the flag ages out; the re-probe hits a transient 500
      store.delete(unsupportedKey)
      ;(axios.get as jest.Mock).mockClear()
      ;(axios.get as jest.Mock).mockResolvedValue({ data: {}, status: 500 })

      await expect(service.fetchTicker()).resolves.toEqual(legacyTicker)
      // ...and the ticks after it, which the poisoned `:status` now gates
      await expect(service.fetchTicker()).resolves.toEqual(legacyTicker)
      await expect(service.fetchTicker()).resolves.toEqual(legacyTicker)

      expect(axios.get).toHaveBeenCalledTimes(1)
      expect(legacyFetchTicker).toHaveBeenCalledTimes(4)
    })

    it("keeps serving the legacy provider even when the error backoff is cached", async () => {
      const { store } = mockStatefulLocalCache()
      ;(axios.get as jest.Mock).mockResolvedValue(unsupported)
      const legacyFetchTicker = jest.fn(async () => legacyTicker)
      jest
        .spyOn(IbexImpl, "IbexExchangeService")
        .mockResolvedValue({ fetchTicker: legacyFetchTicker })

      const service = await IbexSwapExchangeService({
        base: "BTC",
        quote: "JMD",
        config: { cacheSeconds: 300 },
      })
      if (service instanceof Error) throw service

      await expect(service.fetchTicker()).resolves.toEqual(legacyTicker)

      // one transient 5xx poisons the status key for the whole TTL — the home
      // market must not drop off IBEX rates because of it
      store.set(statusKey, 503)
      ;(axios.get as jest.Mock).mockClear()

      await expect(service.fetchTicker()).resolves.toEqual(legacyTicker)
      expect(axios.get).not.toHaveBeenCalled()
    })

    it("backs off the probe when the legacy provider is unavailable too", async () => {
      const { store, set } = mockStatefulLocalCache()
      ;(axios.get as jest.Mock).mockResolvedValue(unsupported)
      jest
        .spyOn(IbexImpl, "IbexExchangeService")
        .mockResolvedValue(new ExchangeServiceError("legacy unavailable"))

      const service = await IbexSwapExchangeService({
        base: "BTC",
        quote: "JMD",
        config: { cacheSeconds: 300 },
      })
      if (service instanceof Error) throw service

      await service.fetchTicker()
      await service.fetchTicker()
      await service.fetchTicker()

      // both legs down must not mean an uncapped probe on every 15s tick
      expect((axios.get as jest.Mock).mock.calls).toHaveLength(1)
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({ key: statusKey, value: 503, ttlSecs: 300 }),
      )

      // and the backoff still holds once the unsupported flag ages out — the
      // caller sees the legacy provider's own error, not a probe result
      store.delete(unsupportedKey)
      ;(axios.get as jest.Mock).mockClear()

      const result = await service.fetchTicker()
      expect(result).toBeInstanceOf(ExchangeServiceError)
      expect(result).not.toBeInstanceOf(UnknownExchangeServiceError)
      expect((result as Error).message).toBe("legacy unavailable")
      expect(axios.get).not.toHaveBeenCalled()
    })

    it("does not park the shared mutex on the legacy leg", async () => {
      // `mutex` is module-scoped — one lock for every base/quote pair. The
      // legacy leg is not capped by this provider's `timeout`, so running it
      // inside that lock would let a slow Rates v2 call for JMD stall the
      // ticker of every other pair Swap Rates does serve.
      mockStatefulLocalCache()
      ;(axios.get as jest.Mock).mockImplementation(
        async (_url: string, opts: { params: { to: number } }) =>
          opts.params.to === 28 ? unsupported : mockAxiosResponse, // 28 = JMD
      )

      let releaseLegacy: () => void = () => undefined
      const legacyInFlight = new Promise<void>((resolve) => {
        releaseLegacy = resolve
      })
      jest.spyOn(IbexImpl, "IbexExchangeService").mockResolvedValue({
        fetchTicker: jest.fn(async () => {
          await legacyInFlight
          return legacyTicker
        }),
      })

      const jmd = await IbexSwapExchangeService({ base: "BTC", quote: "JMD", config: {} })
      const usd = await IbexSwapExchangeService({ base: "BTC", quote: "USD", config: {} })
      if (jmd instanceof Error) throw jmd
      if (usd instanceof Error) throw usd

      const jmdInFlight = jmd.fetchTicker() // parks on the slow legacy provider
      await new Promise((resolve) => setImmediate(resolve))

      const blocked = Symbol("blocked")
      const usdResult = await Promise.race([
        usd.fetchTicker(),
        new Promise((resolve) => setTimeout(() => resolve(blocked), 50)),
      ])
      expect(usdResult).not.toBe(blocked)
      expect(usdResult).toEqual({
        bid: toPrice(63968.8481),
        ask: toPrice(64870.7251),
        timestamp: toTimestamp(expect.any(Number)),
      })

      releaseLegacy()
      await expect(jmdInFlight).resolves.toEqual(legacyTicker)
    })

    it("keeps erroring for a 400 that is not an unsupported-currency answer", async () => {
      ;(axios.get as jest.Mock).mockResolvedValue({
        status: 400,
        data: { error: "malformed request" },
      })
      const legacyFactory = jest.spyOn(IbexImpl, "IbexExchangeService")

      const service = await IbexSwapExchangeService({
        base: "BTC",
        quote: "USD",
        config: { cacheSeconds: 300 },
      })
      if (service instanceof Error) throw service

      const result = await service.fetchTicker()
      expect(result).toBeInstanceOf(UnknownExchangeServiceError)
      expect(legacyFactory).not.toHaveBeenCalled()
    })

    it("keeps erroring for a 400 that merely contains 'not supported'", async () => {
      // e.g. an entitlement/account-scope answer — diverting a pair to legacy
      // rates is permanent for the flag's TTL, so the match has to be narrow
      ;(axios.get as jest.Mock).mockResolvedValue({
        status: 400,
        data: { error: "swaps are not supported for this account" },
      })
      const { set } = mockLocalCache()
      const legacyFactory = jest.spyOn(IbexImpl, "IbexExchangeService")

      const service = await IbexSwapExchangeService({
        base: "BTC",
        quote: "USD",
        config: { cacheSeconds: 300 },
      })
      if (service instanceof Error) throw service

      const result = await service.fetchTicker()
      expect(result).toBeInstanceOf(UnknownExchangeServiceError)
      expect(legacyFactory).not.toHaveBeenCalled()
      expect(set).not.toHaveBeenCalledWith(
        expect.objectContaining({ key: expect.stringMatching(/:unsupported$/) }),
      )
    })

    it("surfaces the legacy provider's error rather than masking it", async () => {
      ;(axios.get as jest.Mock).mockResolvedValue(unsupported)
      jest
        .spyOn(IbexImpl, "IbexExchangeService")
        .mockResolvedValue(new ExchangeServiceError("legacy unavailable"))

      const service = await IbexSwapExchangeService({
        base: "BTC",
        quote: "HTG",
        config: { cacheSeconds: 300 },
      })
      if (service instanceof Error) throw service

      const result = await service.fetchTicker()
      // not just "some ExchangeServiceError" — the no-fallback path returns
      // UnknownExchangeServiceError, which extends it and would pass that
      expect(result).not.toBeInstanceOf(UnknownExchangeServiceError)
      expect(result).toBeInstanceOf(ExchangeServiceError)
      expect((result as Error).message).toBe("legacy unavailable")
    })
  })
})
