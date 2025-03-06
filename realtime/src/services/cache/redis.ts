import Redis from "ioredis"
import RedisCache from "ioredis-cache"
import { REDIS as REDIS_CONFIG } from "@config"
import { baseLogger } from "@services/logger"

const redis = new Redis(REDIS_CONFIG)
redis.on("error", (err) => baseLogger.error({ err }, "Redis error"))
// high-level wrapper of redis for caching
export const redisCache = new RedisCache(redis)