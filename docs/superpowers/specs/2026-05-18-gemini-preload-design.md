# Gemini Preload Design

## Summary

Add a single Gemini preload page for `gemini + generate_image` tasks without changing the meaning of the existing task execution flow. When the system is idle, the extension should keep one Gemini tab open in a ready state: Gemini app loaded, image mode selected, and `Pro` model selected. When a matching task arrives, the extension should reuse that tab directly. For any other task, the extension should close the preload tab and continue with the existing new-tab execution flow. After any task finishes, the extension should recreate the preload tab.

## Goals

- Keep exactly one Gemini preload tab while the system is idle.
- Reuse the preload tab only for `source=gemini` and `action=generate_image`.
- Leave the existing formal task execution semantics unchanged.
- Ensure preload failure never blocks normal task execution.
- Restore the preload tab automatically after any task finishes.

## Non-Goals

- No multi-task or multi-tab Gemini concurrency support.
- No reuse for ChatGPT tasks, Gemini text tasks, or Gemini video tasks.
- No redesign of `taskRegistry`, download interception, or WebSocket payload formats.
- No forced new conversation before every reused Gemini image task.

## Confirmed Constraints

- The system is single-task only.
- Gemini and ChatGPT will not run at the same time.
- Gemini will not run multiple tasks concurrently.
- Only one preload tab is needed.
- If a task is not `gemini + generate_image`, the preload tab should be closed before opening the real task tab.
- The preload tab should be prepared to `image mode + Pro model`.
- If preload preparation fails, matching Gemini image tasks should fall back to the existing new-tab flow.
- When a reused preload tab receives a task, it should send the task directly on that page without forcing a new chat.

## Current Context

The current extension is centered in `gemini/background.js`. It receives tasks from a local WebSocket server, creates a tab, waits for page load, and then sends `type_and_send` to the content script. The content script owns the formal Gemini task flow: optional image upload, prompt send, wait for completion, extract results, trigger download for Gemini image/video flows, and notify the background script using existing messages such as `task_completed` and `prepare_intercept`.

This design intentionally preserves that split:

- `background.js` remains the task orchestrator.
- `content.js` remains the page automation executor.
- Preload support only changes how a task tab is obtained.

## Design Overview

Add a lightweight preload manager in `background.js` and a lightweight preload preparation entrypoint in `content.js`.

The preload manager is responsible for:

- creating the preload tab,
- tracking whether it is ready for reuse,
- deciding whether a task can reuse it,
- clearing it before non-matching tasks,
- recreating it after task completion.

The content preload entrypoint is responsible for:

- ensuring the Gemini page is in image mode,
- ensuring the selected model is `Pro`,
- reporting success or failure back to `background.js`,
- doing no upload and sending no prompt.

The formal `type_and_send` flow stays unchanged.

## Approaches Considered

### Approach 1: Background-managed preload state

Add a preload state machine to `background.js` and a small `prepare_gemini_image_preload` message in `content.js`.

Pros:

- Minimal change to the current architecture.
- Keeps preload concerns in the orchestration layer.
- Preserves the existing formal task flow.
- Easier to reason about cleanup and fallback.

Cons:

- Requires a new state path in `background.js`.
- Requires one new message contract in `content.js`.

Recommendation: use this approach.

### Approach 2: Treat preload as a special internal task

Implement preload by introducing an internal pseudo-task such as `warmup_gemini_image`.

Pros:

- Reuses more of the existing task structure.

Cons:

- Mixes warmup semantics with real task semantics.
- Increases risk of affecting existing timeout, completion, and cleanup logic.
- Harder to keep preload failures separate from real task failures.

### Approach 3: Content-script self-managed preload

Let `content.js` decide by itself to keep the page ready and let `background.js` only discover tabs.

Pros:

- Fewer direct orchestration changes.

Cons:

- State becomes split across page and background contexts.
- Harder for `background.js` to know whether a preload tab is genuinely reusable.
- Recovery and fallback become less reliable.

## Recommended Architecture

### Background Layer

Add a preload-specific state block independent from `taskRegistry`.

Suggested state:

- `preloadTabId: number | null`
- `preloadState: 'idle' | 'creating' | 'ready' | 'busy' | 'failed'`
- `preloadTarget: { source: 'gemini', action: 'generate_image', model: 'Pro' }`

Suggested helper functions:

- `ensurePreloadTab()`
- `preparePreloadTab(tabId)`
- `clearPreloadTab()`
- `canReusePreloadForTask(task)`
- `restorePreloadAfterTask()`

`taskRegistry` should continue to represent real tasks only. The preload tab must not be inserted into `taskRegistry` until it is actually converted into a real task tab.

### Content Layer

Keep the existing `type_and_send` entrypoint unchanged.

Add one new message entrypoint, for example:

- `prepare_gemini_image_preload`

This entrypoint should:

1. Ensure the Gemini UI is loaded enough to interact with.
2. Switch the current page to image mode.
3. Select the `Pro` model.
4. Return success or failure.
5. Stop there.

It should not:

- create uploads,
- send prompts,
- trigger downloads,
- emit `task_completed`.

The best implementation should reuse the same UI-selection logic already used by the formal Gemini task path where possible, but separated from actions that create a real task.

## Lifecycle

### Idle Startup

After WebSocket connection is established, the background script should attempt to ensure a preload tab exists.

Flow:

1. If `preloadState` is already `creating`, `ready`, or `busy`, do nothing.
2. Open a Gemini app tab.
3. Wait for the tab to finish loading.
4. Send `prepare_gemini_image_preload`.
5. On success, store the tab id and mark state as `ready`.
6. On failure, close or clear that tab and mark state as `failed` or `idle`.

### Matching Task: `gemini + generate_image`

Flow:

1. Receive task from WebSocket.
2. Check `canReusePreloadForTask(task)`.
3. If true:
   - convert the preload tab into the formal task tab,
   - register it in `taskRegistry`,
   - mark preload state as `busy`,
   - send the existing `type_and_send` message to that tab.
4. If sending fails or the tab is gone, clear preload state and fall back to the existing new-tab execution path for the same task.

This preserves the current formal task execution path after tab selection.

### Non-Matching Task

For any task that is not `gemini + generate_image`:

1. If a preload tab exists, close it and clear preload state.
2. Continue using the existing `chrome.tabs.create(...)` flow.
3. Run the current formal task flow unchanged.

This applies to:

- Gemini text tasks,
- Gemini video tasks,
- ChatGPT text tasks,
- ChatGPT image tasks,
- any future non-matching task.

### Task Completion

After any real task finishes and normal cleanup completes, the system should attempt to recreate the preload tab.

This should happen for:

- formal success,
- formal error,
- timeout,
- download completion,
- interrupted download,
- content-script communication failure.

The recreate attempt should be centralized so that multiple task exit paths do not each implement their own preload recovery logic.

## Cleanup and Recovery Rules

### When to Clear the Preload Tab

Clear preload state when:

- a non-matching task arrives,
- the preload tab is manually closed,
- preload preparation fails,
- reuse send fails,
- the preload tab is no longer valid.

### When to Recreate the Preload Tab

Attempt recreation only after a real task is fully cleaned up.

That means:

- for text tasks: after the task tab is closed and task registry state is removed,
- for Gemini image/video tasks: after download success/failure handling and cleanup are complete,
- for errors/timeouts: after cleanup is complete.

### Why This Does Not Change Existing Logic

The existing task flow semantics remain:

- receive task,
- get a task tab,
- send `type_and_send`,
- wait for `task_completed` or download events,
- report results,
- clean up.

The only change is how the task tab is obtained:

- either by reusing the prepared preload tab,
- or by opening a new tab as before.

Everything after that remains on the existing path.

## Failure and Fallback Policy

Preload is an optimization layer, not a prerequisite for task execution.

Rules:

- If preload creation fails, do not fail the system.
- If preload preparation fails, mark preload unavailable and continue normal task execution for future tasks.
- If a matching Gemini image task arrives while preload is unavailable, run the current new-tab flow.
- If a reused preload tab fails right when the real task starts, retry that task through the current new-tab flow.
- After any task ends, try to rebuild preload again.

This keeps task success as the highest priority and prevents preload from becoming a single point of failure.

## State Model

Suggested preload states:

- `idle`: no preload tab exists.
- `creating`: preload tab is being opened or prepared.
- `ready`: preload tab is open and prepared for Gemini image work.
- `busy`: preload tab has been converted into a real task tab.
- `failed`: the last preload attempt failed; the next restore cycle may try again.

State transitions:

- `idle -> creating`: startup or post-task restore starts.
- `creating -> ready`: preload preparation succeeds.
- `creating -> failed`: preload preparation fails.
- `ready -> busy`: a matching Gemini image task reuses the preload tab.
- `ready -> idle`: a non-matching task arrives and the preload tab is closed.
- `busy -> idle`: the real task finishes and cleanup completes.
- `failed -> creating`: a later restore attempt retries preload.

## Data Flow

### Preload Preparation

1. `background.js` opens Gemini tab.
2. `background.js` waits for load complete.
3. `background.js` sends `prepare_gemini_image_preload`.
4. `content.js` switches to image mode and `Pro`.
5. `content.js` replies success/failure.
6. `background.js` stores preload readiness.

### Reused Task Execution

1. `background.js` receives `gemini + generate_image` task.
2. `background.js` reuses the ready preload tab.
3. `background.js` sends existing `type_and_send`.
4. `content.js` runs the current formal task flow.
5. Existing result reporting and download handling continue unchanged.
6. Cleanup runs.
7. Preload is recreated.

### Non-Reused Task Execution

1. `background.js` receives non-matching task.
2. `background.js` closes preload tab if present.
3. `background.js` opens a fresh task tab.
4. Existing flow continues unchanged.
5. Cleanup runs.
6. Preload is recreated.

## Error Handling

Expected failures and responses:

- Gemini page not logged in or not interactive: preload preparation fails; later matching tasks fall back to new-tab execution.
- UI selector drift during preload: preload preparation fails without blocking task processing.
- Preload tab manually closed: preload state is cleared.
- Reuse message send failure: immediately retry the task through the existing new-tab path.
- Formal task failure after reuse: treat exactly like any current formal task failure, then restore preload.

No preload failure should emit a fake task result or change task result payload shape.

## Testing Strategy

### Manual Scenarios

1. Startup with no task:
   - Gemini preload tab opens.
   - Page reaches image mode and `Pro`.

2. Matching task with healthy preload:
   - No new task tab is opened.
   - Existing preload tab receives upload and prompt.
   - Task completes normally.
   - A new preload tab is recreated after cleanup.

3. Non-matching Gemini task:
   - Preload tab is closed first.
   - A new task tab is opened.
   - Task completes normally.
   - Preload tab is recreated after cleanup.

4. ChatGPT task:
   - Preload tab is closed first.
   - ChatGPT task runs unchanged.
   - Preload tab is recreated after cleanup.

5. Preload preparation failure:
   - Preload state becomes unavailable.
   - Next matching Gemini image task opens a fresh task tab and still runs.

6. Reuse send failure:
   - Reused tab attempt fails.
   - Same task falls back to fresh tab execution.

7. Task timeout or download failure:
   - Existing error path runs.
   - Cleanup runs.
   - Preload recreation is attempted.

### Regression Focus

Verify that these remain unchanged:

- Gemini text task behavior,
- Gemini video task behavior,
- ChatGPT task behavior,
- `task_completed` payload handling,
- download interception mapping,
- cleanup of formal task registry entries.

## Implementation Boundaries

Keep changes minimal and localized:

- Main orchestration changes in `gemini/background.js`
- One new preload-preparation message path in `gemini/content.js`
- Reuse existing Gemini UI selection helpers where practical
- Avoid changing WebSocket protocol, task payload shape, or download result contract

## Open Decision Resolved in This Spec

The preload page will not force a new conversation before a reused Gemini image task. The system assumes the preload page is kept in a clean ready state. If it is not reusable in practice, the task falls back to the fresh-tab path.

## Acceptance Criteria

- Exactly one Gemini preload tab is maintained while the system is idle.
- Only `gemini + generate_image` can reuse the preload tab.
- All other task types close the preload tab and run through the current fresh-tab path.
- Preload failure never blocks task execution.
- After any task completes or fails, the system attempts to restore the preload tab.
- Existing task result, download, timeout, and cleanup behavior remain functionally unchanged.
