// Repeated full-app geometry checks. Never weakens the per-frame tail assertion.
import { run } from './local5-workspace-smoke.mjs'
const rounds = Number(process.env.HARNESS_UI_ITERATIONS || 3)
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) throw new Error('HARNESS_UI_ITERATIONS must be 1..20')
for (let round = 1; round <= rounds; round++) {
  for (const [width,height,theme,touch] of [[1440,900,'light',false],[390,844,'light',true],[390,844,'dark',true],[844,390,'light',true]]) {
    await run(width,height,theme,touch,{round,stress:true,prefix:'local6-workspace'})
  }
}
