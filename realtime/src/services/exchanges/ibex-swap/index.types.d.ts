type IbexSwapConfig = { [key: string]: string | number | boolean }

type IbexSwapRates = { rate: number; inverseRate: number }

type IbexSwapExchangeServiceArgs = {
  base: string
  quote: string
  config?: IbexSwapConfig
}
