import {
  coerceToStringArray,
  ConfigError,
  getCustomConfigPath,
  getFractionDigits,
  supportedCurrencies,
} from "@config"

describe("getCustomConfigPath", () => {
  const originalYamlConfigPath = process.env.YAML_CONFIG_PATH

  afterEach(() => {
    process.env.YAML_CONFIG_PATH = originalYamlConfigPath
  })

  it("uses the default mounted config path when YAML_CONFIG_PATH is not set", () => {
    delete process.env.YAML_CONFIG_PATH

    expect(getCustomConfigPath()).toBe("/var/yaml/custom.yaml")
  })

  it("uses YAML_CONFIG_PATH when it is set", () => {
    process.env.YAML_CONFIG_PATH = "/tmp/price-custom.yaml"

    expect(getCustomConfigPath()).toBe("/tmp/price-custom.yaml")
  })
})

describe("coerceToStringArray", () => {
  it("returns an empty array if the input is falsy", () => {
    expect(coerceToStringArray(undefined)).toEqual([])
    expect(coerceToStringArray(null)).toEqual([])
    expect(coerceToStringArray(false)).toEqual([])
    expect(coerceToStringArray("")).toEqual([])
  })

  it("returns an array with a single uppercase string if the input is a string", () => {
    expect(coerceToStringArray("usd")).toEqual(["USD"])
  })

  it("returns an array of uppercase strings if the input is an array of strings", () => {
    expect(coerceToStringArray(["usd", "eur"])).toEqual(["USD", "EUR"])
  })

  it("throws a ConfigError if the input is not a string or an array of strings", () => {
    expect(() => coerceToStringArray(21)).toThrow(ConfigError)
    expect(() => coerceToStringArray({ attr: "value" })).toThrow(ConfigError)
    expect(() => coerceToStringArray(["usd", 21])).toThrow(ConfigError)
  })
})

describe("getFractionDigits", () => {
  const USD = "USD" as CurrencyCode
  const JPY = "JPY" as CurrencyCode

  test("returns correct fraction digits for a valid currency", () => {
    const resultUsd = getFractionDigits({ currency: USD })
    expect(resultUsd).toBe(2)
    const resultJpy = getFractionDigits({ currency: JPY })
    expect(resultJpy).toBe(0)
  })

  test("returns provided fraction digits for a valid currency", () => {
    const currency = USD
    const fractionDigits = 3
    const result = getFractionDigits({ currency, fractionDigits })
    expect(result).toBe(fractionDigits)
  })

  test("returns provided fraction digits for a non-standard currency", () => {
    const currency = "ARSp" as CurrencyCode
    const fractionDigits = 3
    const result = getFractionDigits({ currency, fractionDigits })
    expect(result).toBe(fractionDigits)
  })

  test("throws ConfigError for an invalid currency", () => {
    const currency = "INVALID" as CurrencyCode
    const expectedErrorMessage = `Invalid currency. If ${currency} is a custom currency please add fractionDigits`
    expect(() => getFractionDigits({ currency })).toThrow(ConfigError)
    expect(() => getFractionDigits({ currency })).toThrowError(expectedErrorMessage)
  })
})

describe("supportedCurrencies", () => {
  test("returns correct country codes for a valid currency", () => {
    const expectedUsdCountries = [
      "AQ",
      "AS",
      "BQ",
      "EC",
      "FM",
      "GU",
      "IO",
      "MH",
      "MP",
      "PR",
      "PW",
      "SV",
      "TC",
      "TL",
      "UM",
      "US",
      "VG",
      "VI",
    ]

    const usdCurrency = supportedCurrencies.find((c) => c.code === "USD")
    if (usdCurrency === undefined) throw new Error()
    expect(usdCurrency.countryCodes).toEqual(expectedUsdCountries)

    const jmdCurrency = supportedCurrencies.find((c) => c.code === "JMD")
    if (jmdCurrency === undefined) throw new Error()
    expect(jmdCurrency.countryCodes).toEqual(["JM"])
  })
})
