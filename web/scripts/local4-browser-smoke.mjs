import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"

const base = process.env.HARNESS_UI_CDP_URL || "http://[::1]:9223"
const fixtureURL = process.env.HARNESS_UI_FIXTURE_URL || "http://127.0.0.1:4173/local-check.html"
const browserVersion = await fetch(`${base}/json/version`)
if (!browserVersion.ok) throw new Error("Chromium DevTools endpoint unavailable")

function connect(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  const events = new Map()
  let nextID = 0
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      message.error ? reject(new Error(message.error.message)) : resolve(message.result)
    } else if (message.method) {
      for (const callback of events.get(message.method) || []) callback(message.params)
    }
  })
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true })
    socket.addEventListener("error", reject, { once: true })
  })
  return {
    ready,
    on(method, callback) { events.set(method, [...(events.get(method) || []), callback]) },
    command(method, params = {}) {
      const id = ++nextID
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    },
    close() { socket.close() }
  }
}

async function runViewport(width, height, mobile, theme) {
  const created = await fetch(`${base}/json/new?about:blank`, { method: "PUT" }).then((response) => response.json())
  const cdp = connect(created.webSocketDebuggerUrl)
  await cdp.ready
  try {
  const exceptions = []
  cdp.on("Runtime.exceptionThrown", event => exceptions.push(event.exceptionDetails.text))
  let loadedResolve
  const loaded = new Promise((resolve) => { loadedResolve = resolve })
  cdp.on("Page.loadEventFired", loadedResolve)
  await cdp.command("Page.enable")
  await cdp.command("Runtime.enable")
  await cdp.command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile })
  await cdp.command("Page.navigate", { url: `${fixtureURL}${fixtureURL.includes("?") ? "&" : "?"}theme=${theme}` })
  await Promise.race([loaded, new Promise((_, reject) => setTimeout(() => reject(new Error("page load timed out")), 10000))])
  const evaluate = async (expression) => {
    const result = await cdp.command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result?.value
  }
  await evaluate(`new Promise((resolve, reject) => { const started = Date.now(); const poll = () => document.querySelector('.uw-transcript') && document.querySelector('.tdw-model-trigger') ? resolve(true) : Date.now() - started > 10000 ? reject(new Error('fixture render timed out')) : setTimeout(poll, 50); poll(); })`)
  await writeFile(`/tmp/ui-check-${theme}-${width}x${height}.png`, Buffer.from((await cdp.command("Page.captureScreenshot", { format: "png" })).data, "base64"))
  const result = await evaluate(`(async () => {
    const wait = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
    const waitFor = async (predicate) => { for (let i = 0; i < 100; i++) { if (predicate()) return true; await wait(30); } throw new Error('interaction timed out: ' + window.fixtureStage); };
    const transcript = document.querySelector('.uw-transcript');
    transcript.scrollTo({ top: 0, behavior: 'instant' });
    await wait(100);
    const before = { top: transcript.scrollTop, bottom: transcript.scrollHeight - transcript.clientHeight };
    window.fixtureStage = 'cached-switch'; document.querySelector('#switch-session').click();
    await waitFor(() => document.querySelector('.fixture-shell').dataset.revision === '2');
    await wait(80);
    const after = { top: transcript.scrollTop, bottom: transcript.scrollHeight - transcript.clientHeight, behavior: getComputedStyle(transcript).scrollBehavior };
    const textarea = document.querySelector('.uw-composer-shell textarea');
    const shell = document.querySelector('.uw-composer-shell');
    const borderBefore = getComputedStyle(shell).borderColor;
    textarea.focus();
    await wait(250);
    const focus = { active: document.activeElement === textarea, focusWithin: shell.matches(':focus-within'), disabled: textarea.disabled, outline: getComputedStyle(textarea).outlineStyle, shadow: getComputedStyle(textarea).boxShadow, border: getComputedStyle(textarea).borderColor, borderWidth: getComputedStyle(textarea).borderWidth, outerBefore: borderBefore, outerFocused: getComputedStyle(shell).borderColor };
    textarea.blur();
    document.querySelector('#start-work').click();
    await wait(80);
    const meta = document.querySelector('.uw-composer-meta');
    const limitsSummary = document.querySelector('.codex-rate-limits-disclosure > summary');
    const limitsSummaryRect = limitsSummary.getBoundingClientRect();
    const metaFit = { width: meta.clientWidth, scrollWidth: meta.scrollWidth, right: Math.round(meta.getBoundingClientRect().right), summaryLeft: Math.round(limitsSummaryRect.left), summaryRight: Math.round(limitsSummaryRect.right), summaryWidth: Math.round(limitsSummaryRect.width), statusRight: Math.round(document.querySelector('.tdw-conversation-state').getBoundingClientRect().right) };
    limitsSummary.click();
    await wait(50);
    const quotaPopover = document.querySelector('.codex-rate-limits-popover').getBoundingClientRect();
    const quotaPopoverBounds = { left: Math.round(quotaPopover.left), right: Math.round(quotaPopover.right), top: Math.round(quotaPopover.top), bottom: Math.round(quotaPopover.bottom), withinViewport: quotaPopover.left >= 0 && quotaPopover.right <= innerWidth && quotaPopover.top >= 0 && quotaPopover.bottom <= innerHeight };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => !document.querySelector('.codex-rate-limits-disclosure').open);
    limitsSummary.click(); await wait(50);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await waitFor(() => !document.querySelector('.codex-rate-limits-disclosure').open);
    const queueFit = [...document.querySelectorAll('.uw-queued-prompt')].map(row => ({ width: row.clientWidth, scrollWidth: row.scrollWidth, right: Math.round(row.getBoundingClientRect().right), actionsRight: Math.round(row.querySelector('.uw-queued-prompt-actions').getBoundingClientRect().right) }));
    const model = document.querySelector('.tdw-model-trigger').getBoundingClientRect();
    const harness = document.querySelector('.uw-composer-routing select').getBoundingClientRect();
    const stop = document.querySelector('.uw-button-danger').getBoundingClientRect();
    const modelAlignment = { modelCenter: Math.round(model.top + model.height / 2), harnessCenter: Math.round(harness.top + harness.height / 2), stopCenter: Math.round(stop.top + stop.height / 2) };
    window.fixtureStage = 'image-open'; document.querySelector('.uw-message-attachment-open').click();
    await waitFor(() => Boolean(document.querySelector('.uw-image-lightbox')));
    const backdrop = document.querySelector('.uw-image-lightbox-backdrop');
    const panel = document.querySelector('.uw-image-lightbox');
    const rect = panel.getBoundingClientRect();
    const topElement = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const lightbox = { portaledToChat: backdrop.parentElement === document.querySelector('.uw-conversation-core'), backdropColor: getComputedStyle(backdrop).backgroundColor, panelColor: getComputedStyle(panel).backgroundColor, panelOnTopAtCenter: panel.contains(topElement), focusInside: panel.contains(document.activeElement), zIndex: getComputedStyle(backdrop).zIndex };
    document.querySelector('.uw-image-lightbox-close').click();
    await waitFor(() => !document.querySelector('.uw-image-lightbox'));
    const edit = [...document.querySelectorAll('.uw-queued-prompt-action')].find(button => button.textContent.trim() === 'Edit');
    window.fixtureStage = 'queue-edit'; edit.click();
    await waitFor(() => Boolean(document.querySelector('.uw-queued-prompt-edit')));
    const input = document.querySelector('.uw-queued-prompt-edit');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Edited fixture text');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    window.fixtureStage = 'queue-save'; document.querySelector('.uw-queued-prompt-actions .uw-queued-prompt-action').click();
    await waitFor(() => window.fixtureLastAction?.startsWith('edit:'));
    const editAction = { action: window.fixtureLastAction, text: window.fixtureQueue[0]?.text, attachmentCount: window.fixtureQueue[0]?.attachmentCount };
    window.fixtureStage = 'queue-send-now'; await waitFor(() => !document.querySelector('.uw-queued-prompt-edit') && !document.querySelector('.uw-queued-prompt .uw-queued-prompt-action').disabled); document.querySelector('.uw-queued-prompt .uw-queued-prompt-action').click();
    await waitFor(() => window.fixtureLastAction?.startsWith('send-now:'));
    return { viewport: [innerWidth, innerHeight], before, after, focus, metaFit, quotaPopoverBounds, queueFit, pageOverflow: document.documentElement.scrollWidth > innerWidth, modelAlignment, lightbox, editAction, sendNowAction: window.fixtureLastAction };
  })()`)
  assert.deepEqual(exceptions, [], "fixture must not throw browser exceptions")
  return { ...result, theme }
  } finally {
    cdp.close()
    await fetch(`${base}/json/close/${created.id}`).catch(() => {})
  }
}

for (const viewport of [[1440, 900, false, "light"], [390, 844, true, "light"], [1440, 900, false, "dark"], [390, 844, true, "dark"]]) {
  const result = await runViewport(...viewport)
  console.log(JSON.stringify(result))
  assert.ok(Math.abs(result.after.top - result.after.bottom) <= 1, "cached activation must land instantly at tail")
  assert.equal(result.pageOverflow, false, "fixture must fit horizontally")
  assert.equal(result.focus.outline, "none")
  assert.equal(result.focus.borderWidth, "0px")
  assert.equal(result.quotaPopoverBounds.withinViewport, true, "quota popover must stay within viewport")
  assert.equal(result.lightbox.portaledToChat, true)
  assert.equal(result.lightbox.panelOnTopAtCenter, true)
  assert.equal(result.lightbox.focusInside, true)
  assert.ok(result.queueFit.every(row => row.scrollWidth <= row.width + 1), "queued actions must fit")
  assert.equal(result.editAction.text, "Edited fixture text")
  assert.equal(result.editAction.attachmentCount, 2)
  assert.equal(result.sendNowAction, "send-now:q1")
}
