import { describe, expect, test } from 'bun:test'
import { RunScheduler } from '../src/run-scheduler'

describe('run scheduler', () => {
  test('keeps each topic in order and never runs more than the limit', async () => {
    const scheduler = new RunScheduler(2)
    const order: string[] = []
    let running = 0
    let peak = 0
    const job = (name: string) => async () => {
      running++
      peak = Math.max(peak, running)
      await Bun.sleep(30)
      order.push(name)
      running--
    }
    for (const topic of ['a', 'b', 'c']) for (const n of [1, 2]) scheduler.enqueue(topic, job(`${topic}${n}`))
    while (scheduler.activeCount > 0 || ['a', 'b', 'c'].some(t => scheduler.status(t).busy)) await Bun.sleep(10)
    expect(peak).toBe(2)
    for (const topic of ['a', 'b', 'c']) expect(order.indexOf(`${topic}1`)).toBeLessThan(order.indexOf(`${topic}2`))
    expect(order).toHaveLength(6)
  })

  test('reports how many jobs are ahead and refuses a full queue', () => {
    const scheduler = new RunScheduler(1, 2)
    const forever = () => new Promise<void>(() => {})
    expect(scheduler.enqueue('t', forever)).toBe(0)
    expect(scheduler.enqueue('t', forever)).toBe(1)
    expect(scheduler.enqueue('t', forever)).toBe(2)
    expect(scheduler.enqueue('t', forever)).toBe(-1)
  })

  test('stop calls the running job, drops the queue and tells the dropped job', async () => {
    const scheduler = new RunScheduler(1)
    let stopped = false
    let secondRan = false
    let dropped = false
    scheduler.enqueue('t', control => new Promise<void>(resolve => control.onStop(() => ((stopped = true), resolve()))))
    scheduler.enqueue(
      't',
      async () => {
        secondRan = true
      },
      () => (dropped = true),
    )
    await Bun.sleep(10)
    expect(scheduler.stop('t')).toEqual({ stopped: true, dropped: 1 })
    expect(stopped).toBe(true)
    expect(dropped).toBe(true)
    await Bun.sleep(20)
    expect(secondRan).toBe(false)
    expect(scheduler.status('t').busy).toBe(false)
  })

  test('a job stopped before it hooked its stop sees control.stopped and is stopped on hook', async () => {
    const scheduler = new RunScheduler(1)
    let hookedStopRan = false
    let sawStopped = false
    scheduler.enqueue('t', async control => {
      await Bun.sleep(30) // e.g. downloading a photo
      sawStopped = control.stopped
      control.onStop(() => (hookedStopRan = true))
    })
    await Bun.sleep(5)
    scheduler.stop('t')
    await Bun.sleep(60)
    expect(sawStopped).toBe(true)
    expect(hookedStopRan).toBe(true)
  })

  test('a job stopped while it waits for a slot never starts', async () => {
    const scheduler = new RunScheduler(1)
    let release!: () => void
    let waitingRan = false
    scheduler.enqueue('a', () => new Promise<void>(resolve => (release = resolve)))
    scheduler.enqueue('b', async () => {
      waitingRan = true
    })
    await Bun.sleep(10)
    expect(scheduler.stop('b')).toEqual({ stopped: true, dropped: 0 })
    release()
    await Bun.sleep(20)
    expect(waitingRan).toBe(false)
    expect(scheduler.activeCount).toBe(0)
  })
})
