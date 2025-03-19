import {
  InvalidTickerError,
  ExchangeServiceError,
  InvalidExchangeConfigError,
} from "@domain/exchanges"
import { toPrice, toTimestamp } from "@domain/primitives"
import { baseLogger } from "@services/logger"

export const FirstGlobalRates = async ({
  base,
  quote,
  rates,
}: FirstGlobalRatesArgs): Promise<IExchangeService | ExchangeServiceError> => {
  if (!rates) return new InvalidExchangeConfigError("First Global Rates not found") 

  if (!Object.keys(rates).includes(base)) {
    return new InvalidExchangeConfigError(`Config missing base '${base}'`)
  }

  if (!Object.keys(rates[base]).includes(quote)) {
    return new InvalidExchangeConfigError(
      `Config base missing quote '${quote}' for base '${base}'`,
    )
  }

  const fetchTicker = async (): Promise<Ticker | ServiceError> =>
    tickerFromRaw({
      bid: rates[base][quote].bid,
      ask: rates[base][quote].ask,
      timestamp: new Date().getTime(),
    })

  baseLogger.info({ ...(await fetchTicker()) }, "First Global:")
  return { fetchTicker }
}

const tickerFromRaw = ({
  bid,
  ask,
  timestamp,
}: {
  bid: number,
  ask: number,
  timestamp: number
}): Ticker | InvalidTickerError => {
  if (bid > 0 && ask > 0 && timestamp > 0) {
    return {
      bid: toPrice(bid),
      ask: toPrice(ask),
      timestamp: toTimestamp(timestamp),
    }
  }

  return new InvalidTickerError()
}
