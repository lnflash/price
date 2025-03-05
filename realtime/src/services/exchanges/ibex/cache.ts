import { redisCache } from "@services/cache"
import { CacheSetArgs, ICache, NonError } from "ibex-client/dist/storage"

// TODO: if connection to redis fails, fallback to local cache

// Map Redis Interface to interface used in ibex-client 
export const AuthCache = {
  get: (key: string) => redisCache.getCache(key),
  set: async <T>(args: CacheSetArgs<NonError<T>>) => {
    const res = await redisCache.setCache(
      args.key,
      args.value,
      args.ttlSecs as Seconds,
    )
    return res === "OK" 
  },
  delete: (key: string) => {
    redisCache.deleteCache(key)
    return
  },
} as ICache