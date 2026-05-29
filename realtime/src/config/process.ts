export const tracingConfig = {
  otelServiceName: process.env.OTEL_SERVICE_NAME || "galoy-price-dev",
  enableFilter: process.env.TRACING_ENABLE_FILTER === "true",
}

export const IBEX = {
  clientId: process.env.IBEX_CLIENT_ID as string,
  clientSecret: process.env.IBEX_CLIENT_SECRET as string,
  environment: (process.env.IBEX_ENVIRONMENT || "sandbox") as "production" | "sandbox",
}

let connectionObj = {}

if (process.env.REDIS_TYPE === "standalone") {
  connectionObj = {
    name: process.env.REDIS_MASTER_NAME,
    host: process.env.REDIS_0_DNS,
    port: process.env.REDIS_0_PORT,
    password: process.env.REDIS_PASSWORD,
  }
} else {
  connectionObj = {
    sentinelPassword: process.env.REDIS_PASSWORD,
    sentinels: [
      {
        host: `${process.env.REDIS_0_DNS}`,
        port: process.env.REDIS_0_PORT,
      },
      {
        host: `${process.env.REDIS_1_DNS}`,
        port: process.env.REDIS_1_PORT,
      },
      {
        host: `${process.env.REDIS_2_DNS}`,
        port: process.env.REDIS_2_PORT,
      },
    ],
    name: process.env.REDIS_MASTER_NAME,
    password: process.env.REDIS_PASSWORD,
  }
}

export const REDIS = connectionObj