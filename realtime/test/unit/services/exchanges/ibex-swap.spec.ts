import axios from "axios"

import { toPrice, toTimestamp } from "@domain/primitives"
import {
  ExchangeServiceError,
  InvalidExchangeResponseError,
  UnknownExchangeServiceError,
} from "@domain/exchanges"
import { CacheKeys } from "@domain/cache"

import * as LocalCacheServiceImpl from "@services/cache"
import { baseLogger } from "@services/logger"
import {
  DEFAULT_SWAP_RATES_TIMEOUT_MS,
  IbexSwapExchangeService,
} from "@services/exchanges/ibex-swap"
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

// The legacy-fallback counter is memoised on first use inside the provider
// (module scope), so it survives `clearAllMocks` — hence a single `add` spy
// reached lazily rather than a fresh counter per test, and a plain array for
// the instrument names, which nothing clears.
const mockCounterAdd = jest.fn()
const mockCreatedCounterNames: string[] = []
jest.mock("@opentelemetry/api", () => {
  const actual = jest.requireActual("@opentelemetry/api")
  return {
    ...actual,
    metrics: {
      ...actual.metrics,
      getMeter: () => ({
        createCounter: (name: string) => {
          mockCreatedCounterNames.push(name)
          return { add: (...args: unknown[]) => mockCounterAdd(...args) }
        },
      }),
    },
  }
})

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

  // Same failure mode as `../ibex`, and worse here: a helm values `timeout: 10s`
  // parses to NaN, axios reads `timeout` with a plain truthiness check
  // (`if (own('timeout'))`), and NaN installs no cap at all. This probe runs
  // inside the provider's *module-scoped* mutex, so one uncapped hung request
  // parks the ticker of every pair this provider serves for undici's ~300s.
  it.each([
    ["a non-numeric string", "10s"],
    ["an empty string", ""],
    ["zero", 0],
    ["a negative number", -1],
  ])(
    "still caps the Swap Rates probe when the configured timeout is %s",
    async (_label: string, value: string | number) => {
      ;(axios.get as jest.Mock).mockResolvedValue(mockAxiosResponse)
      const warn = jest.spyOn(baseLogger, "warn").mockImplementation(() => undefined)

      const service = await IbexSwapExchangeService({
        base: "BTC",
        quote: "USD",
        config: { cacheSeconds: 300, timeout: value },
      })
      if (service instanceof Error) throw service

      await service.fetchTicker()
      expect(axios.get).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ timeout: DEFAULT_SWAP_RATES_TIMEOUT_MS }),
      )
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          configuredTimeout: value,
          timeout: DEFAULT_SWAP_RATES_TIMEOUT_MS,
        }),
        expect.stringContaining("unusable `timeout`"),
      )
    },
  )

  it("releases the shared mutex when a probe outlives the configured timeout", async () => {
    // `timeout` is handed to axios, which bounds GET /rates — but withAuth runs
    // an OAuth token request first, and that is a bare global `fetch` with no
    // signal (ibex-client/dist/authentication/index.js:28). `mutex` is
    // module-scoped, so an unbounded hold parks the ticker of every pair this
    // provider serves for undici's ~300s.
    const warn = jest.spyOn(baseLogger, "warn").mockImplementation(() => undefined)
    ;(axios.get as jest.Mock).mockImplementation(
      async (_url: string, opts: { params: { to: number } }) =>
        opts.params.to === 28 // JMD — stands in for a parked auth call
          ? new Promise(() => undefined)
          : mockAxiosResponse,
    )

    const jmd = await IbexSwapExchangeService({
      base: "BTC",
      quote: "JMD",
      config: { timeout: 50 },
    })
    const usd = await IbexSwapExchangeService({
      base: "BTC",
      quote: "USD",
      config: { timeout: 50 },
    })
    if (jmd instanceof Error) throw jmd
    if (usd instanceof Error) throw usd

    const jmdInFlight = jmd.fetchTicker() // takes the lock and parks
    const usdInFlight = usd.fetchTicker() // queued behind it

    const blocked = Symbol("blocked")
    const usdResult = await Promise.race([
      usdInFlight,
      new Promise((resolve) => setTimeout(() => resolve(blocked), 2000)),
    ])
    expect(usdResult).not.toBe(blocked)
    expect(usdResult).toEqual({
      bid: toPrice(63968.8481),
      ask: toPrice(64870.7251),
      timestamp: toTimestamp(expect.any(Number)),
    })

    await expect(jmdInFlight).resolves.toBeInstanceOf(UnknownExchangeServiceError)
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ base: "BTC", quote: "JMD", timeout: 50 }),
      expect.stringContaining("releasing the shared lock"),
    )
  })

  it("uses the configured Swap Rates timeout when it is usable, without warning", async () => {
    ;(axios.get as jest.Mock).mockResolvedValue(mockAxiosResponse)
    const warn = jest.spyOn(baseLogger, "warn").mockImplementation(() => undefined)

    const service = await IbexSwapExchangeService({
      base: "BTC",
      quote: "USD",
      config: { cacheSeconds: 300, timeout: 7000 },
    })
    if (service instanceof Error) throw service

    await service.fetchTicker()
    expect(axios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: 7000 }),
    )
    expect(warn).not.toHaveBeenCalled()
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

    const ratesKey = `${CacheKeys.CurrentTicker}:IbexSwap:BTC:JMD`
    const unsupportedKey = `${ratesKey}:unsupported`
    const statusKey = `${ratesKey}:status`

    const swapRatesTicker = {
      bid: toPrice(63968.8481),
      ask: toPrice(64870.7251),
      timestamp: toTimestamp(expect.any(Number)),
    }

    it("gives the legacy leg the shared Rates v2 timeout, not the probe's", async () => {
      // createIbexSwap defaults `timeout` to 5s for GET /rates, but Rates v2
      // deliberately ships looser — forwarding this probe's config verbatim
      // would run the JMD fallback, the whole point of this provider, at the
      // tighter cap the legacy provider was explicitly kept away from. Asserted
      // against the exported constant rather than a literal so this leg cannot
      // drift out of step with `createIbex` when Rates v2 is tightened.
      ;(axios.get as jest.Mock).mockResolvedValue(unsupported)
      const legacyFactory = jest
        .spyOn(IbexImpl, "IbexExchangeService")
        .mockResolvedValue({ fetchTicker: jest.fn(async () => legacyTicker) })

      const service = await IbexSwapExchangeService({
        base: "BTC",
        quote: "JMD",
        config: { cacheSeconds: 300, timeout: 5000 },
      })
      if (service instanceof Error) throw service
      await service.fetchTicker()

      expect(legacyFactory).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            timeout: IbexImpl.IBEX_RATES_V2_DEFAULT_TIMEOUT_MS,
          }),
        }),
      )
    })

    it("honours an explicit legacyTimeout override", async () => {
      ;(axios.get as jest.Mock).mockResolvedValue(unsupported)
      const legacyFactory = jest
        .spyOn(IbexImpl, "IbexExchangeService")
        .mockResolvedValue({ fetchTicker: jest.fn(async () => legacyTicker) })

      const service = await IbexSwapExchangeService({
        base: "BTC",
        quote: "JMD",
        config: { cacheSeconds: 300, timeout: 5000, legacyTimeout: 20000 },
      })
      if (service instanceof Error) throw service
      await service.fetchTicker()

      expect(legacyFactory).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ timeout: 20000 }),
        }),
      )
    })

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

    it("stops treating the pair as fallen back once a probe succeeds", async () => {
      // The flag that keeps a fallen-back pair on legacy rates when a probe
      // fails must not outlive the condition it names. IBEX adds JMD to Swap
      // Rates, the `:unsupported` entry ages out, the probe succeeds — from
      // then on this is a normal Swap Rates pair, and the next transient 500
      // has to surface as an error. Left set, the flag would instead serve a
      // legacy MID-MARKET ticker (bid == ask) under the IbexSwap name, with no
      // log, for the rest of the process's life — on a pair Swap Rates can
      // price. That is the display-vs-settlement divergence this provider
      // exists to close, reintroduced from the other side.
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

      // IBEX adds the pair: the flag ages out and the re-probe succeeds
      store.delete(unsupportedKey)
      ;(axios.get as jest.Mock).mockResolvedValue(mockAxiosResponse)
      await expect(service.fetchTicker()).resolves.toEqual(swapRatesTicker)

      // ...then the swap cache expires and the next probe hits one transient
      // 500. The caller must see that error, not a legacy ticker.
      store.delete(ratesKey)
      ;(axios.get as jest.Mock).mockResolvedValue({ data: {}, status: 500 })

      const result = await service.fetchTicker()
      expect(result).toBeInstanceOf(UnknownExchangeServiceError)
      expect(legacyFetchTicker).toHaveBeenCalledTimes(1) // the original fallback only
    })

    it("logs entering and leaving the fallback, once per episode", async () => {
      // `refreshRealtimeData` records the price under exchangeName "IbexSwap"
      // whichever leg produced it, so the logs are the only thing telling a
      // responder that the home market is off executable rates. One `warn`
      // level and one `fallback` field have to bound the whole episode —
      // without repeating a line on every 15s tick.
      const { store } = mockStatefulLocalCache()
      const warn = jest.spyOn(baseLogger, "warn").mockImplementation(() => undefined)
      const fallbackCalls = () =>
        (warn.mock.calls as unknown as Array<[Record<string, unknown>, string]>).filter(
          ([fields]) => fields?.fallback === true,
        )
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

      await service.fetchTicker()
      await service.fetchTicker()
      await service.fetchTicker()

      // the unsupported answer itself, plus the switch to serving legacy —
      // then silence, not one line per tick
      expect(fallbackCalls()).toHaveLength(2)
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          base: "BTC",
          quote: "JMD",
          fallback: true,
          reason: "pair-unsupported",
        }),
        expect.any(String),
      )

      // and the recovery closes the episode under the same field
      store.delete(unsupportedKey)
      ;(axios.get as jest.Mock).mockResolvedValue(mockAxiosResponse)
      await expect(service.fetchTicker()).resolves.toEqual(swapRatesTicker)

      expect(fallbackCalls()).toHaveLength(2)
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ base: "BTC", quote: "JMD", fallback: false }),
        expect.stringContaining("back on executable Swap Rates"),
      )
    })

    it("counts every legacy serve, not once per episode", async () => {
      // `refreshRealtimeData` files both legs under exchangeName "IbexSwap", so
      // `ibex_swap_legacy_fallback_total` is the only downstream signal that
      // the home market was priced off mid-market rates. It has to be a
      // per-serve counter: sitting it above the log-throttling `return` would
      // turn it into one increment per *episode* — a ~240x under-count at a 15s
      // tick against a 1h TTL — with this suite still green.
      mockStatefulLocalCache()
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

      await service.fetchTicker()
      await service.fetchTicker()
      await service.fetchTicker()

      expect(mockCreatedCounterNames).toContain("ibex_swap_legacy_fallback_total")
      expect(mockCounterAdd).toHaveBeenCalledTimes(3)
      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        base: "BTC",
        quote: "JMD",
        reason: "pair-unsupported",
      })
    })

    it("carries the re-probe reason on the counter, not just the log", async () => {
      const { store } = mockStatefulLocalCache()
      ;(axios.get as jest.Mock).mockResolvedValue(unsupported)
      jest
        .spyOn(IbexImpl, "IbexExchangeService")
        .mockResolvedValue({ fetchTicker: jest.fn(async () => legacyTicker) })

      const service = await IbexSwapExchangeService({
        base: "BTC",
        quote: "HTG",
        config: { cacheSeconds: 300 },
      })
      if (service instanceof Error) throw service

      await service.fetchTicker()
      store.delete(`${CacheKeys.CurrentTicker}:IbexSwap:BTC:HTG:unsupported`)
      ;(axios.get as jest.Mock).mockResolvedValue({ data: {}, status: 500 })
      await service.fetchTicker()

      expect(mockCounterAdd).toHaveBeenCalledTimes(2)
      expect(mockCounterAdd).toHaveBeenNthCalledWith(1, 1, {
        base: "BTC",
        quote: "HTG",
        reason: "pair-unsupported",
      })
      expect(mockCounterAdd).toHaveBeenNthCalledWith(2, 1, {
        base: "BTC",
        quote: "HTG",
        reason: "probe-failed",
      })
    })

    it("does not count a serve when the legacy leg is down too", async () => {
      // The counter's own description promises *tickers served*. Counting the
      // attempt instead climbed it once per tick through a both-legs-down
      // episode, during which nothing was priced at all — over-reporting the
      // mid-market signal by exactly the outage.
      mockStatefulLocalCache()
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

      expect(mockCounterAdd).not.toHaveBeenCalled()
    })

    it("distinguishes a failed re-probe from an unsupported pair in the logs", async () => {
      const { store } = mockStatefulLocalCache()
      const warn = jest.spyOn(baseLogger, "warn").mockImplementation(() => undefined)
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

      await service.fetchTicker()

      // the flag ages out and the re-probe fails: still legacy, but for a
      // different reason — an incident rather than a standing condition
      store.delete(unsupportedKey)
      ;(axios.get as jest.Mock).mockResolvedValue({ data: {}, status: 500 })
      await expect(service.fetchTicker()).resolves.toEqual(legacyTicker)

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ fallback: true, reason: "probe-failed" }),
        expect.any(String),
      )
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
