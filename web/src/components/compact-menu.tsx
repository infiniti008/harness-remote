import { useEffect, useId, useRef, useState, type ReactNode } from "react"

/** A non-modal disclosure: Tab can leave it, while Escape and outside clicks dismiss it. */
export function CompactMenu({ label, children, closeOnAction = false }: {
  label: string
  children: ReactNode
  closeOnAction?: boolean
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener("pointerdown", outside)
    document.addEventListener("keydown", escape)
    return () => {
      document.removeEventListener("pointerdown", outside)
      document.removeEventListener("keydown", escape)
    }
  }, [open])
  return (
    <div className="hr-compact-menu" ref={root} onBlur={(event) => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }}>
      <button type="button" className="tdw-icon-button" ref={trigger} title={label} aria-label={label}
        aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
        <span aria-hidden="true">⋯</span>
      </button>
      {open ? <div className="hr-compact-menu-panel" id={id} role="region" aria-label={label} onClick={(event) => {
        if (closeOnAction && event.target instanceof Element && event.target.closest("button")) setOpen(false)
      }}>{children}</div> : null}
    </div>
  )
}
