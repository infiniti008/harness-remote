import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { readFileSync } from "node:fs"

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))

export default defineConfig({
  define: { "import.meta.env.VITE_HARNESS_VERSION": JSON.stringify(version) },
  plugins: [react()]
})
