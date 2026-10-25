import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { readFile, access } from "node:fs/promises"
import test from "node:test"
import { createBridgeServer } from "../src/server.js"

const packageURL = new URL("../../package.json", import.meta.url)

async function readJSON(url) {
  return JSON.parse(await readFile(url, "utf8"))
}

class HealthAcp extends EventEmitter {
  agentInfo = { version: "fixture-agent-1.0.0" }
  async start() {}
}

test("authenticated health reports the owning package version and agrees with release manifests", async () => {
  const packageInfo = await readJSON(packageURL)
  const manifestURLs = [
    new URL("../../release.json", import.meta.url),
    new URL(`../../release/${packageInfo.version}/release.json`, import.meta.url)
  ]
  const manifests = []
  for (const url of manifestURLs) {
    try {
      await access(url)
      manifests.push({ url, manifest: await readJSON(url) })
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
  }

  const server = createBridgeServer({
    acp: new HealthAcp(),
    config: { host: "127.0.0.1", port: 0, username: "fixture", password: "secret", roots: [process.cwd()] }
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    const baseURL = `http://127.0.0.1:${address.port}`
    for (const route of ["/global/health", "/v1/health"]) {
      const unauthenticated = await fetch(`${baseURL}${route}`)
      assert.equal(unauthenticated.status, 401)

      const response = await fetch(`${baseURL}${route}`, {
        headers: { authorization: `Basic ${Buffer.from("fixture:secret").toString("base64")}` }
      })
      assert.equal(response.status, 200)
      const health = await response.json()
      assert.equal(health.harnessVersion, packageInfo.version, "health must identify the owning root package")
      for (const { url, manifest } of manifests) {
        assert.equal(manifest.version, packageInfo.version, `${url.pathname} must match package.json`)
        assert.equal(health.harnessVersion, manifest.version, `${url.pathname} must match authenticated health`)
      }
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
