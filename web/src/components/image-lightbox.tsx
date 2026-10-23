import { useRef } from "react"
import { useDialogDismiss } from "../useDialogDismiss"

/**
 * A small, centered lightbox for a single sent image.
 *
 * The source is a `data:` URL carried on the attachment part, so the preview renders bytes already on
 * the page: no network and no clipboard, which keeps it usable on the plain-HTTP LAN the app runs on
 * (a secure-context-only API would be unavailable there).
 *
 * It reuses the shell's shared dialog machinery — a fixed backdrop that closes on its own mousedown, a
 * centered `role="dialog"` panel, and `useDialogDismiss` for Escape-to-close, the focus trap, and
 * returning focus to the control that opened it — the same behaviour the machine manager and its
 * pairing card run on, rather than a new ad-hoc popup.
 */
export function ImageLightbox({ src, label, onClose }: { src: string; label: string; onClose: () => void }) {
  const panelRef = useRef<HTMLElement>(null)
  // autoFocus lands a keyboard user on the close control and arms the hook's Escape listener on mount.
  useDialogDismiss(panelRef, onClose, { autoFocus: true })

  return (
    <div className="uw-image-lightbox-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="uw-image-lightbox"
        role="dialog"
        aria-modal="true"
        aria-label="Open image"
        ref={panelRef}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button type="button" className="uw-image-lightbox-close" onClick={onClose} aria-label="Close">×</button>
        <img className="uw-image-lightbox-image" src={src} alt={label} />
        <p className="uw-image-lightbox-caption">{label}</p>
      </section>
    </div>
  )
}
