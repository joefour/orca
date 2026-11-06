import { isAskUserQuestionTool } from '../../agent-status/lifecycle/agent-question-answered-intent'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status/contracts/agent-status-types'
import {
  agentChildWorkLiveness,
  type AgentChildWorkLiveness,
  type AgentChildWorkLivenessCandidate
} from '../../agent-status/child-work/agent-status-child-work-liveness'
import {
  continueMainAgentStatus,
  foldAgentLeadStatus
} from '../../agent-status/lifecycle/agent-lead-status-fold'
import {
  createMuseSessionLogState,
  readMuseBackgroundWork,
  readMusePendingUserInput,
  recordMuseWorkflowLaunch,
  restartMuseBackgroundWork
} from '../../muse-session-log'
import type { HookListenerState, MusePaneState } from '../listener-state'
import {
  resolvePrompt,
  resolveToolState,
  shouldIgnoreCompactContinuationUserPromptSubmit
} from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'

function getMusePaneState(state: HookListenerState, paneKey: string): MusePaneState {
  let pane = state.musePaneStateByPaneKey.get(paneKey)
  if (!pane) {
    pane = { childSessionIds: new Set(), runningChildSessionIds: new Set() }
    state.musePaneStateByPaneKey.set(paneKey, pane)
  }
  return pane
}

function isChildSessionEvent(pane: MusePaneState, hookPayload: Record<string, unknown>): boolean {
  const sessionId = readString(hookPayload, 'session_id')
  if (!sessionId) {
    return false
  }
  // Muse1.3 children reuse session_id as turn_id, including after a listener restart loses SubagentStart.
  return pane.childSessionIds.has(sessionId) || readString(hookPayload, 'turn_id') === sessionId
}

// Reminders use role names (skill-reminder); spawned and workflow agents use UUIDs.
const MAX_BACKGROUND_HOLD_MS = 5 * 60 * 1000
const BACKGROUND_SUBAGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function readChildSessionId(hookPayload: Record<string, unknown>): string | undefined {
  return readString(hookPayload, 'child_session_id') ?? readString(hookPayload, 'session_id')
}

/** Work Muse keeps running after the main agent's turn ends; it wakes the main agent when it finishes. */
function museChildWorkLiveness(
  pane: MusePaneState,
  turnId: string | undefined
): AgentChildWorkLiveness {
  const work: AgentChildWorkLivenessCandidate[] = Array.from(pane.runningChildSessionIds, () => ({
    kind: 'agent' as const
  }))
  if (pane.log) {
    const { runningWorkflows, newerRunActive } = readMuseBackgroundWork(pane.log, turnId)
    for (let i = 0; i < runningWorkflows; i++) {
      work.push({ kind: 'workflow' })
    }
    // Why: the wake run's first hook lags its start, so a drained hold must not blink done first.
    if (newerRunActive && pane.heldOpen) {
      work.push({ kind: 'agent' })
    }
  }
  return agentChildWorkLiveness(work)
}

export function hasMuseSessionLog(state: HookListenerState, paneKey: string): boolean {
  return state.musePaneStateByPaneKey.get(paneKey)?.log !== undefined
}

export function normalizeMuseEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (shouldIgnoreCompactContinuationUserPromptSubmit(eventName, promptText)) {
    return null
  }

  const pane = getMusePaneState(state, paneKey)
  if (eventName === 'SubagentStart') {
    const childSessionId = readChildSessionId(hookPayload)
    if (childSessionId) {
      pane.childSessionIds.add(childSessionId)
      if (BACKGROUND_SUBAGENT_ID.test(readString(hookPayload, 'subagent_id') ?? '')) {
        pane.runningChildSessionIds.add(childSessionId)
      }
    }
    return null
  }
  if (eventName === 'SubagentStop') {
    const childSessionId = readChildSessionId(hookPayload)
    if (childSessionId) {
      pane.runningChildSessionIds.delete(childSessionId)
    }
    return null
  }
  if (isChildSessionEvent(pane, hookPayload)) {
    return null
  }
  const sessionId = readString(hookPayload, 'session_id')
  if (sessionId && pane.log?.sessionId !== sessionId) {
    pane.log = createMuseSessionLogState(sessionId)
  }
  const turnId = readString(hookPayload, 'turn_id')
  if (eventName === 'SessionStart' || eventName === 'SessionEnd') {
    // Background children do not survive their session.
    pane.runningChildSessionIds.clear()
    if (pane.log) {
      restartMuseBackgroundWork(pane.log)
    }
  }
  if (
    eventName === 'PostToolUse' &&
    pane.log &&
    readString(hookPayload, 'tool_name') === 'workflow'
  ) {
    recordMuseWorkflowLaunch(pane.log, hookPayload.tool_response)
  }

  const toolName = readString(hookPayload, 'tool_name')
  let toolEventName = eventName
  let toolPayload = hookPayload
  let stateName: 'working' | 'waiting' | 'done'
  switch (eventName) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      stateName = 'working'
      pane.pendingApproval = undefined
      break
    case 'PreToolUse':
      // Keep pendingApproval: the transcript poll replays this body while the approval is visible.
      stateName = isAskUserQuestionTool(toolName) ? 'waiting' : 'working'
      break
    case 'PermissionRequest':
      pane.pendingApproval = { toolName, toolInput: hookPayload.tool_input }
      return null
    case 'Notification':
      if (hookPayload.notification_type !== 'permission_prompt') {
        return null
      }
      stateName = 'waiting'
      toolEventName = 'PermissionRequest'
      toolPayload = {
        ...hookPayload,
        tool_name: pane.pendingApproval?.toolName,
        tool_input: pane.pendingApproval?.toolInput
      }
      break
    case 'Stop':
    case 'StopFailure':
      stateName = 'done'
      pane.pendingApproval = undefined
      break
    case 'SessionEnd':
      // Only a turn held open by background work still owes the row its end.
      if (!pane.heldOpen) {
        return null
      }
      stateName = 'done'
      break
    default:
      return null
  }

  if (stateName === 'working' && pane.log) {
    // Muse emits no request_user_input hook; only the session log proves its wait.
    const pendingInput = readMusePendingUserInput(pane.log, turnId)
    if (pendingInput) {
      stateName = 'waiting'
      toolEventName = 'PreToolUse'
      toolPayload = {
        ...hookPayload,
        tool_name: 'request_user_input',
        tool_input: { questions: pendingInput.questions }
      }
    }
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('muse', toolEventName, toolPayload),
    { resetOnNewTurn: isNewTurnEvent('muse', eventName) }
  )

  const interrupted =
    eventName === 'Stop' && hookPayload['is_interrupt'] === true ? true : undefined
  const sessionBoundary = eventName === 'SessionEnd'
  if (pane.heldSince !== undefined && Date.now() - pane.heldSince >= MAX_BACKGROUND_HOLD_MS) {
    pane.runningChildSessionIds.clear()
    if (pane.log) {
      restartMuseBackgroundWork(pane.log)
    }
  }
  // Why: lead verdicts never retire background subagents or workflows; only their own end does.
  const resolution = foldAgentLeadStatus({
    leadState: stateName,
    childWorkLiveness:
      stateName === 'done' && !sessionBoundary ? museChildWorkLiveness(pane, turnId) : null
  })
  const mainAgent = continueMainAgentStatus(
    pane.mainAgent,
    {
      state: stateName,
      outcome: interrupted
        ? 'cancellation'
        : eventName === 'StopFailure'
          ? 'failure'
          : sessionBoundary
            ? pane.mainAgent?.outcome
            : undefined
    },
    Date.now()
  )
  pane.mainAgent = mainAgent
  pane.heldOpen = resolution.stateName !== stateName
  pane.heldSince = pane.heldOpen ? (pane.heldSince ?? Date.now()) : undefined

  return normalizeAgentStatusPayload({
    state: resolution.stateName,
    // Notification message is status copy, never the user prompt.
    prompt: resolvePrompt(state, paneKey, eventName === 'Notification' ? '' : promptText, {
      resetOnNewTurn: isNewTurnEvent('muse', eventName)
    }),
    agentType: 'muse',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    interrupted,
    ...(resolution.workingMode ? { workingMode: resolution.workingMode } : {}),
    ...(sessionBoundary ? { sessionBoundary: true } : {}),
    // Published only while held, so unheld rows keep their existing interrupt handling.
    ...(pane.heldOpen ? { mainAgent } : {})
  })
}
