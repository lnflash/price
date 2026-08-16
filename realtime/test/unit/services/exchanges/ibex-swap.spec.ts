import axios from "axios"

import { toPrice, toTimestamp } from "@domain/primitives"
import {
  ExchangeServiceError,
  InvalidExchangeResponseError,
  UnknownExchangeServiceError,
} from "@domain/exchanges"

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

describe("IbexSwapExchangeService", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockLocalCache()
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
          key.endsWith(":status")
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

      expect(await service.fetchTicker()).toBeInstanceOf(ExchangeServiceError)
    })
  })
})
