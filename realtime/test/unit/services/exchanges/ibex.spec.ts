import { InvalidExchangeConfigError } from "@domain/exchanges"
import { IBEX } from "@config"
import { IbexExchangeService } from "@services/exchanges/ibex"

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

  // The exchange factory passes `timeout: 5000` (services/exchanges/index.ts).
  // Dropping it on the floor left every Rates v2 call on the sdk's 30s default,
  // doubled by withAuth's single retry — and `ibex-swap` routes the pairs Swap
  // Rates cannot price (JMD, HTG, CAD) through here, on a 15s polling tick.
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
