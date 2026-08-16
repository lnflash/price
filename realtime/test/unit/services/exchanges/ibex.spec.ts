import { InvalidExchangeConfigError } from "@domain/exchanges"
import { defaultConfig, IBEX } from "@config"
import { baseLogger } from "@services/logger"
import { ExchangeFactory } from "@services/exchanges"
import {
  IBEX_RATES_V2_DEFAULT_TIMEOUT_MS,
  IbexExchangeService,
} from "@services/exchanges/ibex"

const sdkConfig = jest.fn()

jest.mock("ibex-client", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    // the generated api-sdk instance; `.config({ timeout })` overrides its
    // 30s default fetch timeout
    ibex: { config: sdkConfig },
    getRate: jest.fn(),
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
