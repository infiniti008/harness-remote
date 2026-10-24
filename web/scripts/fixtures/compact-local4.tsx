import React, { useMemo, useState } from "react"
import { createRoot } from "react-dom/client"
import { TaskDeskConversation } from "../../src/components/taskdesk-conversation"
import { ModelPicker } from "../../src/components/model-picker"
import { ImageLightbox } from "../../src/components/image-lightbox"
import { CodexRateLimitsStatus } from "../../src/components/codex-rate-limits"
import { api } from "../../src/api"
import "../../src/styles.css"
import "../../src/taskdesk-theme.css"
import "../../src/conversation-control-plane-overrides.css"
import "../../src/v3-mobile.css"
import "../../src/session-first-navigation.css"
import "../../src/session-first-workbench.css"
import "../../src/conversation-base.css"
import "../../src/session-handoff-routing.css"
import "../../src/machine-pairing.css"
import "../../src/machine-card-layout.css"
import "../../src/beautiful-ui-controls.css"
import "../../src/activity-timeline.css"
import "../../src/session-header-narrow.css"
import "../../src/compact-workspace.css"

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light"
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="
const config = { backend: "codex", host: "fixture.invalid", port: 0, username: "", password: "", agentId: "codex" } as const
api.loadCodexRateLimits = async () => ({state:"available",updatedAt:Date.now(), buckets:[{id:"codex",windows:[{tier:"primary",usedPercent:0,windowDurationMins:300,resetsAt:1800000000},{tier:"secondary",usedPercent:0,windowDurationMins:10080,resetsAt:1800000000}]}]})
function Fixture() {
  const [revision, setRevision] = useState(1)
  const [working, setWorking] = useState(false)
  const [draft, setDraft] = useState("")
  const [lightbox, setLightbox] = useState(false)
  const [queue, setQueue] = useState([{id:"q1",text:"Update the diagnostics with this longer prompt to check responsive clipping and button fit.",attachmentCount:2,queuedAt:1},{id:"q2",text:"Second queued prompt",attachmentCount:0,queuedAt:2}])
  Object.assign(window, {fixtureQueue:queue})
  const messages = useMemo(() => Array.from({length:60},(_,i) => ({info:{id:`m${i}`,role:"assistant",sessionID:"fixture",time:{created:i+1}},parts:[{type:"text",text:`Message ${i+1}. Synthetic inactive history with enough content to scroll.`}]})),[])
  const model = {providerID:"fixture",modelID:"model",providerName:"Fixture",modelName:"Fixture Model"}
  const action = (value:string) => { Object.assign(window, {fixtureLastAction:value}) }
  return <div className="fixture-shell hr-native-workspace" data-revision={revision}>
    <header><button id="switch-session" onClick={()=>setRevision(v=>v+1)}>Switch cached session</button><button id="start-work" onClick={()=>setWorking(true)}>Start fixture work</button></header>
    <div className="tdw-work-thread-conversation"><TaskDeskConversation
      messages={messages as any} agentLabel="Synthetic Assistant" agentBackend="codex" draft={draft} onDraftChange={setDraft} onSend={()=>action("send")} onStop={()=>setWorking(false)} waiting={working} ready scrollScope="local4-fixture" surfaceViewRevision={revision}
      canSendWhileWaiting attachmentsSupported queuedPrompts={queue} onCancelQueuedPrompt={id=>setQueue(q=>q.filter(e=>e.id!==id))}
      onSendQueuedPromptNow={async id=>{action(`send-now:${id}`);setQueue(q=>q.filter(e=>e.id!==id))}}
      onEditQueuedPrompt={async(id,text)=>{action(`edit:${id}:${text}`);setQueue(q=>q.map(e=>e.id===id?{...e,text}:e));return true}}
      footerHint="New messages wait in the queue"
      composerControls={<div className="uw-composer-routing"><label><span>Harness</span><select aria-label="Harness"><option>PI</option><option>Codex</option></select></label><label className="uw-composer-model"><span>Model</span><ModelPicker compact models={[model]} value="fixture|model|" onChange={()=>{}}/></label></div>}
      composerStatus={<><CodexRateLimitsStatus config={config} agentID="codex"/><span className="tdw-conversation-state" title="Ready" aria-label="Ready"><i aria-hidden="true">●</i><span>Ready</span></span></>}
      renderMessage={message=><div style={{padding:"12px 6px",color:"var(--td3-text)"}}>{message.parts[0]?.text}{message.info.id==="m59"?<button className="uw-message-attachment-open" onClick={()=>setLightbox(true)}>View synthetic image</button>:null}</div>}
    /></div>
    {lightbox?<ImageLightbox src={png} label="Synthetic image" onClose={()=>setLightbox(false)}/>:null}
  </div>
}
createRoot(document.getElementById("root")!).render(<Fixture/> )
