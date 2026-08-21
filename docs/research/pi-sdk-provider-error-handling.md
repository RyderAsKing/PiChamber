# Pi SDK provider error handling in PiChamber

Date: 2026-04-16  
PiChamber dependency reviewed: `@earendil-works/pi-coding-agent@0.84.1`

## Findings

### Pi normalizes provider failures into assistant messages

Provider adapters generally finish with an assistant message whose `stopReason` is `"error"` and whose `errorMessage` contains the provider or transport failure. `AgentSession` persists and emits that assistant message through `message_end`; `agent_end` then includes a `willRetry` flag computed before listeners receive it.

Sources:

- [`AgentSessionEvent` and retry event types](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/agent-session.ts)
- [`Agent` error-state handling](https://github.com/earendil-works/pi/blob/v0.84.1/packages/agent-core/src/agent.ts)
- [OpenAI-compatible stream finalization, including missing `finish_reason`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/src/api/openai-completions.ts)

### Pi has two bounded retry layers

1. Provider-request establishment can retry HTTP 408, 409, 429, 5xx, network failures, and provider-directed `x-should-retry`, using `Retry-After` when present. The provider retry delay is abortable and capped at 60 seconds by default.
2. `AgentSession` can retry a failed assistant turn. Retry is enabled by default, with three retries and exponential delays starting at two seconds. It excludes context overflow (handled by compaction) and deterministic quota/billing/account-limit failures.

The turn-level retry emits:

- `agent_end` with `willRetry: true` for the failed attempt;
- `auto_retry_start` with `attempt`, `maxAttempts`, `delayMs`, and `errorMessage`;
- another agent attempt after the delay;
- `auto_retry_end` after success, exhaustion, or cancellation;
- `agent_settled` only after the entire run, including retry handling, is finished.

Sources:

- [Provider request retry policy](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/src/utils/provider-retry.ts)
- [Retryable versus non-retryable assistant errors](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/src/utils/retry.ts)
- [Agent-session retry orchestration](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/agent-session.ts)
- [Settings defaults](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/settings-manager.ts)
- [SDK lifecycle documentation](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/sdk.md)

### PiChamber was collapsing retryable failures into terminal errors

The daemon subscribed to Pi session events but did not map `auto_retry_start` or `auto_retry_end`. It also published `session.error` for every assistant error in `agent_end`, without checking Pi's `willRetry` flag. As a result, a transient provider failure was presented as terminal before Pi's retry began, the reducer completed the in-flight assistant/tool state, and the UI never received the retry attempt, countdown, or error context even though those fields already exist in PiChamber's public `session.lifecycle` contract.

Relevant PiChamber code:

- `packages/web/server/lib/pi/session-daemon/session-daemon.js`
- `packages/ui/src/lib/pi/protocol.ts`
- `packages/ui/src/lib/pi/event-reducer.ts`
- `packages/ui/src/components/chat/ChatContainer.tsx`
- `packages/ui/src/components/chat/message/parts/WorkingPlaceholder.tsx`

## Recommended behavior

1. Treat `agent_end.willRetry` as authoritative: do not publish terminal `session.error` for that failed attempt.
2. Map `auto_retry_start` to `session.lifecycle { state: "retry", attempt, next, message }`. This uses PiChamber's existing retry overlay and countdown while keeping the run active.
3. Keep `agent_settled` as the authoritative idle boundary.
4. On exhausted or non-retryable failures, keep the assistant error inline, settle active tools and timing, and leave the composer responsive. The existing composer model picker lets the user select another authenticated model and send the next turn in the same session.
5. Avoid automatic model failover. Provider/model choice affects cost, privacy, capability, and credentials; recovery should remain an explicit user action.
6. In a later UX refinement, classify sanitized terminal errors into transient, authentication, quota/billing, context, and unknown categories so the UI can offer focused actions such as retry, re-authenticate, or choose another model without parsing provider text in React.

## Implemented scope

The initial fix maps Pi's retry lifecycle and suppresses premature terminal errors. It deliberately preserves raw, redacted provider error text and existing terminal-error rendering; it does not add speculative cross-provider failover or a new public error taxonomy.
