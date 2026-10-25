import { readFileSync } from "node:fs"

// This module is copied unchanged into the release bundle at bridge/src. In both a source checkout
// and the packaged layout, ../../package.json is the owning Harness Remote package manifest.
const packageInfo = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))

export const LOCAL_RELEASE_INFO = Object.freeze({
  harnessVersion: packageInfo.version,
  releaseChannel: "candidate",
  historyProtocol: 1
})
