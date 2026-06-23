import { getCustomConfigPath } from "@config"

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
