import dotenv from "dotenv"
import * as grpc from "@grpc/grpc-js"
import { HealthImplementation, ServingStatusMap } from "grpc-health-check"

import { History } from "@app"

import { ServiceStatus } from "@domain/index"

import { baseLogger } from "@services/logger"
import { wrapAsyncToRunInSpan } from "@services/tracing"

import { protoDescriptorPrice } from "../grpc"

dotenv.config()
const statusMap: ServingStatusMap = {
  "": "NOT_SERVING",
  // 1 is serving
  // 2 is not serving
}
const healthImpl = new HealthImplementation(statusMap)

const listPrices = wrapAsyncToRunInSpan({
  root: true,
  namespace: "servers.run",
  fnName: "listPrices",
  fn: async (
    { request }: grpc.ServerUnaryCall<GetPriceHistoryArgs, unknown>,
    callback: grpc.sendUnaryData<{
      priceHistory: Array<Tick & { price_v2: number }>
    }>,
  ) => {
    const { currency, range } = request
    const priceHistory = await History.getPriceHistory({ currency, range })
    if (priceHistory instanceof Error) {
      baseLogger.error(
        { error: priceHistory, currency, range },
        "Error getting price history",
      )
      return callback({
        code: grpc.status.INTERNAL,
        details: `${currency} is not supported`,
      })
    }

    // ENG-317 / Phase A: populate both `price` (deprecated float32) and
    // `price_v2` (double) on every Tick from the same source value. The
    // wire will quantise `price` through float32; `price_v2` preserves
    // the full float64. See realtime/run.ts and the proto for the full
    // rollout plan.
    const priceHistoryWithDouble = priceHistory.map((t) => ({
      ...t,
      price_v2: t.price,
    }))

    return callback(null, { priceHistory: priceHistoryWithDouble })
  },
})

export const startServer = async () => {
  const port = process.env.PORT || 50052
  const server = new grpc.Server()

  server.addService(protoDescriptorPrice.PriceHistory.service, { listPrices })
  healthImpl.addToServer(server)

  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    async () => {
      baseLogger.info(`Price server running on port ${port}`)
      healthImpl.setStatus("", ServiceStatus.SERVING)
      server.start()
    },
  )

  return server
}

if (require.main === module) {
  startServer()
}
