# 06 Slot: turn artifacts

- `TurnItem` renders `TurnPluginArtifacts` between the activity rail and the
  assistant block. It picks tool activity parts whose tool name an enabled
  plugin claims and renders that plugin's component per part.
- No work when no enabled plugin claims a tool (cheap set lookup).
- Deferred body stubs hydrate through `useSessionReducerPart`.

Accept: test that a claimed tool part renders the artifact, unclaimed renders
nothing, and the activity rail still lists the tool.
