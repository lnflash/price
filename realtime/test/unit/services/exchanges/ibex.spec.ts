import {
  InvalidExchangeConfigError,
  UnknownExchangeServiceError,
} from "@domain/exchanges"
import { toPrice, toTimestamp } from "@domain/primitives"
import { defaultConfig, IBEX } from "@config"
import { baseLogger } from "@services/logger"
import { ExchangeFactory } from "@services/exchanges"
import {
  IBEX_RATES_V2_DEFAULT_TIMEOUT_MS,
  IbexExchangeService,
} from "@services/exchanges/ibex"

const sdkConfig = jest.fn()
const sdkGetRate = jest.fn()

jest.mock("ibex-client", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    // the generated api-sdk instance; `.config({ timeout })` overrides its
    // 30s default fetch timeout — for the Rates v2 request only, never for
    // the OAuth token request withAuth runs first
    ibex: { config: sdkConfig },
    getRate: sdkGetRate,
    authentication: {
      withAuth: jest.fn(),
      storage: { getAccessToken: jest.fn(async () => "test-token") },
    },
  })),
  IbexUrls: {
    production: { hubUrl: "https://ibexhub-api.poweredbyibex.io" },
    sandbox: { hubUrl: "https://ibexhub-api.sandbox.poweredbyibex.io" },
  },
}))

jest.mock("@config", () => ({
  ...jest.requireActual("@config"),
  IBEX: {
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    environment: "sandbox",
  },
}))

describe("IbexExchangeService", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // `clearAllMocks` wipes call records but keeps implementations, and the sdk
    // stand-in is module-scoped — so an implementation set by one test would
    // otherwise leak into every test after it.
    sdkGetRate.mockReset()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  // The exchange factory has always passed a `timeout`
  // (services/exchanges/index.ts). Dropping it on the floor left every Rates v2
  // call with no client-side abort at all — the sdk installs one only when a
  // timeout is configured, and nothing configured it — doubled by withAuth's
  // single retry. And `ibex-swap` routes the pairs Swap Rates cannot price
  // (JMD, HTG, CAD) through here, on a 15s polling tick.
  it("caps the sdk fetch timeout at the configured timeout", async () => {
    const service = await IbexExchangeService({
      base: "BTC",
      quote: "JMD",
      config: { timeout: 5000 },
    })
    if (service instanceof Error) throw service

    expect(sdkConfig).toHaveBeenCalledWith({ timeout: 5000 })
  })

  it("caps the sdk fetch timeout even when no timeout is configured", async () => {
    const service = await IbexExchangeService({ base: "BTC", quote: "USD", config: {} })
    if (service instanceof Error) throw service

    expect(sdkConfig).toHaveBeenCalledWith({ timeout: 5000 })
  })

  // A helm values file hands `timeout` through as whatever the operator typed.
  // `timeout: 10s` parses to NaN, and the previous `if (timeout > 0)` guard
  // turned that into "never call .config()" — i.e. it failed *open*, silently
  // restoring the uncapped behaviour this change exists to remove.
  it.each([
    ["a non-numeric string", "10s"],
    ["an empty string", ""],
    ["zero", 0],
    ["a negative number", -1],
  ])(
    "still caps the sdk when the configured timeout is %s",
    async (_label: string, value: string | number) => {
      const warn = jest.spyOn(baseLogger, "warn").mockImplementation(() => undefined)

      const service = await IbexExchangeService({
        base: "BTC",
        quote: "JMD",
        config: { timeout: value },
      })
      if (service instanceof Error) throw service

      expect(sdkConfig).toHaveBeenCalledWith({ timeout: 5000 })
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ configuredTimeout: value, timeout: 5000 }),
        expect.stringContaining("unusable `timeout`"),
      )
    },
  )

  it("does not warn when the configured timeout is usable", async () => {
    const warn = jest.spyOn(baseLogger, "warn").mockImplementation(() => undefined)

    const service = await IbexExchangeService({
      base: "BTC",
      quote: "JMD",
      config: { timeout: 7000 },
    })
    if (service instanceof Error) throw service

    expect(sdkConfig).toHaveBeenCalledWith({ timeout: 7000 })
    expect(warn).not.toHaveBeenCalled()
  })

  // Rollout guard. Honouring `timeout` is a live behaviour change for a
  // provider prod still runs: it goes from *no* client-side cap (the sdk only
  // installs an abort controller when one is configured, and ibex-client never
  // configures one — the "30 seconds" is JSDoc the implementation does not
  // honour) to whatever the factory hands it. So the factory deliberately does
  // not hand it the 5000 every other provider defaults to: anything below the
  // documented 30s could start erroring calls that today wait and succeed,
  // dropping JMD onto a mid-market FX provider. Change this number with a
  // measured latency distribution in hand, not before.
  it("pins the Rates v2 default timeout so tightening it is deliberate", () => {
    expect(IBEX_RATES_V2_DEFAULT_TIMEOUT_MS).toBe(30000)
  })

  it("defaults the ibex provider to the shared Rates v2 timeout in the factory", async () => {
    const service = await ExchangeFactory().create({
      provider: "ibex",
      name: "ibex-factory-timeout-default",
      base: "BTC",
      quote: "JMD",
      quoteAlias: "",
      excludedQuotes: [],
      cron: "",
      config: {},
    })
    if (service instanceof Error) throw service

    expect(sdkConfig).toHaveBeenCalledWith({ timeout: IBEX_RATES_V2_DEFAULT_TIMEOUT_MS })
  })

  // Third copy of the same number: deployments that replace the `exchanges`
  // list wholesale take the shipped yaml's value, not `createIbex`'s. Without
  // this, tightening the constant would leave the yaml behind and no test
  // would notice.
  it("keeps the shipped default.yaml Ibex timeout in step with the constant", () => {
    const exchanges = (defaultConfig as { exchanges: ExchangeConfig[] }).exchanges
    const ibex = exchanges.find((exchange) => exchange.provider === "ibex")
    if (ibex === undefined) throw new Error("no ibex exchange in default.yaml")

    expect(ibex.config.timeout).toBe(IBEX_RATES_V2_DEFAULT_TIMEOUT_MS)
  })

  // `Ibex.ibex.config({ timeout })` bounds the Rates v2 *request* only. The
  // OAuth token request `withAuth` performs first is a bare global `fetch` with
  // no signal and no relation to the sdk core
  // (ibex-client/dist/authentication/index.js:28), so on a cold token cache or
  // an expiry refresh a stalled `auth.hub.poweredbyibex.io` hangs on undici's
  // ~300s defaults. This provider's mutex is module-scoped — one lock for every
  // base/quote pair — and `ibex-swap` routes its legacy leg through here, so an
  // unbounded hold stalls the ticker of every pair either provider serves.
  it("releases the shared mutex when a call outlives the configured timeout", async () => {
    const warn = jest.spyOn(baseLogger, "warn").mockImplementation(() => undefined)
    sdkGetRate.mockImplementation(
      async ({ secondary_currency_id }: { secondary_currency_id: number }) =>
        secondary_currency_id === 28 // JMD — stands in for a parked auth call
          ? new Promise(() => undefined)
          : { rate: 64000, updatedAtUnix: 1_700_000_000_000 },
    )

    const jmd = await IbexExchangeService({
      base: "BTC",
      quote: "JMD",
      config: { timeout: 50 },
    })
    const usd = await IbexExchangeService({
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
      bid: toPrice(64000),
      ask: toPrice(64000),
      timestamp: toTimestamp(1_700_000_000_000),
    })

    await expect(jmdInFlight).resolves.toBeInstanceOf(UnknownExchangeServiceError)
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ base: "BTC", quote: "JMD", timeout: 50 }),
      expect.stringContaining("releasing the shared lock"),
    )
  })

  it("returns InvalidExchangeConfigError without credentials", async () => {
    const clientId = IBEX.clientId
    IBEX.clientId = ""

    try {
      const service = await IbexExchangeService({ base: "BTC", quote: "USD", config: {} })
      expect(service).toBeInstanceOf(InvalidExchangeConfigError)
      expect(sdkConfig).not.toHaveBeenCalled()
    } finally {
      IBEX.clientId = clientId
    }
  })
})
