// @vitest-environment happy-dom
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { AntigravityChatSignInState } from '../../../../shared/antigravity-account-types'
import { callAntigravityChatSignIn } from '@/runtime/runtime-antigravity-accounts-client'
import { AntigravityChatSignInRow } from './AntigravityChatSignInRow'
import { TooltipProvider } from '../ui/tooltip'

const url = 'https://accounts.google.com/o/oauth2/v2/auth?state=s'
type FakeHost = {
  revision: number
  saved: boolean
  flow: AntigravityChatSignInState | null
  start: Promise<{ flowId: string }> | null
  streams: Set<(status: unknown) => void>
}
// The host's sign-in status, pushed to every subscriber by revision as the host does.
const { host, publish, status } = vi.hoisted(() => {
  const host: FakeHost = { revision: 0, saved: false, flow: null, start: null, streams: new Set() }
  const status = () => ({ revision: host.revision, saved: host.saved, flow: host.flow })
  const publish = (flow: AntigravityChatSignInState, saved = false): void => {
    Object.assign(host, { revision: host.revision + 1, flow, saved })
    host.streams.forEach((emit) => emit(status()))
  }
  return { host, publish, status }
})
vi.mock('@/runtime/runtime-antigravity-accounts-client', () => ({
  callAntigravityChatSignIn: vi.fn(async (_owner: unknown, action: string) => {
    if (action === 'Start') {
      if (host.start) {
        return host.start
      }
      publish({ flowId: 'f', phase: 'starting' })
      return { flowId: 'f' }
    }
    return undefined
  }),
  subscribeAntigravityChatSignIn: vi.fn(
    async (_owner: unknown, handlers: { onEvent: (status: unknown) => void }) => {
      host.streams.add(handlers.onEvent)
      handlers.onEvent(status())
      return { unsubscribe: () => host.streams.delete(handlers.onEvent) }
    }
  )
}))

async function showRow(owner: { kind: 'local' } | { kind: 'environment'; environmentId: string }) {
  const view = render(
    <TooltipProvider>
      <AntigravityChatSignInRow owner={owner} label="" description="" disabled={false} />
    </TooltipProvider>
  )
  // Sign in stays disabled until the host's snapshot lands.
  await act(async () => undefined)
  return view
}

it('opens the link once across status answers and shows signed in', async () => {
  const openUrl = vi.fn(async () => undefined)
  Object.assign(window, { api: { shell: { openUrl } } })
  const view = await showRow({ kind: 'local' })
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  await act(async () => publish({ flowId: 'f', phase: 'waiting', url }))
  await screen.findByText('Finish signing in in your browser.')
  await act(async () => publish({ flowId: 'f', phase: 'waiting', url }))
  await act(async () => publish({ flowId: 'f', phase: 'signedIn' }, true))
  await screen.findByText('Signed in.')
  expect(screen.getByRole('button', { name: 'Change account' })).toBeTruthy()
  expect(openUrl).toHaveBeenCalledExactlyOnceWith(url)
  view.unmount()
})

it('opens nothing for a Start the host answers after the row unmounts', async () => {
  const start = Promise.withResolvers<{ flowId: string }>()
  host.start = start.promise
  const openUrl = vi.fn(async () => undefined)
  Object.assign(window, { api: { shell: { openUrl } } })
  const view = await showRow({ kind: 'environment', environmentId: 'unmounted' })
  await userEvent.click(view.getByRole('button', { name: 'Sign in' }))
  view.unmount()
  await act(async () => {
    start.resolve({ flowId: 'late' })
    publish({ flowId: 'late', phase: 'waiting', url })
  })
  expect(openUrl).not.toHaveBeenCalled()
  host.start = null
})

it('an idle row shows a sign-in another device starts, and can cancel it', async () => {
  publish({ flowId: 'done', phase: 'cancelled' })
  const openUrl = vi.fn(async () => undefined)
  Object.assign(window, { api: { shell: { openUrl } } })
  const owner = { kind: 'environment', environmentId: 'idle' } as const
  await showRow(owner)
  await screen.findByText('Sign-in cancelled.')
  await act(async () => publish({ flowId: 'other', phase: 'waiting', url }))
  await screen.findByText('Finish signing in in your browser.')
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(callAntigravityChatSignIn).toHaveBeenCalledWith(owner, 'Cancel', { flowId: 'other' })
  expect(openUrl).not.toHaveBeenCalled()
})
