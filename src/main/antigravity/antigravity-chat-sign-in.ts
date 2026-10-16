// Signs this host's Antigravity chats in with the server's own Google sign-in: a server spawned as a
// chat start spawns one prints the link, then saves the sign-in to the chats' folder itself once
// the browser finishes. One flow per host; a new Start replaces the running one.

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  requireLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import type {
  AntigravityChatSignInState,
  AntigravityChatSignInStatus
} from '../../shared/antigravity-account-types'
import { createAcpAgentConnection, type AcpAgentConnection } from '../acp/acp-agent-connection'
import {
  ANTIGRAVITY_LAUNCH_SPEC,
  ANTIGRAVITY_SIGN_IN_PROMPT,
  type AcpLaunchSpec
} from '../acp/acp-launch-specs'
import { acpPrivateTempConnect } from '../acp/acp-private-temp'
import type { ConnectAcpAgent } from '../acp/acp-structured-connection'
import { resolveAcpLaunchInvocation } from '../acp/acp-structured-launch-resolution'
import { prepareAcpLaunch } from '../acp/acp-structured-launch-preparation'
import { AcpAgentError } from '../acp/acp-errors'
import { isAgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { RevisionedState } from '../runtime/revisioned-state'
import type { structuredAgentHostLaunchSources } from '../runtime/structured-agent-launch-support'
import {
  AntigravitySignInCloseUnprovenError,
  closeAntigravitySignInOwner
} from './antigravity-chat-account'
import {
  antigravitySignInCallback,
  sendAntigravitySignInCallback,
  type AntigravitySignInPending
} from './antigravity-sign-in-callback'

// The server's own wait for the browser.
const FLOW_DEADLINE_MS = 300_000
const INVALID_LINK = {
  phase: 'failed',
  error: 'Antigravity returned an invalid Google sign-in link.'
} as const

type Phase = AntigravityChatSignInState['phase']
type Flow = {
  id: string
  ended: AbortController
  done: Promise<void>
  pending?: AntigravitySignInPending
  callbackSent?: boolean
}

export type AntigravityChatSignInHost = {
  launchSources(): ReturnType<typeof structuredAgentHostLaunchSources>
  /** Rejects when a chat is not proven stopped. */
  stopLiveChats(): Promise<void>
  connect?: ConnectAcpAgent<AcpAgentConnection>
}

let flow: Flow | null = null
// The latest flow's state, which every client follows by revision.
const signInState = new RevisionedState<AntigravityChatSignInState | null>(null)

const settled = (phase: Phase): boolean =>
  phase !== 'starting' && phase !== 'waiting' && phase !== 'verifying'

function publish(
  current: Flow,
  next: Omit<AntigravityChatSignInState, 'flowId'>,
  cleanupFailed = false
): void {
  const shown = signInState.get().value
  // A replaced flow was already shown cancelled, and its successor owns the state.
  if (shown?.flowId !== current.id || (settled(shown.phase) && !cleanupFailed)) {
    return
  }
  signInState.set({ flowId: current.id, ...next })
  if (settled(next.phase)) {
    current.ended.abort()
  }
}

export function startAntigravityChatSignIn(host: AntigravityChatSignInHost): { flowId: string } {
  // A host whose chats are refused (supportsAcpStructuredLocation) signs none in.
  if (ANTIGRAVITY_LAUNCH_SPEC.managedRuntime.pin() === null) {
    throw new Error(`Antigravity chats are not available on ${process.platform} ${process.arch}.`)
  }
  const previous = flow
  if (previous) {
    publish(previous, { phase: 'cancelled' })
  }
  const current: Flow = { id: randomUUID(), ended: new AbortController(), done: Promise.resolve() }
  flow = current
  signInState.set({ flowId: current.id, phase: 'starting' })
  // After the replaced flow has let go of the chats' starts.
  current.done = (previous?.done ?? Promise.resolve()).then(() => runFlow(current, host))
  return { flowId: current.id }
}

async function runFlow(current: Flow, host: AntigravityChatSignInHost): Promise<void> {
  const deadline = setTimeout(() => publish(current, { phase: 'expired' }), FLOW_DEADLINE_MS)
  let signingIn = false
  try {
    current.ended.signal.throwIfAborted()
    await ANTIGRAVITY_LAUNCH_SPEC.launchGate.run(host.stopLiveChats, () => {
      signingIn = true
      return signIn(current, host)
    })
    publish(current, { phase: 'signedIn' })
  } catch (error) {
    console.warn('[antigravity] chat sign-in failed:', error)
    // Before the sign-in runs, a refusal is the gate's or the chat stop's own sentence.
    const message =
      signingIn || !(error instanceof Error) ? antigravitySignInFailure(error) : error.message
    publish(
      current,
      { phase: 'failed', error: message },
      error instanceof AntigravitySignInCloseUnprovenError
    )
  } finally {
    clearTimeout(deadline)
  }
}

async function signIn(current: Flow, host: AntigravityChatSignInHost): Promise<void> {
  const spec: AcpLaunchSpec = ANTIGRAVITY_LAUNCH_SPEC
  const { signal } = current.ended
  const closed = (): void => signal.throwIfAborted()
  const { accountHome, env, commandSettings, dataDirectory } = await host.launchSources()
  const deps = { spec, dataDirectory, connect: host.connect ?? createAcpAgentConnection }
  const resolve = () =>
    resolveAcpLaunchInvocation(spec, accountHome, {
      resolveEnvironment: async () => env,
      resolveCommandSettings: () => commandSettings,
      dataDirectory
    })
  // Never downloads: an unresolved runtime refuses as a chat start does.
  const launch = await prepareAcpLaunch(deps, resolve, closed)
  const connect = await acpPrivateTempConnect(deps, closed)
  const cwd = await mkdtemp(join(tmpdir(), 'orca-antigravity-sign-in-'))
  let connection: AcpAgentConnection | null = null
  const removeCwd = () => rm(cwd, { recursive: true, force: true })
  try {
    connection = connect(
      { ...launch, args: spec.args({ fullAccess: false, pluginDir: null }), cwd },
      {
        clientInfo: { name: 'orca', version: '1' },
        signInPrompt: spec.signInPrompt,
        signInLink: (line) => {
          const link = antigravitySignInUrl(line)
          // Once a pasted address went out, the server's answer to it is what the flow waits on.
          if (current.callbackSent) {
            return
          }
          current.pending = link ?? undefined
          publish(current, link ? { phase: 'waiting', url: link.url } : INVALID_LINK)
        }
      }
    )
    const owner = connection
    owner.onExit(() => void removeCwd().catch(() => {}))
    const stop = (): void => void owner.close().catch(() => false)
    signal.addEventListener('abort', stop, { once: true })
    try {
      // Resolves once the browser finishes, or at once when the folder is already signed in.
      await connection.authenticate('oauth-personal')
    } finally {
      signal.removeEventListener('abort', stop)
      await closeAntigravitySignInOwner(launch.env.GEMINI_HOME, owner)
    }
  } finally {
    if (!connection || connection.exited) {
      await removeCwd()
    }
  }
}

/** The sentence a person reads for a failed sign-in; the raw error goes only to the log. */
function antigravitySignInFailure(error: unknown): string {
  const cause = isAgentSessionPreSpawnError(error) ? error.cause : error
  if (cause instanceof AntigravitySignInCloseUnprovenError) {
    return cause.message
  }
  if (isAgentSessionPreSpawnError(error) && error.reason === 'runtimeNotInstalled') {
    return 'Antigravity is not installed on this host. Install it, then start sign-in again.'
  }
  if (error instanceof AcpAgentError) {
    // The server may put its own words in the answer's data rather than its message.
    const text = `${error.message} ${JSON.stringify(error.data ?? '')}`
    if (text.includes('SUBSCRIPTION_REQUIRED')) {
      return 'Google requires an eligible Antigravity subscription for this account.'
    }
    if (/onboarding failed|ineligible/i.test(text)) {
      return "This Google account can't use Antigravity. Sign in with a different account."
    }
    if (/access_denied|denied access|cancelled/i.test(text)) {
      return 'Google sign-in for Antigravity was not approved. Start sign-in again.'
    }
  }
  return 'Google sign-in for Antigravity failed. Start sign-in again.'
}

/** The link only when it is Google's sign-in page sending the browser back to a loopback port on
 *  this host: it is opened for the person, so anything else is withheld. */
export function antigravitySignInUrl(
  line: string
): ({ url: string } & AntigravitySignInPending) | null {
  const link = line.trim().slice(ANTIGRAVITY_SIGN_IN_PROMPT.length).trim()
  if (link.length > 16_384 || /\s/.test(link) || !URL.canParse(link)) {
    return null
  }
  const url = new URL(link)
  const one = (name: string): string =>
    url.searchParams.getAll(name).length === 1 ? (url.searchParams.get(name) ?? '') : ''
  const redirect = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/$/.exec(one('redirect_uri'))
  const port = Number(redirect?.[1])
  const valid =
    url.origin === 'https://accounts.google.com' &&
    url.pathname === '/o/oauth2/v2/auth' &&
    !url.username &&
    !url.password &&
    !url.hash &&
    one('response_type') === 'code' &&
    /^\S{1,512}$/.test(one('state')) &&
    port >= 1024 &&
    port <= 65_535
  return valid ? { url: link, redirectUri: one('redirect_uri'), state: one('state') } : null
}

/** Resolves once the flow has unwound and let go of the chats' starts, so a send right after
 *  Cancel isn't refused as a sign-in change. */
export async function cancelAntigravityChatSignIn(
  flowId: string
): Promise<AntigravityChatSignInState | null> {
  const current = flow
  if (current?.id !== flowId) {
    throw new Error('That Antigravity sign-in is no longer running.')
  }
  publish(current, { phase: 'cancelled' })
  await current.done
  return signInState.get().value
}

const CALLBACK_NOT_SENT =
  "Couldn't pass the sign-in on to Antigravity on this host. Start sign-in again."

/** Sends the address the browser ended on to the server's own listener, for a browser on another
 *  computer than this host; at most once per flow. */
export async function completeAntigravityChatSignIn(
  flowId: string,
  callbackUrl: string
): Promise<AntigravityChatSignInState | null> {
  const current = flow
  const shown = signInState.get().value
  if (current?.id !== flowId || shown?.flowId !== flowId || current.callbackSent) {
    throw new Error(
      current?.id === flowId && current.callbackSent
        ? 'That address was already sent. Wait for Google to finish signing in.'
        : 'That Antigravity sign-in is no longer running. Start sign-in again.'
    )
  }
  if (shown.phase !== 'waiting' || !current.pending) {
    throw new Error('Wait for the Google sign-in link before you paste an address.')
  }
  const callback = antigravitySignInCallback(current.pending, callbackUrl)
  current.callbackSent = true
  publish(current, { phase: 'verifying' })
  try {
    await sendAntigravitySignInCallback(callback)
  } catch (error) {
    console.warn('[antigravity] pasted sign-in address not delivered:', error)
    publish(current, { phase: 'failed', error: CALLBACK_NOT_SENT })
    throw new Error(CALLBACK_NOT_SENT)
  }
  return signInState.get().value
}

/** Calls `onChange` after every change of the sign-in state until the returned unsubscribe. */
export const subscribeAntigravityChatSignIn = (onChange: () => void): (() => void) =>
  signInState.subscribe(onChange)

/** `saved` is a stat of the server's own sign-in file, reread on each read; nothing reads it. */
export async function readAntigravityChatSignInStatus(
  accountHome: AgentSessionAccountHome
): Promise<AntigravityChatSignInStatus> {
  const { value, revision } = signInState.get()
  const token = join(
    requireLegacyAgentSessionAccountHome(accountHome).path,
    'antigravity-acp',
    'acp_token.json'
  )
  const saved = await stat(token).then(
    (file) => file.isFile(),
    () => false
  )
  return { revision, saved, flow: value }
}
