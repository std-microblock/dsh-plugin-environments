// Call the plugin API of a running dsh web instance:
//   node packages/plugin/test/manual/api.ts <baseUrlWithToken> <action> [json | @file.json]
import fs from 'node:fs'

const [, , url, action, rawBody = '{}'] = process.argv
if (!url || !action) {
  console.error('usage: node api.ts <baseUrlWithToken> <action> [json | @file.json]')
  process.exit(2)
}
const body = rawBody.startsWith('@') ? fs.readFileSync(rawBody.slice(1), 'utf8').replace(/^\uFEFF/, '') : rawBody
const u = new URL(url)
const token = u.searchParams.get('token') ?? ''
const base = `${u.protocol}//${u.host}`
const first = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
const cookie = first.headers
  .getSetCookie()
  .map(c => c.split(';')[0])
  .join('; ')
const r = await fetch(`${base}/api/environments`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie, origin: base },
  body: JSON.stringify({ action, ...(JSON.parse(body) as Record<string, unknown>) }),
})
const text = await r.text()
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2))
} catch {
  console.log(r.status, text)
}
