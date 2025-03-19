type RawExchangeConfig = {
  name: string
  base: string
  quote: string[]
  excludedQuotes: string[]
  quoteAlias: string[]
  provider: string
  cron: string
  config: { [key: string]: string | number | boolean } | MockedConfig
}

type PartialExchangeConfig = {
  name: string
  base: string
  quote: string
  quoteAlias: string
  excludedQuotes: string[]
  provider: string
  cron: string
}

type ExchangeConfig = PartialExchangeConfig & {
  config: { [key: string]: string | number | boolean }
  rates?: StaticRates
}


type DevExchangeConfig = PartialExchangeConfig & {
  config: MockedConfig
}

type Currency = string
type BaseCurrency = Currency & { readonly brand: Currency }
type QuoteCurrency = Currency & { readonly brand: Currency }

type StaticRates = {
  [key: BaseCurrency]: {
    [key: QuoteCurrency]: {
      bid: number,
      ask: number,
    }
  }
}
