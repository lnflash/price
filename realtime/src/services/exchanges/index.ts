import { InvalidExchangeProviderError } from "@domain/exchanges"

import { CcxtExchangeService } from "./ccxt"
import { YadioExchangeService } from "./yadio"
import { ExchangeRateHostService } from "./exchangeratehost"
import { CurrencyBeaconExchangeService } from "./currencybeacon"
import { ExchangeRatesAPIExchangeService } from "./exchange-rates-api"
import { FreeCurrencyRatesExchangeService } from "./free-currency-rates"
import { MockedExchangeService } from "./mocked"
import { IBEX_RATES_V2_DEFAULT_TIMEOUT_MS, IbexExchangeService } from "./ibex"
import { DEFAULT_SWAP_RATES_TIMEOUT_MS, IbexSwapExchangeService } from "./ibex-swap"

const exchanges: { [key: string]: IExchangeService } = {}

const isDevExchangeConfig = (
  config: ExchangeConfig | DevExchangeConfig,
): config is DevExchangeConfig => {
  return typeof config.config === "object" && "devMockPrice" in config.config
}

export const ExchangeFactory = (): ExchangeFactory => {
  const create = async (
    config: DevExchangeConfig | ExchangeConfig,
  ): Promise<IExchangeService | ExchangeServiceError> => {
    const { provider, name, base, quote } = config
    const key = `${provider}:${name}:${base}:${quote}`

    if (exchanges[key]) return exchanges[key]

    let service: IExchangeService | ExchangeServiceError =
      new InvalidExchangeProviderError()
    if (isDevExchangeConfig(config)) {
      service = await createDev(config)
      if (service instanceof Error) return service
      exchanges[key] = service
      return exchanges[key]
    }

    switch (provider) {
      case "ccxt":
        service = await createCcxt(config)
        break
      case "free-currency-rates":
        service = await createFreeCurrencyRates(config)
        break
      case "currencybeacon":
        service = await createCurrencyBeacon(config)
        break
      case "exchangeratesapi":
        service = await createExchangeRatesAPI(config)
        break
      case "exchangeratehost":
        service = await createExchangeRateHost(config)
        break
      case "yadio":
        service = await createYadio(config)
        break
      case "ibex":
        service = await createIbex(config)
        break
      case "ibex-swap":
        service = await createIbexSwap(config)
        break
    }
    if (service instanceof Error) return service
    exchanges[key] = service
    return exchanges[key]
  }

  return { create }
}

const createDev = MockedExchangeService

const createCcxt = async (config: ExchangeConfig) => {
  const { name, base, quote } = config
  const defaultConfig = { enableRateLimit: true, rateLimit: 2000, timeout: 8000 }
  return CcxtExchangeService({
    exchangeId: name,
    base: base,
    quote: quote,
    config: { ...defaultConfig, ...config.config },
  })
}

const createFreeCurrencyRates = async (config: ExchangeConfig) => {
  const { base, quote } = config
  const defaultConfig = { timeout: 5000 }
  return FreeCurrencyRatesExchangeService({
    base: base,
    quote: quote,
    config: { ...defaultConfig, ...config.config },
  })
}

const createCurrencyBeacon = async (config: ExchangeConfig) => {
  const { base, quote } = config
  const defaultConfig = { timeout: 5000 }
  return CurrencyBeaconExchangeService({
    base: base,
    quote: quote,
    config: { ...defaultConfig, ...config.config },
  })
}

const createExchangeRatesAPI = async (config: ExchangeConfig) => {
  const { base, quote } = config
  const defaultConfig = { timeout: 5000 }
  return ExchangeRatesAPIExchangeService({
    base: base,
    quote: quote,
    config: { ...defaultConfig, ...config.config },
  })
}

const createExchangeRateHost = async (config: ExchangeConfig) => {
  const { base, quote } = config
  const defaultConfig = { timeout: 5000 }
  return ExchangeRateHostService({
    base: base,
    quote: quote,
    config: { ...defaultConfig, ...config.config },
  })
}

const createYadio = async (config: ExchangeConfig) => {
  const { base, quote } = config
  const defaultConfig = { timeout: 5000 }
  return YadioExchangeService({
    base: base,
    quote: quote,
    config: { ...defaultConfig, ...config.config },
  })
}

const createIbex = async (config: ExchangeConfig) => {
  const { base, quote } = config
  // Not the 5s every other provider defaults to: `IbexExchangeService` ignored
  // `timeout` until now, so this provider — which is live in prod — has been
  // running Rates v2 with no client-side cap at all. See
  // IBEX_RATES_V2_DEFAULT_TIMEOUT_MS for why the first bound is set where it
  // is, and change it there — the ibex-swap fallback leg and the `default.yaml`
  // Ibex entry track the same number. Deployment values still override per
  // exchange entry.
  const defaultConfig = { timeout: IBEX_RATES_V2_DEFAULT_TIMEOUT_MS }
  return IbexExchangeService({
    base: base,
    quote: quote,
    config: { ...defaultConfig, ...config.config },
  })
}

const createIbexSwap = async (config: ExchangeConfig) => {
  const { base, quote } = config
  // The provider falls back to the same constant when this is missing or
  // unusable, so the two cannot drift.
  const defaultConfig = { timeout: DEFAULT_SWAP_RATES_TIMEOUT_MS }
  return IbexSwapExchangeService({
    base: base,
    quote: quote,
    config: { ...defaultConfig, ...config.config },
  })
}
