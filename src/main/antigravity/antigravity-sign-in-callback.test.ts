import { expect, it } from 'vitest'
import { antigravitySignInCallback } from './antigravity-sign-in-callback'

const pending = { redirectUri: 'http://127.0.0.1:51234/', state: 'owned-state' }
const back = 'http://127.0.0.1:51234/?state=owned-state'

it("passes on only Google's answer to this sign-in", () => {
  for (const answer of ['code=example-code', 'error=access_denied']) {
    const pasted = `${back}&${answer}&iss=https%3A%2F%2Faccounts.google.com`
    expect(antigravitySignInCallback(pending, pasted).toString()).toBe(pasted)
  }
  for (const pasted of [
    'https://127.0.0.1:51234/?state=owned-state&code=x',
    'http://localhost:51234/?state=owned-state&code=x',
    'http://127.0.0.1:51235/?state=owned-state&code=x',
    'http://127.0.0.1:51234/other?state=owned-state&code=x',
    'http://user:password@127.0.0.1:51234/?state=owned-state&code=x',
    `${back}&code=x#fragment`,
    'http://127.0.0.1:51234/?state=wrong-state&code=x',
    `${back}&state=owned-state&code=x`,
    `${back}&code=x&error=access_denied`,
    `${back}&code=`,
    back,
    `${back}&code=x&iss=https%3A%2F%2Fexample.com`,
    `${back}&code=${'x'.repeat(16_384)}`
  ]) {
    expect(() => antigravitySignInCallback(pending, pasted), pasted).toThrow(
      "That address isn't the last page of this sign-in."
    )
  }
})
