import { useState } from 'react'

/** A "+ label" button that turns into a one-line name input. */
export function NewThing({ placeholder, onCreate, label }: { placeholder: string; label: string; onCreate: (name: string) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  if (!open) {
    return (
      <button className="side-add" onClick={() => setOpen(true)}>
        <span aria-hidden="true">+</span> {label}
      </button>
    )
  }
  return (
    <form
      className="side-new"
      onSubmit={(e) => {
        e.preventDefault()
        if (!name.trim()) return
        onCreate(name.trim())
        setName('')
        setOpen(false)
      }}
    >
      <input
        autoFocus
        value={name}
        maxLength={80}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => !name && setOpen(false)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      />
    </form>
  )
}
