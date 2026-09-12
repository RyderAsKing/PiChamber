import { beforeEach, describe, expect, test } from "bun:test"
import {
  createMessageQueueTarget,
  getMessageQueueKey,
  migrateMessageQueueState,
  parseMessageQueueKey,
  useMessageQueueStore,
} from "./messageQueueStore"
import { piClient } from "@/lib/pi/client"
import { getObservedPiStreamEpoch, observePiStreamEpoch } from "@/lib/pi/transport"
import { getRuntimeKey } from "@/lib/runtime-switch"
import type { AttachedFile } from "./types/sessionTypes"

const readyAttachment = (localId: string, attachmentId: string): AttachedFile => ({
  id: localId,
  file: {} as File,
  dataUrl: "data:image/png;base64,AAAA",
  mimeType: "image/png",
  filename: `${localId}.png`,
  size: 10,
  source: "local",
  uploadState: { status: "ready", attachmentId, expiresAt: Date.now() + 3600_000 },
})

beforeEach(() => {
  observePiStreamEpoch(getRuntimeKey(), "epoch-current")
  observePiStreamEpoch("runtime-a", "epoch-a")
  useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} })
})

describe("message queue runtime ownership", () => {
  test("isolates colliding session IDs by runtime and directory", () => {
    const a = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const b = createMessageQueueTarget("session-1", "/repo", "runtime-b")!
    useMessageQueueStore.getState().addToQueue(a, { content: "from A" })
    useMessageQueueStore.getState().addToQueue(b, { content: "from B" })

    expect(useMessageQueueStore.getState().getQueueForTarget(a)[0]?.content).toBe("from A")
    expect(useMessageQueueStore.getState().getQueueForTarget(b)[0]?.content).toBe("from B")
  })

  test("round trips a composite queue key", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    expect(parseMessageQueueKey(getMessageQueueKey(target))).toEqual(target)
  })

  test("quarantines legacy session-only queues instead of activating them", () => {
    const migrated = migrateMessageQueueState({
      queuedMessages: {
        "session-1": [{ id: "queued-1", content: "legacy", createdAt: 1 }],
      },
    }, 1)

    expect(migrated.queuedMessages).toEqual({})
    expect(migrated.quarantinedLegacyMessages?.["session-1"]?.[0]?.content).toBe("legacy")
  })

  test("rejects the 21st message per target without mutating existing entries", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    for (let index = 0; index < 20; index += 1) {
      expect(useMessageQueueStore.getState().addToQueue(target, { content: `message-${index}` })).toBe(true)
    }

    const before = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(before).toHaveLength(20)
    // Bounded capacity rejects before any mutation: no silent eviction of the
    // oldest in-flight/uncertain entry, explicit false instead of truncation.
    expect(useMessageQueueStore.getState().addToQueue(target, { content: "message-20" })).toBe(false)

    const after = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(after).toHaveLength(20)
    expect(after[0]?.content).toBe("message-0")
    expect(after[19]?.content).toBe("message-19")
  })

  test("rejects a 51st new target without dropping existing targets", () => {
    for (let index = 0; index < 50; index += 1) {
      const entryTarget = createMessageQueueTarget(`session-${index}`, "/repo", "runtime-a")!
      expect(useMessageQueueStore.getState().addToQueue(entryTarget, { content: `target-${index}` })).toBe(true)
    }
    expect(Object.keys(useMessageQueueStore.getState().queuedMessages)).toHaveLength(50)

    const extra = createMessageQueueTarget("session-extra", "/repo", "runtime-a")!
    expect(useMessageQueueStore.getState().addToQueue(extra, { content: "extra" })).toBe(false)
    expect(Object.keys(useMessageQueueStore.getState().queuedMessages)).toHaveLength(50)
    expect(useMessageQueueStore.getState().getQueueForTarget(extra)).toHaveLength(0)
    // An existing target below its per-target limit still accepts.
    const existing = createMessageQueueTarget("session-0", "/repo", "runtime-a")!
    expect(useMessageQueueStore.getState().addToQueue(existing, { content: "more" })).toBe(true)
    expect(useMessageQueueStore.getState().getQueueForTarget(existing)).toHaveLength(2)
  })

  test("full queue retains attempts and attachments with no deletion on reject", () => {
    const originalDelete = piClient.deleteAttachment
    const deleted: string[] = []
    piClient.deleteAttachment = (async (id: string) => { deleted.push(id) }) as typeof piClient.deleteAttachment
    try {
      // Current runtime so attachment cleanup would run if it were (incorrectly) triggered.
      const target = createMessageQueueTarget("session-1", "/repo")!
      for (let index = 0; index < 20; index += 1) {
        const ok = useMessageQueueStore.getState().addToQueue(target, {
          content: `m-${index}`,
          attachments: index === 0 ? [readyAttachment("local-0", "att-0")] : undefined,
        })
        expect(ok).toBe(true)
      }
      const queue = useMessageQueueStore.getState().getQueueForTarget(target)
      useMessageQueueStore.getState().markDeliveryAttempt(target, queue[0]!.id, "followUp")
      deleted.length = 0

      const snapshot = JSON.stringify(useMessageQueueStore.getState().getQueueForTarget(target))
      expect(useMessageQueueStore.getState().addToQueue(target, { content: "overflow" })).toBe(false)
      // No mutation and no side-effect cleanup on rejection.
      expect(JSON.stringify(useMessageQueueStore.getState().getQueueForTarget(target))).toBe(snapshot)
      expect(deleted).toEqual([])
      const retained = useMessageQueueStore.getState().getQueueForTarget(target)
      expect(retained).toHaveLength(20)
      expect(retained[0]?.deliveryAttempt).toEqual({ kind: "followUp", operationId: retained[0]!.id, streamEpoch: "epoch-current" })
      expect(retained[0]?.attachments?.[0]?.uploadState?.status).toBe("ready")
      const retainedUpload = retained[0]?.attachments?.[0]?.uploadState
      expect(retainedUpload && "attachmentId" in retainedUpload ? retainedUpload.attachmentId : undefined).toBe("att-0")
    } finally {
      piClient.deleteAttachment = originalDelete
    }
  })
})

describe("atomic follow-up claims", () => {
  test("duplicate claim for the same id returns null for the second claimant", () => {
    const target = createMessageQueueTarget("session-1", "/repo", getRuntimeKey())!
    useMessageQueueStore.getState().addToQueue(target, { content: "first" })
    const [first] = useMessageQueueStore.getState().getQueueForTarget(target)

    const firstClaim = useMessageQueueStore.getState().claimQueuedMessage(target, first.id)
    expect(firstClaim?.id).toBe(first.id)

    const secondClaim = useMessageQueueStore.getState().claimQueuedMessage(target, first.id)
    expect(secondClaim).toBeNull()
    expect(useMessageQueueStore.getState().getSendableQueue(target)).toHaveLength(0)
    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(1)
  })

  test("auto candidate returns the oldest sendable; a claim hides it from later claimants", () => {
    const target = createMessageQueueTarget("session-1", "/repo", getRuntimeKey())!
    useMessageQueueStore.getState().addToQueue(target, { content: "first" })
    useMessageQueueStore.getState().addToQueue(target, { content: "second" })

    const first = useMessageQueueStore.getState().getAutoSendCandidate(target)
    expect(first?.content).toBe("first")
    expect(useMessageQueueStore.getState().claimQueuedMessage(target, first!.id)?.id).toBe(first!.id)
    // A claimed id is sending: the candidate holds (FIFO) instead of skipping
    // to the next entry while a delivery is uncertain.
    expect(useMessageQueueStore.getState().getAutoSendCandidate(target)).toBeNull()
    expect(useMessageQueueStore.getState().claimQueuedMessage(target, first!.id)).toBeNull()
  })

  test("claim reads the latest store, not a stale snapshot", () => {
    const target = createMessageQueueTarget("session-1", "/repo", getRuntimeKey())!
    useMessageQueueStore.getState().addToQueue(target, { content: "first" })
    const staleSnapshot = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(staleSnapshot).toHaveLength(1)
    useMessageQueueStore.getState().addToQueue(target, { content: "second" })

    const candidate = useMessageQueueStore.getState().getAutoSendCandidate(target)
    expect(candidate?.content).toBe("first")
    const claimed = useMessageQueueStore.getState().claimQueuedMessage(target, candidate!.id)
    expect(claimed?.content).toBe("first")
    // The stale snapshot still has length 1, but the live store has 2 — the
    // claim must have come from live state.
    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(2)
  })

  test("completing only the captured id preserves entries queued during awaits", () => {
    const target = createMessageQueueTarget("session-1", "/repo", getRuntimeKey())!
    useMessageQueueStore.getState().addToQueue(target, { content: "first" })
    const [first] = useMessageQueueStore.getState().getQueueForTarget(target)
    const claimed = useMessageQueueStore.getState().claimQueuedMessage(target, first.id)
    expect(claimed?.id).toBe(first.id)

    // A new follow-up arrives while the first send awaits the server.
    useMessageQueueStore.getState().addToQueue(target, { content: "second" })
    // Plain removal refuses a claimed id so pending uploads survive; only the
    // completion path may remove it.
    useMessageQueueStore.getState().removeFromQueue(target, claimed!.id)
    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(2)
    useMessageQueueStore.getState().completeQueuedSend(target, claimed!.id)

    const remaining = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.content).toBe("second")
  })

  test("clearSending releases the claim so an explicit retry can proceed", () => {
    const target = createMessageQueueTarget("session-1", "/repo", getRuntimeKey())!
    useMessageQueueStore.getState().addToQueue(target, { content: "first" })
    const [first] = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(useMessageQueueStore.getState().claimQueuedMessage(target, first.id)?.id).toBe(first.id)
    expect(useMessageQueueStore.getState().claimQueuedMessage(target, first.id)).toBeNull()
    useMessageQueueStore.getState().clearSending(target, first.id)
    expect(useMessageQueueStore.getState().claimQueuedMessage(target, first.id)?.id).toBe(first.id)
  })

  test("captured sendConfig is preserved as-is; absent variant stays absent", () => {
    const target = createMessageQueueTarget("session-1", "/repo", getRuntimeKey())!
    useMessageQueueStore.getState().addToQueue(target, {
      content: "first",
      sendConfig: { providerID: "cap-p", modelID: "cap-m" },
    })
    const [first] = useMessageQueueStore.getState().getQueueForTarget(target)
    const claimed = useMessageQueueStore.getState().claimQueuedMessage(target, first.id)
    expect(claimed?.sendConfig?.providerID).toBe("cap-p")
    expect(claimed?.sendConfig?.modelID).toBe("cap-m")
    expect(claimed?.sendConfig?.variant).toBe(undefined)
  })
})

describe("in-flight queued sends", () => {
  test("hides a dispatched message from the sendable queue but keeps it visible", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "first" })
    store.addToQueue(target, { content: "second" })
    const [first] = useMessageQueueStore.getState().getQueueForTarget(target)

    useMessageQueueStore.getState().markSending(target, first.id)

    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(2)
    const sendable = useMessageQueueStore.getState().getSendableQueue(target)
    expect(sendable).toHaveLength(1)
    expect(sendable[0]?.content).toBe("second")

    useMessageQueueStore.getState().clearSending(target, first.id)
    expect(useMessageQueueStore.getState().getSendableQueue(target)).toHaveLength(2)
    expect(useMessageQueueStore.getState().sendingIds).toEqual({})
  })

  test("clearQueue retains a message whose send is still awaiting the server", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "in flight" })
    store.addToQueue(target, { content: "merged by composer" })
    const [inFlight] = useMessageQueueStore.getState().getQueueForTarget(target)
    useMessageQueueStore.getState().markSending(target, inFlight.id)

    useMessageQueueStore.getState().clearQueue(target)

    const remaining = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.id).toBe(inFlight.id)
  })

  test("clearQueue drops everything once no send is in flight", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    useMessageQueueStore.getState().addToQueue(target, { content: "queued" })

    useMessageQueueStore.getState().clearQueue(target)

    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(0)
  })
})

describe("durable delivery attempts", () => {
  test("markDeliveryAttempt persists kind + stable operationId and blocks claims", () => {
    const target = createMessageQueueTarget("session-1", "/repo", getRuntimeKey())!
    useMessageQueueStore.getState().addToQueue(target, { content: "first" })
    const [first] = useMessageQueueStore.getState().getQueueForTarget(target)

    useMessageQueueStore.getState().markDeliveryAttempt(target, first.id, "followUp")
    const stored = useMessageQueueStore.getState().getQueueForTarget(target)[0]
    expect(stored?.deliveryAttempt).toEqual({ kind: "followUp", operationId: first.id, streamEpoch: "epoch-current" })
    expect(stored?.sendFailed).toBe(undefined)
    // An uncertain attempt refuses a new claim: Check status first, never a
    // cross-kind resend (receipt key includes kind).
    expect(useMessageQueueStore.getState().claimQueuedMessage(target, first.id)).toBeNull()
    expect(useMessageQueueStore.getState().getAutoSendCandidate(target)).toBeNull()
  })

  test("confirmed rejection clears the attempt but persists a fixed failure label", () => {
    const target = createMessageQueueTarget("session-1", "/repo", getRuntimeKey())!
    useMessageQueueStore.getState().addToQueue(target, { content: "first" })
    const [first] = useMessageQueueStore.getState().getQueueForTarget(target)
    useMessageQueueStore.getState().markDeliveryAttempt(target, first.id, "steer")

    useMessageQueueStore.getState().markSendFailed(target, first.id)
    const stored = useMessageQueueStore.getState().getQueueForTarget(target)[0]
    expect(stored?.deliveryAttempt).toBe(undefined)
    expect(stored?.sendFailed).toBe(true)
    // A confirmed failure never stores raw error text.
    expect(JSON.stringify(stored)).not.toContain("timeout")
  })

  test("unconfirmed error retains the attempt for reload hold", () => {
    const target = createMessageQueueTarget("session-1", "/repo", getRuntimeKey())!
    useMessageQueueStore.getState().addToQueue(target, { content: "first" })
    const [first] = useMessageQueueStore.getState().getQueueForTarget(target)
    useMessageQueueStore.getState().markDeliveryAttempt(target, first.id, "followUp")

    useMessageQueueStore.getState().markSendUnconfirmed(target, first.id, "followUp")
    const stored = useMessageQueueStore.getState().getQueueForTarget(target)[0]
    expect(stored?.deliveryAttempt).toEqual({ kind: "followUp", operationId: first.id, streamEpoch: "epoch-current" })
    expect(stored?.sendFailed).toBe(undefined)
    expect(useMessageQueueStore.getState().getAutoSendCandidate(target)).toBeNull()
  })

  test("missing or stale epochs hold until an explicit new intent is created", () => {
    const target = createMessageQueueTarget("session-1", "/repo", getRuntimeKey())!
    useMessageQueueStore.getState().addToQueue(target, { content: "first" })
    const [first] = useMessageQueueStore.getState().getQueueForTarget(target)
    useMessageQueueStore.setState((state) => ({
      queuedMessages: {
        ...state.queuedMessages,
        [getMessageQueueKey(target)]: [{ ...first, deliveryAttempt: { kind: "followUp", operationId: first.id } }],
      },
    }))

    expect(useMessageQueueStore.getState().claimQueuedMessage(target, first.id)).toBeNull()
    expect(useMessageQueueStore.getState().getAutoSendCandidate(target)).toBeNull()

    const newId = useMessageQueueStore.getState().requeueWithNewIntent(target, first.id)
    expect(newId).not.toBeNull()
    expect(newId).not.toBe(first.id)
    const requeued = useMessageQueueStore.getState().getQueueForTarget(target)[0]
    expect(requeued?.id).toBe(newId)
    expect(requeued?.deliveryAttempt).toBeUndefined()
    expect(getObservedPiStreamEpoch(target.runtimeKey)).toBe("epoch-current")
    expect(useMessageQueueStore.getState().getAutoSendCandidate(target)?.id).toBe(newId)
  })

  test("auto candidate skips a failed head but holds behind an uncertain head (FIFO)", () => {
    const target = createMessageQueueTarget("session-1", "/repo", getRuntimeKey())!
    useMessageQueueStore.getState().addToQueue(target, { content: "first" })
    useMessageQueueStore.getState().addToQueue(target, { content: "second" })
    const [first, second] = useMessageQueueStore.getState().getQueueForTarget(target)

    useMessageQueueStore.getState().markSendFailed(target, first.id)
    // A failed entity never blocks unrelated later entries.
    expect(useMessageQueueStore.getState().getAutoSendCandidate(target)?.id).toBe(second.id)
    // An explicit Steer may still claim the failed entry.
    expect(useMessageQueueStore.getState().claimQueuedMessage(target, first.id)?.id).toBe(first.id)
    useMessageQueueStore.getState().clearSending(target, first.id)

    useMessageQueueStore.getState().markDeliveryAttempt(target, first.id, "followUp")
    // A new attempt clears the failure label and holds the queue (safe FIFO).
    expect(useMessageQueueStore.getState().getQueueForTarget(target)[0]?.sendFailed).toBe(undefined)
    expect(useMessageQueueStore.getState().getAutoSendCandidate(target)).toBeNull()
  })

  test("pop and remove refuse a sending id; completion removes it", () => {
    const target = createMessageQueueTarget("session-1", "/repo", getRuntimeKey())!
    useMessageQueueStore.getState().addToQueue(target, { content: "first" })
    const [first] = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(useMessageQueueStore.getState().claimQueuedMessage(target, first.id)?.id).toBe(first.id)

    expect(useMessageQueueStore.getState().popToInput(target, first.id)).toBeNull()
    useMessageQueueStore.getState().removeFromQueue(target, first.id)
    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(1)

    useMessageQueueStore.getState().completeQueuedSend(target, first.id)
    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(0)
    expect(useMessageQueueStore.getState().sendingIds).toEqual({})
  })
})

describe("clear retention for in-flight and uncertain deliveries", () => {
  test("clearQueue retains sending and uncertain entries and never deletes their attachments", () => {
    const originalDelete = piClient.deleteAttachment
    const deleted: string[] = []
    piClient.deleteAttachment = (async (id: string) => { deleted.push(id) }) as typeof piClient.deleteAttachment
    try {
      const target = createMessageQueueTarget("session-clear", "/repo")!
      expect(useMessageQueueStore.getState().addToQueue(target, {
        content: "ordinary",
        attachments: [readyAttachment("local-ordinary", "att-ordinary")],
      })).toBe(true)
      expect(useMessageQueueStore.getState().addToQueue(target, {
        content: "sending",
        attachments: [readyAttachment("local-sending", "att-sending")],
      })).toBe(true)
      expect(useMessageQueueStore.getState().addToQueue(target, {
        content: "uncertain",
        attachments: [readyAttachment("local-uncertain", "att-uncertain")],
      })).toBe(true)
      const [, sending, uncertain] = useMessageQueueStore.getState().getQueueForTarget(target)
      expect(sending).toBeDefined()
      expect(uncertain).toBeDefined()
      expect(useMessageQueueStore.getState().claimQueuedMessage(target, sending.id)?.id).toBe(sending.id)
      useMessageQueueStore.getState().markDeliveryAttempt(target, uncertain.id, "followUp")
      deleted.length = 0

      useMessageQueueStore.getState().clearQueue(target)

      const remaining = useMessageQueueStore.getState().getQueueForTarget(target)
      expect(remaining.map((entry) => entry.id).sort()).toEqual([sending.id, uncertain.id].sort())
      // Only the ordinary display entry may delete uploads; potential SDK
      // bytes for sending/uncertain are never deleted.
      expect(deleted).toEqual(["att-ordinary"])
      expect(useMessageQueueStore.getState().getAutoSendCandidate(target)).toBeNull()
    } finally {
      piClient.deleteAttachment = originalDelete
    }
  })

  test("clearAllQueues retains sending and uncertain across targets and only deletes ordinary attachments", () => {
    const originalDelete = piClient.deleteAttachment
    const deleted: string[] = []
    piClient.deleteAttachment = (async (id: string) => { deleted.push(id) }) as typeof piClient.deleteAttachment
    try {
      const targetA = createMessageQueueTarget("session-a", "/repo")!
      const targetB = createMessageQueueTarget("session-b", "/repo")!
      expect(useMessageQueueStore.getState().addToQueue(targetA, {
        content: "a-ordinary",
        attachments: [readyAttachment("local-a-ordinary", "att-a-ordinary")],
      })).toBe(true)
      expect(useMessageQueueStore.getState().addToQueue(targetA, {
        content: "a-uncertain",
        attachments: [readyAttachment("local-a-uncertain", "att-a-uncertain")],
      })).toBe(true)
      expect(useMessageQueueStore.getState().addToQueue(targetB, {
        content: "b-sending",
        attachments: [readyAttachment("local-b-sending", "att-b-sending")],
      })).toBe(true)
      expect(useMessageQueueStore.getState().addToQueue(targetB, {
        content: "b-ordinary",
        attachments: [readyAttachment("local-b-ordinary", "att-b-ordinary")],
      })).toBe(true)
      const queueA = useMessageQueueStore.getState().getQueueForTarget(targetA)
      const aUncertain = queueA[1]!
      const queueB = useMessageQueueStore.getState().getQueueForTarget(targetB)
      const bSending = queueB[0]!
      expect(useMessageQueueStore.getState().claimQueuedMessage(targetB, bSending.id)?.id).toBe(bSending.id)
      useMessageQueueStore.getState().markDeliveryAttempt(targetA, aUncertain.id, "steer")
      deleted.length = 0

      useMessageQueueStore.getState().clearAllQueues()

      const remainingA = useMessageQueueStore.getState().getQueueForTarget(targetA)
      const remainingB = useMessageQueueStore.getState().getQueueForTarget(targetB)
      expect(remainingA).toHaveLength(1)
      expect(remainingA[0]?.id).toBe(aUncertain.id)
      expect(remainingB).toHaveLength(1)
      expect(remainingB[0]?.id).toBe(bSending.id)
      expect(deleted.sort()).toEqual(["att-a-ordinary", "att-b-ordinary"].sort())
      // Retained sending claims stay so completion can still resolve.
      expect(useMessageQueueStore.getState().sendingIds[getMessageQueueKey(targetB)]).toEqual([bSending.id])
    } finally {
      piClient.deleteAttachment = originalDelete
    }
  })
})

describe("explicit removal preserves uncertain server bytes", () => {
  test("removing an uncertain entry drops display but never deletes its upload", () => {
    const originalDelete = piClient.deleteAttachment
    const deleted: string[] = []
    piClient.deleteAttachment = (async (id: string) => { deleted.push(id) }) as typeof piClient.deleteAttachment
    try {
      const target = createMessageQueueTarget("session-remove", "/repo")!
      expect(useMessageQueueStore.getState().addToQueue(target, {
        content: "uncertain",
        attachments: [readyAttachment("local-u", "att-u")],
      })).toBe(true)
      const [entry] = useMessageQueueStore.getState().getQueueForTarget(target)
      useMessageQueueStore.getState().markDeliveryAttempt(target, entry.id, "followUp")
      deleted.length = 0

      useMessageQueueStore.getState().removeFromQueue(target, entry.id)
      expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(0)
      expect(deleted).toEqual([])
    } finally {
      piClient.deleteAttachment = originalDelete
    }
  })

  test("removing an ordinary entry deletes its upload", () => {
    const originalDelete = piClient.deleteAttachment
    const deleted: string[] = []
    piClient.deleteAttachment = (async (id: string) => { deleted.push(id) }) as typeof piClient.deleteAttachment
    try {
      const target = createMessageQueueTarget("session-remove-ordinary", "/repo")!
      expect(useMessageQueueStore.getState().addToQueue(target, {
        content: "ordinary",
        attachments: [readyAttachment("local-o", "att-o")],
      })).toBe(true)
      const [entry] = useMessageQueueStore.getState().getQueueForTarget(target)
      deleted.length = 0

      useMessageQueueStore.getState().removeFromQueue(target, entry.id)
      expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(0)
      expect(deleted).toEqual(["att-o"])
    } finally {
      piClient.deleteAttachment = originalDelete
    }
  })
})
