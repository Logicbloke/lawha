type Handler<T> = (payload: T) => void

/** Tiny typed emitter — how core notifies state and UI. */
export class Emitter<M> {
  private handlers = new Map<keyof M, Set<Handler<never>>>()

  on<K extends keyof M>(event: K, fn: Handler<M[K]>): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(fn as Handler<never>)
    return () => set.delete(fn as Handler<never>)
  }

  emit<K extends keyof M>(event: K, payload: M[K]): void {
    const set = this.handlers.get(event)
    if (!set) return
    for (const fn of set) (fn as Handler<M[K]>)(payload)
  }
}

export type StrategyState = 'connecting' | 'connected' | 'failed'
