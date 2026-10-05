// Tiny CLI to call the plugin API of a running dsh web instance: node test/api.mjs <baseUrlWithToken> <action> [json]
const [, , url, action, rawBody = '{}'] = process.argv
const body = rawBody.startsWith('@') ? (await import('node:fs')).readFileSync(rawBody.slice(1), 'utf8').replace(/^\uFEFF/, '') : rawBody
const u = new URL(url)
const token = u.searchParams.get('token')
const base = `${u.protocol}//${u.host}`
const first = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
const cookie = (first.headers.getSetCookie?.() ?? [first.headers.get('set-cookie')]).filter(Boolean).map(c => c.split(';')[0]).join('; ')
const r = await fetch(`${base}/api/environments`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie, origin: base },
  body: JSON.stringify({ action, ...JSON.parse(body) }),
})
const text = await r.text()
try { console.log(JSON.stringify(JSON.parse(text), null, 2)) } catch { console.log(r.status, text) }
