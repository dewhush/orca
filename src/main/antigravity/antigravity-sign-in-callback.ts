// The address Google's sign-in sends the browser back to, pasted by hand when that browser is on
// another computer than the host, then sent once to the server's own loopback listener here.

import { request } from 'node:http'

/** The loopback address and `state` from the sign-in link the server printed. */
export type AntigravitySignInPending = { redirectUri: string; state: string }

const NOT_THIS_SIGN_IN =
  "That address isn't the last page of this sign-in. Copy the full address from your browser's address bar and try again."

/** The pasted address only when it is Google's answer to this flow's link; otherwise a sentence
 *  the person reads, since nothing else may be sent to a port on this host. */
export function antigravitySignInCallback(
  pending: AntigravitySignInPending,
  callbackUrl: string
): URL {
  const text = callbackUrl.trim()
  if (text.length > 16_384 || !URL.canParse(text)) {
    throw new Error(NOT_THIS_SIGN_IN)
  }
  const callback = new URL(text)
  const expected = new URL(pending.redirectUri)
  const all = (name: string): string[] => callback.searchParams.getAll(name)
  const [codes, errors, issuers] = [all('code'), all('error'), all('iss')]
  const oneAnswer =
    (codes.length === 1 && codes[0] !== '' && errors.length === 0) ||
    (errors.length === 1 && errors[0] !== '' && codes.length === 0)
  const valid =
    callback.protocol === 'http:' &&
    callback.hostname === '127.0.0.1' &&
    callback.origin === expected.origin &&
    callback.pathname === expected.pathname &&
    !callback.username &&
    !callback.password &&
    !callback.hash &&
    all('state').length === 1 &&
    callback.searchParams.get('state') === pending.state &&
    oneAnswer &&
    (issuers.length === 0 ||
      (issuers.length === 1 && issuers[0] === 'https://accounts.google.com'))
  if (!valid) {
    throw new Error(NOT_THIS_SIGN_IN)
  }
  return callback
}

/** One GET to the server's listener; `agent: false` so no proxy setting can route it elsewhere. */
export function sendAntigravitySignInCallback(callback: URL, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const sent = request(
      {
        hostname: callback.hostname,
        port: callback.port,
        path: `${callback.pathname}${callback.search}`,
        method: 'GET',
        agent: false,
        signal: AbortSignal.timeout(timeoutMs)
      },
      (response) => {
        response.once('error', reject)
        response.once('end', () => {
          const status = response.statusCode ?? 0
          if (status >= 200 && status < 300) {
            resolve()
          } else {
            reject(new Error(`The sign-in listener answered ${status}.`))
          }
        })
        response.resume()
      }
    )
    sent.once('error', reject)
    sent.end()
  })
}
