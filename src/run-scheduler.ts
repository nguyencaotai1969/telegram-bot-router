export type StopFn = () => void

/** Handed to a running job: whether /stop came, and where to hook the stop of what it starts. */
export interface JobControl {
  readonly stopped: boolean
  onStop(stop: StopFn): void
}

export type Job = (control: JobControl) => Promise<void>

class Control implements JobControl {
  stopped = false
  private stopFn: StopFn | undefined

  onStop(stop: StopFn): void {
    this.stopFn = stop
    if (this.stopped) stop()
  }

  /** Every call stops again: a second /stop retries a kill that did not take. */
  cancel(): void {
    this.stopped = true
    this.stopFn?.()
  }
}

interface Queued {
  job: Job
  /** Told when the job is dropped by /stop before it ran. */
  onDrop?: () => void
}

interface TopicQueue {
  queue: Queued[]
  running: boolean
  current?: Control
}

/** One run at a time per topic (in order), at most `maxParallel` runs across all topics. */
export class RunScheduler {
  private active = 0
  private readonly slotWaiters: Array<() => void> = []
  private readonly topics = new Map<string, TopicQueue>()

  constructor(
    private readonly maxParallel: number,
    private readonly maxQueuedPerTopic = 5,
  ) {}

  /** Queues a job. Returns how many jobs of the topic are ahead of it, or -1 when its queue is full. */
  enqueue(key: string, job: Job, onDrop?: () => void): number {
    let topic = this.topics.get(key)
    if (!topic) {
      topic = { queue: [], running: false }
      this.topics.set(key, topic)
    }
    if (topic.queue.length >= this.maxQueuedPerTopic) return -1
    const ahead = topic.queue.length + (topic.running ? 1 : 0)
    topic.queue.push({ job, onDrop })
    if (!topic.running) void this.drain(key, topic)
    return ahead
  }

  get slotsFull(): boolean {
    return this.active >= this.maxParallel
  }

  get activeCount(): number {
    return this.active
  }

  status(key: string): { busy: boolean; queued: number } {
    const topic = this.topics.get(key)
    return { busy: topic?.running ?? false, queued: topic?.queue.length ?? 0 }
  }

  /** Stops the topic's current job (also one still waiting for a slot) and drops what waits behind it. */
  stop(key: string): { stopped: boolean; dropped: number } {
    const topic = this.topics.get(key)
    if (!topic) return { stopped: false, dropped: 0 }
    const dropped = topic.queue.splice(0)
    for (const item of dropped) notifyDrop(item)
    topic.current?.cancel()
    return { stopped: topic.current !== undefined, dropped: dropped.length }
  }

  stopAll(): void {
    for (const key of [...this.topics.keys()]) this.stop(key)
  }

  private async drain(key: string, topic: TopicQueue): Promise<void> {
    topic.running = true
    try {
      for (let item = topic.queue.shift(); item; item = topic.queue.shift()) {
        const control = new Control()
        topic.current = control
        await this.acquireSlot()
        try {
          if (control.stopped) notifyDrop(item)
          else await item.job(control)
        } catch (err) {
          console.error(`Việc trong topic ${key} lỗi:`, err)
        } finally {
          topic.current = undefined
          this.releaseSlot()
        }
      }
    } finally {
      topic.running = false
      if (topic.queue.length === 0 && this.topics.get(key) === topic) this.topics.delete(key)
    }
  }

  private acquireSlot(): Promise<void> {
    if (this.active < this.maxParallel) {
      this.active++
      return Promise.resolve()
    }
    return new Promise(resolve =>
      this.slotWaiters.push(() => {
        this.active++
        resolve()
      }),
    )
  }

  private releaseSlot(): void {
    this.active--
    this.slotWaiters.shift()?.()
  }
}

function notifyDrop(item: Queued): void {
  try {
    item.onDrop?.()
  } catch (err) {
    console.error('onDrop lỗi:', err)
  }
}
