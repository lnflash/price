import dotenv from "dotenv"
import { metrics } from "@opentelemetry/api"
import { MeterProvider } from "@opentelemetry/sdk-metrics"
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus"
import { supportedCurrencies } from "@config"
import { Realtime } from "@app"
import { baseLogger } from "@services/logger"

import { startServer } from "./run"

dotenv.config()

const prometheusPort =
  process.env.PROMETHEUS_PORT || PrometheusExporter.DEFAULT_OPTIONS.port
const prometheusEndpoint = PrometheusExporter.DEFAULT_OPTIONS.endpoint

const exporter = new PrometheusExporter(
  {
    port: Number(prometheusPort),
    endpoint: prometheusEndpoint,
  },
  () => {
    baseLogger.info(
      { endpoint: `http://localhost:${prometheusPort}${prometheusEndpoint}` },
      `prometheus scrape ready`,
    )
  },
)

const meterProvider = new MeterProvider({
  readers: [exporter],
})

// Register globally before anything that can create an instrument. Instruments
// deeper in the tree — e.g. the ibex-swap provider's legacy-fallback counter —
// resolve a provider once, on first use, and keep it: a single `getMeter` call
// ahead of this line would bind that counter to the no-op provider for the
// life of the process, and it would silently never reach the scrape endpoint.
metrics.setGlobalMeterProvider(meterProvider)

startServer()

const meter = meterProvider.getMeter("prices-prometheus")

for (const currency of supportedCurrencies) {
  meter
    .createObservableGauge(`${currency.code}_price`, {
      description: `${currency.code} prices`,
    })
    .addCallback(async (observableResult) => {
      const price = await Realtime.getPrice(currency.code)
      if (price instanceof Error) return

      observableResult.observe(price, { label: "median" })

      const exchangePrices = await Realtime.getExchangePrices(currency.code)
      if (exchangePrices instanceof Error) {
        baseLogger.error(
          { error: exchangePrices, currency },
          "Error getting exchange price",
        )
        return
      }

      for (const { exchangeName, price } of exchangePrices) {
        observableResult.observe(price, { label: `${exchangeName}` })
      }
    })
}

const shutdown = async () => {
  await meterProvider.shutdown()
  await exporter.shutdown()
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
