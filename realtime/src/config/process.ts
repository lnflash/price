export const tracingConfig = {
  otelServiceName: process.env.OTEL_SERVICE_NAME || "galoy-price-dev",
  enableFilter: process.env.TRACING_ENABLE_FILTER === "true",
}

export const IBEX = {
  url: process.env.IBEX_URL as string,
  email: process.env.IBEX_EMAIL as string,
  password: process.env.IBEX_PASSWORD as string
}

export const REDIS = {
  name: process.env.REDIS_MASTER_NAME as string,
  host: process.env.REDIS_0_DNS as string,
  port: parseInt(process.env.REDIS_0_PORT as string, 10),
  password: process.env.REDIS_PASSWORD as string,
}
// export REDIS_TYPE="standalone"