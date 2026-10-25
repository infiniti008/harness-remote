import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"

const ImagePreviewSurface = createContext<HTMLDivElement | null>(null)

/** The transcript and composer own this layer; navigation and session headers stay outside it. */
export function ConversationImageSurface({ children }: { children: ReactNode }) {
  const [surface, setSurface] = useState<HTMLDivElement | null>(null)
  return (
    <div className="uw-conversation-core" ref={setSurface}>
      <ImagePreviewSurface.Provider value={surface}>{children}</ImagePreviewSurface.Provider>
    </div>
  )
}

/**
 * A small, centered lightbox for a single sent image.
 *
 * The source is a `data:` URL carried on the attachment part, so the preview renders bytes already on
 * the page: no network and no clipboard, which keeps it usable on the plain-HTTP LAN the app runs on
 * (a secure-context-only API would be unavailable there).
 *
 * The portal bypasses transcript stacking/scrolling while staying inside the chat's own surface.
 * This is a non-modal dialog: the surrounding navigation remains usable, including with Tab.
 */
export function ImageLightbox({ src, label, onClose }: { src: string; label: string; onClose: () => void }) {
  const surface = useContext(ImagePreviewSurface)
  const panelRef = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const panel = panelRef.current
    if (!surface || !panel) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.querySelector<HTMLButtonElement>("button")?.focus()
    const keydown = (event: KeyboardEvent) => {
      // A menu or dialog outside this chat owns its own Escape key.
      if (event.key !== "Escape" || event.defaultPrevented || !(event.target instanceof Node) || !surface.contains(event.target)) return
      event.preventDefault()
      closeRef.current()
    }
    const focusUnderlyingChat = (event: FocusEvent) => {
      if (event.target instanceof Node && !panel.contains(event.target)) closeRef.current()
    }
    document.addEventListener("keydown", keydown)
    surface.addEventListener("focusin", focusUnderlyingChat)
    return () => {
      document.removeEventListener("keydown", keydown)
      surface.removeEventListener("focusin", focusUnderlyingChat)
      // Do not steal focus back from navigation the user chose while the image was open.
      if (previous?.isConnected && (panel.contains(document.activeElement) || document.activeElement === document.body)) previous.focus()
    }
  }, [surface])

  if (!surface) return null

  return createPortal((
    <div className="uw-image-lightbox-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="uw-image-lightbox"
        role="dialog"
        aria-label="Open image"
        ref={panelRef}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button type="button" className="uw-image-lightbox-close" onClick={onClose} aria-label="Close">×</button>
        <img className="uw-image-lightbox-image" src={src} alt={label} />
        <p className="uw-image-lightbox-caption">{label}</p>
      </section>
    </div>
  ), surface)
}
