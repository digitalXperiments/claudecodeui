# Chat scroll regression checks

## Contract

- Wheel, touch, PageUp/Home and scrollbar input stop automatic following immediately.
- Only returning to the bottom or explicitly sending/jumping resumes following.
- Growth above the reading position preserves the visible row; growth below does not move it.
- Resize notifications delivered before scroll events must preserve intervening user movement.
- Jump to latest retains loaded history.
- User input and session changes cancel pending search navigation.
- Streaming, reasoning and tool boundaries keep event order and the originating provider.
- Finalizing/reusing a stream buffer keeps the completed row's React key stable.

## Automated checks

Run the chat tests and store merge/pagination tests:

```sh
npx tsx --test 'src/components/chat/**/*.test.ts' 'src/components/chat/**/*.test.tsx' src/stores/sessionStoreMerge.test.ts src/stores/sessionMessagePagination.test.ts
```

`transcriptScrollController.test.ts` exercises event timing, near-bottom gestures,
scrollbar movement, navigation cancellation and hidden panes. `useChatMessages.test.ts`
covers stable history references, tool-result invalidation, stream keys and absent
result content.

## Browser audit (2026-09-15)

A temporary Vite fixture used the real `useSessionStore`, `useChatSessionState`,
`useChatRealtimeHandlers`, `useLazyRowObserver`, and `LazyMessageRow` with mocked
history responses and 1,500 variable-height messages.

- Eight upward-scroll passes: zero measured drift after settling.
- PageUp followed by streamed text: zero visible-row drift.
- Load-all preserved the visible row within 0.5 CSS pixels; 19 message bodies
  were mounted out of 1,500 wrappers during history reading.
- A 20px upward gesture stayed detached when text and tool frames arrived.
- Delayed search/history followed by wheel input: reading remained active and
  the search target was not highlighted or revisited.
- Simulated Claude, Codex, Grok, Kimi, Kilo, Cursor and OpenCode frames all produced
  text → tool → thinking → text, preserving provider attribution and render identity.

This validates shared client behavior, not provider adapters, live CLI execution,
or a hardware/mobile-browser performance benchmark.
