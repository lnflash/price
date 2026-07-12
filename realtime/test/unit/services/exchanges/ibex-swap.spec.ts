import axios from "axios"

import { toPrice, toTimestamp } from "@domain/primitives"
import {
  ExchangeServiceError,
  InvalidExchangeResponseError,
  UnknownExchangeServiceError,
} from "@domain/exchanges"

import * as LocalCacheServiceImpl from "@services/cache"
import { IbexSwapExchangeService } from "@services/exchanges/ibex-swap"

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
})
