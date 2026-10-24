// Actual app entry point, CSS shell and native controllers; only transport data is synthetic.
// Use an isolated browser profile. No gateway, credentials or model request is used.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

const cdpURL = process.env.HARNESS_UI_CDP_URL || 'http://[::1]:9223'
const appURL = process.env.HARNESS_UI_APP_URL || 'http://127.0.0.1:4173/'

function installTransport(theme) {
  localStorage.clear()
  localStorage.setItem('opencode.remote.theme', theme)
  localStorage.setItem('opencode.remote.language', 'en')
  const config = { backend: 'codex', host: 'fixture.invalid', port: 1, username: '', password: '' }
  localStorage.setItem('harness-remote.workspace.machines.v1', JSON.stringify([{ id: 'fixture-machine', name: 'Local UI fixture', config }]))
  const now = Date.now()
  const sessions = ['A', 'B'].map((key, i) => ({ id: `fixture-${key}`, title: `Cached Session ${key}`, directory: '/projects/fixture', external: true, time: { created: now - i * 1000, updated: now - i * 1000 } }))
  const agent = { id: 'codex', label: 'Codex', backend: 'codex', transport: 'acp', managed: true, state: 'available', capabilities: { sessions: true, prompt: true, abort: true, streaming: true, models: true, attachments: true }, contract: { sessions: { stop: 'owned-session-native-cancel' } } }
  const models = [{ providerID: 'codex', providerName: 'Codex', modelID: 'fixture-model', modelName: 'Fixture model', isDefault: true, tools: true }]
  const transcripts = Object.fromEntries(sessions.map(session => [session.id, Array.from({ length: 200 }, (_, i) => ({ info: { id: `${session.id}-m${i}`, role: i % 2 ? 'assistant' : 'user', sessionID: session.id, time: { created: now + i } }, parts: [{ id: `${session.id}-p${i}`, type: 'text', text: `Native fixture ${session.id} message ${i + 1}.\n\nSynthetic markdown with a **real renderer**, used to check cached geometry before the first visible frame.\n\n- Detail one\n- Detail two` }] }))]))
  window.fixtureReads = {}
  window.fixtureUnknown = []
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url || String(input), location.href)
    if (url.hostname !== 'fixture.invalid') return originalFetch(input, init)
    const path = url.pathname
    window.fixtureReads[path] = (window.fixtureReads[path] || 0) + 1
    const json = (value, headers = {}) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', ...headers } })
    if (path.endsWith('/global/event')) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(': connected\n\n')); init.signal?.addEventListener('abort', () => controller.close(), { once: true }) } }), { headers: { 'Content-Type': 'text/event-stream' } })
    if (path === '/v1/machine') return json({ machine: { id: 'fixture-machine', name: 'Local UI fixture', createdAt: new Date(now).toISOString() }, agents: [agent] })
    if (path === '/v1/projects') return json({ projects: [{ id: 'fixture-project', machineId: 'fixture-machine', name: 'fixture', path: '/projects/fixture', kind: 'git', configured: true }] })
    if (path.endsWith('/experimental/session')) return json(sessions)
    if (path.endsWith('/session/status')) return json(Object.fromEntries(sessions.map(s => [s.id, { type: 'idle' }])))
    if (path.endsWith('/models')) return json({ models, stale: false, source: 'synthetic' })
    if (path.endsWith('/v1/capabilities')) return json(agent.capabilities)
    if (path.endsWith('/account/rate_limits')) return json({ state: 'available', updatedAt: Date.now(), buckets: [{ id: 'codex', windows: [{ tier: 'primary', usedPercent: 12, windowDurationMins: 300, resetsAt: 1800000000 }, { tier: 'secondary', usedPercent: 34, windowDurationMins: 10080, resetsAt: 1800000000 }] }] })
    const message = path.match(/\/session\/([^/]+)\/message$/)
    if (message) {
      // A cached reopen must paint correctly while this revision revalidation is still pending.
      if (window.fixtureReads[path] > 1) await new Promise(resolve => setTimeout(resolve, 700))
      return json(transcripts[message[1]] || [], { 'X-Has-More': '0' })
    }
    if (path.endsWith('/v1/session-links')) return json({ links: [] })
    if (path.endsWith('/v1/project-outcome')) return json({})
    if (path.endsWith('/command') || path.endsWith('/question') || path.endsWith('/permission') || path.endsWith('/agent')) return json([])
    if (path.endsWith('/global/health')) return json({ healthy: true })
    window.fixtureUnknown.push(path)
    return json({})
  }
}

function connect(url) {
  const socket = new WebSocket(url)
  let id = 0
  const pending = new Map()
  const exceptions = []
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text)
    if (!pending.has(message.id)) return
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    message.error ? reject(new Error(message.error.message)) : resolve(message.result)
  })
  return {
    exceptions,
    ready: new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) }),
    call(method, params = {}) { const key = ++id; socket.send(JSON.stringify({ id: key, method, params })); return new Promise((resolve, reject) => pending.set(key, { resolve, reject })) },
    close() { socket.close() }
  }
}

async function run(width, height, theme, touch = width < 500) {
  const version = await fetch(`${cdpURL}/json/version`).then(r => r.json())
  const browser = connect(version.webSocketDebuggerUrl)
  await browser.ready
  const { browserContextId } = await browser.call('Target.createBrowserContext')
  const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank', browserContextId })
  const tab = (await fetch(`${cdpURL}/json/list`).then(r => r.json())).find(tab => tab.id === targetId)
  const client = connect(tab.webSocketDebuggerUrl)
  await client.ready
  try {
    await client.call('Page.enable')
    await client.call('Runtime.enable')
    await client.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch })
    await client.call('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: 1 })
    await client.call('Page.addScriptToEvaluateOnNewDocument', { source: `(${installTransport.toString()})(${JSON.stringify(theme)})` })
    await client.call('Page.navigate', { url: appURL })
    const evaluate = async expression => {
      const result = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    const result = await evaluate(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const until = async fn => { for(let i=0;i<300;i++){ if(fn())return; await wait(30); } throw new Error('UI timed out: '+document.body.innerText.slice(0,500)); };
      const row = key => [...document.querySelectorAll('.hr-native-session-row')].find(r => r.textContent.includes('Cached Session '+key));
      const back = () => { const b=document.querySelector('.tdw-mobile-back'); if(b && b.getClientRects().length)b.click(); };
      const open = async key => { back(); await until(()=>row(key)); row(key).click(); await until(()=>document.querySelector('.uw-transcript')?.textContent.includes('fixture-'+key+' message 200')); await wait(80); };
      await open('A'); await wait(200); await open('B'); await wait(100);
      back();
      const frames=[]; const started=performance.now(); let done=false;
      const measure=()=> { const t=document.querySelector('.uw-transcript'); if(t?.textContent.includes('fixture-A message 200')) frames.push({ms:Math.round(performance.now()-started),top:t.scrollTop,bottom:t.scrollHeight-t.clientHeight,visible:!!t.getClientRects().length}); if(!done)requestAnimationFrame(measure); };
      requestAnimationFrame(measure); row('A').click(); await wait(1500); done=true;
      const textarea=document.querySelector('.uw-composer-shell textarea'); textarea.focus(); await wait(50);
      const focus={shadow:getComputedStyle(textarea).boxShadow,outline:getComputedStyle(textarea).outlineStyle, outer:getComputedStyle(textarea.closest('.uw-composer-shell')).borderColor};
      textarea.blur();
      const transcript=document.querySelector('.uw-transcript'); transcript.scrollTo({top:0,behavior:'instant'}); await wait(100);
      // Same-session explicit activation is also covered, then a passive refresh must preserve reading.
      back(); row('A').click(); await wait(100);
      const sameSession={top:transcript.scrollTop,bottom:transcript.scrollHeight-transcript.clientHeight};
      transcript.scrollTo({top:0,behavior:'instant'}); await wait(900);
      const readerTop=transcript.scrollTop;
      const file=document.querySelector('input[type=file]');
      const canvas=document.createElement('canvas'); canvas.width=8; canvas.height=8; const context=canvas.getContext('2d'); context.fillStyle='#2468ee';context.fillRect(0,0,8,8);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      const files=new DataTransfer(); files.items.add(new File([blob],'image.png',{type:'image/png'})); file.files=files.files; file.dispatchEvent(new Event('change',{bubbles:true}));
      await until(()=>document.querySelector('.uw-composer-attachment'));
      const attachment=document.querySelector('.uw-composer-attachment').getBoundingClientRect();
      const attachmentSize={height:attachment.height,removeHeight:document.querySelector('.uw-composer-attachment button').getBoundingClientRect().height};
      back(); const trigger=document.querySelector('.hr-topbar .hr-compact-menu>button'); trigger.click(); await wait(50);
      const panel=document.querySelector('.hr-topbar .hr-compact-menu-panel').getBoundingClientRect();
      const labels=[...document.querySelectorAll('.hr-topbar .hr-menu-action-label')].map(e=>e.getBoundingClientRect().left);
      const actions=[...document.querySelectorAll('.hr-topbar .tdw-top-actions>button')].map(e=>({label:e.textContent.trim(),left:e.getBoundingClientRect().left,width:e.getBoundingClientRect().width,display:getComputedStyle(e).display,columns:getComputedStyle(e).gridTemplateColumns,labelLeft:e.querySelector('.hr-menu-action-label').getBoundingClientRect().left}));
      const menu={left:panel.left,right:panel.right,top:panel.top,bottom:panel.bottom,actions,labelsAligned:Math.max(...labels)-Math.min(...labels)<=1,withinViewport:panel.left>=0&&panel.right<=innerWidth&&panel.top>=0&&panel.bottom<=innerHeight};
      return {frames,focus,sameSession,readerTop,attachmentSize,menu,unknown:window.fixtureUnknown,reads:window.fixtureReads,overflow:document.documentElement.scrollWidth>innerWidth};
    })()`)
    console.log(JSON.stringify({ width, height, theme, ...result, frames: {count:result.frames.length,first:result.frames[0],last:result.frames.at(-1),awayFromTail:result.frames.filter(f=>f.visible&&Math.abs(f.top-f.bottom)>1).length} }))
    await writeFile(`/tmp/local5-workspace-${theme}-${width}.png`, Buffer.from((await client.call('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
    assert.deepEqual(client.exceptions, [])
    assert.equal(result.overflow, false)
    assert.equal(result.focus.shadow, 'none')
    assert.equal(result.focus.outline, 'none')
    assert.ok(result.frames.length > 3)
    assert.ok(result.frames.filter(f => f.visible).every(f => Math.abs(f.top - f.bottom) <= 1), 'every visible cached reopen frame must start at tail')
    assert.ok(Math.abs(result.sameSession.top-result.sameSession.bottom)<=1, 'same-session activation must be instant')
    assert.equal(result.readerTop, 0, 'passive updates must leave a reader at the top')
    assert.deepEqual(result.unknown, [], 'all fixture transport routes must be explicit')
    assert.ok(result.attachmentSize.height<=32, 'attachment pill must be compact')
    assert.equal(result.attachmentSize.removeHeight, 24)
    assert.equal(result.menu.labelsAligned, true, 'menu labels must share the same column')
    assert.equal(result.menu.withinViewport, true)
  } finally {
    client.close()
    await browser.call('Target.disposeBrowserContext', { browserContextId }).catch(()=>{})
    browser.close()
  }
}

for (const viewport of [[1440,900,'light'],[390,844,'light'],[1024,768,'light'],[844,390,'light',true],[1440,900,'dark'],[390,844,'dark']]) await run(...viewport)
