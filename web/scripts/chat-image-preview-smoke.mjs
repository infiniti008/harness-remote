// Isolated actual-app check for the chat-scoped image preview. Uses synthetic fixture data only.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { connect, installTransport } from './local5-workspace-smoke.mjs'

const cdpURL = process.env.HARNESS_UI_CDP_URL || 'http://[::1]:9223'
const appURL = process.env.HARNESS_UI_APP_URL || 'http://127.0.0.1:4174/'
const artifactsDir = process.env.HARNESS_UI_ARTIFACTS_DIR || '/tmp/harness-chat-image-preview-smoke'
const viewports = [
  { width: 1440, height: 900, theme: 'light', touch: false },
  { width: 1440, height: 900, theme: 'dark', touch: false },
  { width: 1024, height: 768, theme: 'light', touch: false },
  { width: 390, height: 844, theme: 'light', touch: true },
  { width: 390, height: 844, theme: 'dark', touch: true },
  { width: 844, height: 390, theme: 'light', touch: true },
]

const metrics = (width, height, touch) => ({
  width, height, deviceScaleFactor: 1, mobile: touch,
  screenOrientation: width > height
    ? { type: 'landscapePrimary', angle: 90 }
    : { type: 'portraitPrimary', angle: 0 },
})

async function runViewport(viewport) {
  const version = await fetch(`${cdpURL}/json/version`).then((response) => {
    if (!response.ok) throw new Error(`CDP version endpoint returned ${response.status}`)
    return response.json()
  })
  const browser = connect(version.webSocketDebuggerUrl)
  await browser.ready
  let client
  let browserContextId
  try {
    ({ browserContextId } = await browser.call('Target.createBrowserContext'))
    const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank', browserContextId })
    const tabs = await fetch(`${cdpURL}/json/list`).then((response) => response.json())
    const tab = tabs.find((candidate) => candidate.id === targetId)
    assert.ok(tab?.webSocketDebuggerUrl, `CDP target ${targetId} did not expose a page socket`)
    client = connect(tab.webSocketDebuggerUrl)
    await client.ready
    await client.call('Page.enable')
    await client.call('Runtime.enable')
    await client.call('Emulation.setDeviceMetricsOverride', metrics(viewport.width, viewport.height, viewport.touch))
    await client.call('Emulation.setTouchEmulationEnabled', { enabled: viewport.touch, maxTouchPoints: 1 })
    await client.call('Page.addScriptToEvaluateOnNewDocument', {
      source: `(${installTransport.toString()})(${JSON.stringify(viewport.theme)},false,true)`,
    })
    await client.call('Page.navigate', { url: appURL })

    const evaluate = async (fn) => {
      const response = await client.call('Runtime.evaluate', {
        expression: `(${fn.toString()})()`, awaitPromise: true, returnByValue: true, userGesture: true,
      })
      if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails))
      return response.result.value
    }
    const observed = await evaluate(async function inspectPreview() {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const until = async (predicate, label) => {
        for (let i = 0; i < 300; i++) {
          if (predicate()) return
          await wait(30)
        }
        throw new Error(`Timed out waiting for ${label}: ${document.body.innerText.slice(0, 500)}`)
      }
      const row = (key) => [...document.querySelectorAll('.hr-native-session-row')]
        .find((element) => element.textContent.includes(`Cached Session ${key}`))
      const backToRail = () => {
        const button = document.querySelector('.tdw-mobile-back')
        if (button && button.getClientRects().length) button.click()
      }
      const openSession = async (key) => {
        backToRail()
        await until(() => Boolean(row(key)), `Cached Session ${key} row`)
        row(key).click()
        await until(() => document.querySelector('.uw-transcript')?.textContent.includes(`fixture-${key} message 200`), `Session ${key} transcript`)
        await wait(80)
      }
      const image = () => document.querySelector('.uw-message-attachment-open img')
      const backdrop = () => document.querySelector('.uw-image-lightbox-backdrop')
      const closeButton = () => document.querySelector('.uw-image-lightbox-close')
      const openImage = async () => {
        await until(() => Boolean(image()), 'real image attachment thumbnail')
        const thumbnailImage = image()
        await until(() => thumbnailImage.complete && thumbnailImage.naturalWidth > 0, 'thumbnail image decode')
        const trigger = thumbnailImage.closest('.uw-message-attachment-open')
        trigger.focus(); trigger.click()
        await until(() => Boolean(backdrop()), 'image preview')
        const fullImage = backdrop().querySelector('.uw-image-lightbox-image')
        await until(() => fullImage?.complete && fullImage.naturalWidth > 0, 'full-size image decode')
        await until(() => document.activeElement === closeButton(), 'preview close-button focus')
      }
      const rect = (element) => {
        const box = element.getBoundingClientRect()
        return { x: box.x, y: box.y, top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, height: box.height }
      }
      const visible = (element) => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
      const pointHit = (element) => {
        const box = element.getBoundingClientRect()
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return { hit: hit?.tagName || '', inside: Boolean(hit && element.contains(hit)) }
      }
      const geometry = () => {
        const root = backdrop()
        const core = root?.parentElement
        const panel = root?.querySelector('.uw-image-lightbox')
        const fullImage = root?.querySelector('.uw-image-lightbox-image')
        if (!root || !core || !panel || !fullImage) return null
        const rootBox = rect(root), coreBox = rect(core), panelBox = rect(panel), imageBox = rect(fullImage)
        const contains = (outer, inner) => inner.left >= outer.left - 1 && inner.top >= outer.top - 1 && inner.right <= outer.right + 1 && inner.bottom <= outer.bottom + 1
        const css = getComputedStyle(root)
        const bg = css.backgroundColor
        let alpha = 1
        const slash = bg.match(/\/\s*([\d.]+)%?\s*\)$/)
        const rgba = bg.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)$/)
        if (slash) alpha = Number(slash[1]) > 1 ? Number(slash[1]) / 100 : Number(slash[1])
        else if (rgba) alpha = Number(rgba[1])
        return {
          parentIsCore: core.classList.contains('uw-conversation-core'),
          position: css.position,
          rootBox, coreBox, panelBox, imageBox,
          rootMatchesCore: Math.abs(rootBox.left - coreBox.left) <= 1 && Math.abs(rootBox.top - coreBox.top) <= 1 && Math.abs(rootBox.right - coreBox.right) <= 1 && Math.abs(rootBox.bottom - coreBox.bottom) <= 1,
          panelInside: contains(rootBox, panelBox), imageInside: contains(rootBox, imageBox),
          backgroundColor: bg, backgroundAlpha: alpha, opaque: alpha >= 0.98 && Number(css.opacity) >= 0.98,
          panelHit: pointHit(panel), modal: root.querySelector('[aria-modal="true"]') !== null,
          naturalWidth: fullImage.naturalWidth,
        }
      }
      const assertWait = async (predicate, label) => until(predicate, label)
      await openSession('A')
      const sessionHeader = document.querySelector('.hr-native-workspace-session-header')
      await until(() => visible(sessionHeader), 'visible Session header')
      const headerBefore = rect(sessionHeader)
      const headerButtons = [...sessionHeader.querySelectorAll('button')].filter(visible)
      const headerButtonBoxes = headerButtons.map(rect)
      const rail = document.querySelector('.hr-native-workspace-list')
      const railBefore = visible(rail) ? rect(rail) : null
      const railButton = rail && [...rail.querySelectorAll('.hr-native-session-row')].find(visible)
      const railButtonBefore = railButton ? rect(railButton) : null
      await openImage()
      const core = backdrop().parentElement
      const initialGeometry = geometry()
      const headerAfter = rect(sessionHeader)
      const headerHitChecks = headerButtons.map((button) => {
        const box = rect(button)
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return Boolean(hit && button.contains(hit))
      })
      const railAfter = visible(rail) ? rect(rail) : null
      const railHit = railButton && visible(railButton) ? pointHit(railButton).inside : null
      const desktopRailStable = railBefore && railAfter
        ? ['left', 'top', 'right', 'bottom', 'width', 'height'].every((key) => Math.abs(railBefore[key] - railAfter[key]) <= 1)
        : null
      const headerStable = ['left', 'top', 'right', 'bottom', 'width', 'height'].every((key) => Math.abs(headerBefore[key] - headerAfter[key]) <= 1)

      const globalToggle = document.querySelector('.hr-topbar .hr-compact-menu > button')
      const globalMenuVisible = visible(globalToggle)
      let menu = { tested: false, stayedOpen: null, availableOutsideOverlay: null, closedByToggle: null }
      if (globalMenuVisible) {
        globalToggle.click()
        await assertWait(() => visible(document.querySelector('.hr-topbar .hr-compact-menu-panel')), 'global menu open over preview')
        const panel = document.querySelector('.hr-topbar .hr-compact-menu-panel')
        menu = {
          tested: true,
          stayedOpen: Boolean(backdrop()),
          availableOutsideOverlay: Boolean(panel && panel.getClientRects().length),
          closedByToggle: false,
        }
        globalToggle.click()
        await assertWait(() => !visible(document.querySelector('.hr-topbar .hr-compact-menu-panel')), 'global menu close')
        menu.closedByToggle = true
      }

      const opener = document.querySelector('.uw-message-attachment-open')
      closeButton().focus()
      await wait(30)
      return {
        headerBefore, headerAfter, headerStable, headerButtonBoxes, headerHitChecks,
        railBefore, railAfter, railButtonBefore, railHit, desktopRailStable,
        initialGeometry, menu, hasOpener: Boolean(opener), coreClass: core?.className,
      }
    })
    assert.ok(observed.initialGeometry, 'image preview geometry should be available')
    assert.ok(observed.initialGeometry.parentIsCore, 'preview portal must be a child of .uw-conversation-core')
    assert.equal(observed.initialGeometry.position, 'absolute')
    assert.ok(observed.initialGeometry.rootMatchesCore, 'backdrop bounds must match the chat core within 1px')
    assert.ok(observed.initialGeometry.panelInside && observed.initialGeometry.imageInside, 'panel and image must stay inside the backdrop')
    assert.ok(observed.initialGeometry.opaque, `backdrop must be opaque (${observed.initialGeometry.backgroundColor})`)
    assert.ok(observed.initialGeometry.panelHit.inside, 'hit-testing the panel center must reach the panel')
    assert.ok(observed.initialGeometry.naturalWidth > 0, 'the full-size PNG must decode')
    assert.equal(observed.initialGeometry.modal, false, 'preview must not claim aria-modal')
    assert.ok(observed.headerStable, 'Session header geometry changed when the preview opened')
    assert.ok(observed.headerHitChecks.length > 0 && observed.headerHitChecks.every(Boolean), 'preview must not intercept Session header buttons')
    if (!viewport.touch) {
      assert.ok(observed.desktopRailStable, 'desktop rail geometry changed when the preview opened')
      assert.equal(observed.railHit, true, 'preview must not intercept desktop rail row hit-testing')
    }
    if (observed.menu.tested) {
      assert.equal(observed.menu.availableOutsideOverlay, true, 'global menu must remain available above/outside the chat overlay')
      assert.equal(observed.menu.stayedOpen, true, 'global menu interaction must leave the image preview open')
      assert.equal(observed.menu.closedByToggle, true, 'global menu must close through its own toggle')
    }

    await client.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    let keyboardNavigation = await evaluate(async function checkNavigationFocus() {
      await new Promise(resolve => setTimeout(resolve, 40))
      const core = document.querySelector('.uw-conversation-core')
      return { previewOpen: Boolean(document.querySelector('.uw-image-lightbox-backdrop')), focusOutsideChat: !core.contains(document.activeElement), focusedTag: document.activeElement.tagName }
    })
    for (let i = 0; keyboardNavigation.focusedTag === 'BODY' && i < 2; i++) {
      await client.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      keyboardNavigation = await evaluate(function checkControlFocus() {
        const core = document.querySelector('.uw-conversation-core')
        return { previewOpen: Boolean(document.querySelector('.uw-image-lightbox-backdrop')), focusOutsideChat: !core.contains(document.activeElement), focusedTag: document.activeElement.tagName }
      })
    }
    assert.equal(keyboardNavigation.focusOutsideChat, true, 'Tab must leave the non-modal preview for surrounding navigation')
    assert.notEqual(keyboardNavigation.focusedTag, 'BODY', 'Tab must reach an actual navigation control')
    assert.equal(keyboardNavigation.previewOpen, true, 'navigation focus must leave the local image visible')

    const escapeResult = await evaluate(async function closeByEscape() {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const until = async (predicate, label) => {
        for (let i = 0; i < 100; i++) { if (predicate()) return; await wait(20) }
        throw new Error(`Timed out waiting for ${label}`)
      }
      const opener = document.querySelector('.uw-message-attachment-open')
      const close = document.querySelector('.uw-image-lightbox-close')
      close.focus()
      return { focused: document.activeElement === close }
    })
    assert.equal(escapeResult.focused, true, 'Escape test must begin with focus on the close button')
    await client.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    const afterEscape = await evaluate(async function waitForEscapeClose() {
      for (let i = 0; i < 100; i++) {
        if (!document.querySelector('.uw-image-lightbox-backdrop')) return { closed: true, openerFocused: document.activeElement?.matches('.uw-message-attachment-open') || false }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      return { closed: false, openerFocused: false }
    })
    assert.deepEqual(afterEscape, { closed: true, openerFocused: true }, 'Escape must close preview and restore opener focus')

    const closeButtonResult = await evaluate(async function reopenAndCloseButton() {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const thumb = document.querySelector('.uw-message-attachment-open')
      thumb.focus(); thumb.click()
      for (let i = 0; i < 100 && !document.querySelector('.uw-image-lightbox-close'); i++) await wait(20)
      const close = document.querySelector('.uw-image-lightbox-close')
      if (!close) throw new Error('Preview did not reopen')
      close.click()
      for (let i = 0; i < 100 && document.querySelector('.uw-image-lightbox-backdrop'); i++) await wait(20)
      return { closed: !document.querySelector('.uw-image-lightbox-backdrop'), openerFocused: document.activeElement === thumb }
    })
    assert.deepEqual(closeButtonResult, { closed: true, openerFocused: true }, 'close button must close and restore focus')

    const resizeResult = await evaluate(async function reopenForResize() {
      const thumb = document.querySelector('.uw-message-attachment-open')
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      thumb.focus(); thumb.click()
      for (let i = 0; i < 100 && !document.querySelector('.uw-image-lightbox-backdrop'); i++) await wait(20)
      const root = document.querySelector('.uw-image-lightbox-backdrop')
      if (!root) throw new Error('Preview did not reopen for resize')
      return { opened: true, rootClass: root.className }
    })
    assert.equal(resizeResult.opened, true)

    const resizedWidth = viewport.height
    const resizedHeight = viewport.width
    await client.call('Emulation.setDeviceMetricsOverride', metrics(resizedWidth, resizedHeight, viewport.touch))
    const resizedGeometry = await evaluate(function checkResizedRoot() {
      const root = document.querySelector('.uw-image-lightbox-backdrop')
      const core = root?.parentElement
      if (!root || !core) return null
      const a = root.getBoundingClientRect(), b = core.getBoundingClientRect()
      return { viewport: { width: innerWidth, height: innerHeight }, root: { left: a.left, top: a.top, right: a.right, bottom: a.bottom }, core: { left: b.left, top: b.top, right: b.right, bottom: b.bottom }, matches: Math.abs(a.left-b.left)<=1 && Math.abs(a.top-b.top)<=1 && Math.abs(a.right-b.right)<=1 && Math.abs(a.bottom-b.bottom)<=1 }
    })
    assert.ok(resizedGeometry?.matches, 'chat preview root must track the rotated/resized viewport geometry')
    await client.call('Emulation.setDeviceMetricsOverride', metrics(viewport.width, viewport.height, viewport.touch))
    const restoredGeometry = await evaluate(function checkRestoredRoot() {
      const root = document.querySelector('.uw-image-lightbox-backdrop')
      const core = root?.parentElement
      if (!root || !core) return null
      const a = root.getBoundingClientRect(), b = core.getBoundingClientRect()
      return { viewport: { width: innerWidth, height: innerHeight }, matches: Math.abs(a.left-b.left)<=1 && Math.abs(a.top-b.top)<=1 && Math.abs(a.right-b.right)<=1 && Math.abs(a.bottom-b.bottom)<=1 }
    })
    assert.ok(restoredGeometry?.matches, 'chat preview root must match the restored viewport geometry')

    // Save a visual artifact with the real PNG preview open and the original viewport restored.
    const safeCase = `${viewport.width}x${viewport.height}-${viewport.theme}-${viewport.touch ? 'touch' : 'desktop'}`
    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
    const prefix = path.join(artifactsDir, `chat-image-preview-${stamp}-${safeCase}`)
    const screenshot = await client.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(`${prefix}.png`, Buffer.from(screenshot.data, 'base64'))

    const backdropClose = await evaluate(async function closeByBackdropMouseDown() {
      const root = document.querySelector('.uw-image-lightbox-backdrop')
      if (!root) return { existed: false, closed: false }
      const box = root.getBoundingClientRect()
      const panel = root.querySelector('.uw-image-lightbox').getBoundingClientRect()
      // The rail resize handle deliberately remains above the chat's outermost edge.
      const point = [[box.left+12,box.top+12],[box.right-12,box.top+12],[box.left+12,box.bottom-12],[box.right-12,box.bottom-12]]
        .find(([x,y]) => document.elementFromPoint(x,y) === root)
      if (!point) throw new Error('No visible backdrop click target')
      const [x,y] = point
      return { existed: true, x, y, outsidePanel: x < panel.left || x > panel.right || y < panel.top || y > panel.bottom }
    })
    assert.equal(backdropClose.existed, true)
    assert.equal(backdropClose.outsidePanel, true, 'backdrop close coordinate must not hit the panel')
    await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: backdropClose.x, y: backdropClose.y })
    await client.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: backdropClose.x, y: backdropClose.y, button: 'left', clickCount: 1 })
    await client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: backdropClose.x, y: backdropClose.y, button: 'left', clickCount: 1 })
    const afterBackdrop = await evaluate(async function waitForBackdropClose() {
      for (let i = 0; i < 100; i++) {
        if (!document.querySelector('.uw-image-lightbox-backdrop')) return true
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      return false
    })
    assert.equal(afterBackdrop, true, 'mousedown on the chat backdrop must close preview')

    const switchResult = await evaluate(async function switchSessionWithPreviewOpen() {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const until = async (predicate, label) => {
        for (let i = 0; i < 300; i++) { if (predicate()) return; await wait(20) }
        throw new Error(`Timed out waiting for ${label}`)
      }
      const thumb = document.querySelector('.uw-message-attachment-open')
      thumb.focus(); thumb.click()
      await until(() => Boolean(document.querySelector('.uw-image-lightbox-backdrop')), 'preview before Session switch')
      const back = document.querySelector('.tdw-mobile-back')
      if (back && back.getClientRects().length) back.click()
      await until(() => [...document.querySelectorAll('.hr-native-session-row')].some((r) => r.textContent.includes('Cached Session B')), 'Session B row')
      const rowB = [...document.querySelectorAll('.hr-native-session-row')].find((r) => r.textContent.includes('Cached Session B'))
      rowB.click()
      await until(() => document.querySelector('.uw-transcript')?.textContent.includes('fixture-B message 200'), 'Session B transcript')
      await wait(80)
      return { previewRemoved: !document.querySelector('.uw-image-lightbox-backdrop'), sessionBVisible: document.querySelector('.uw-transcript')?.textContent.includes('fixture-B message 200') || false }
    })
    assert.deepEqual(switchResult, { previewRemoved: true, sessionBVisible: true }, 'switching Sessions must retire the old preview')

    const summary = {
      status: 'passed', viewport, appURL, initial: observed.initialGeometry,
      headerStable: observed.headerStable, headerButtonHitChecks: observed.headerHitChecks,
      desktopRailStable: observed.desktopRailStable, desktopRailHit: observed.railHit,
      globalMenu: observed.menu, afterResize: resizedGeometry, afterRestore: restoredGeometry,
      keyboardNavigation,
      escape: afterEscape, closeButton: closeButtonResult, backdropMouseDown: afterBackdrop, sessionSwitch: switchResult,
      screenshot: path.basename(`${prefix}.png`),
    }
    assert.deepEqual(client.exceptions, [], 'page must not report uncaught JavaScript exceptions')
    await writeFile(`${prefix}.json`, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' })
    return summary
  } finally {
    client?.close()
    if (browserContextId) await browser.call('Target.disposeBrowserContext', { browserContextId }).catch(() => {})
    browser.close()
  }
}

export async function runChatImagePreviewSmoke() {
  if (!path.isAbsolute(artifactsDir)) throw new Error('HARNESS_UI_ARTIFACTS_DIR must be an absolute path')
  await mkdir(artifactsDir, { recursive: true })
  const results = []
  for (const viewport of viewports) results.push(await runViewport(viewport))
  console.log(JSON.stringify({ status: 'passed', artifactsDir, cases: results.length, results }))
  return results
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runChatImagePreviewSmoke().catch((error) => {
    console.error(error.stack || error.message)
    process.exitCode = 1
  })
}
