import { createWindowsAccount, deleteWindowsAccount, listWindowsAccounts, openWindowsAccount } from '../lib/env/winuser-env.js'
const dataDir = '.cache/wu-data2'
console.log('create', await createWindowsAccount('dshtest2', { dataDir }).catch(e => e.message))
console.log('list', await listWindowsAccounts())
const env = await openWindowsAccount({ id: 'w', name: 'W', account: 'dshtest2', dataDir }).catch(e => e)
console.log('open', env.message ?? env.info?.user)
if (!env.message) { const r = await env.exec({ command: 'whoami' }); console.log(r.stdout.toString().trim()); await env.close() }
await new Promise(r => setTimeout(r, 2000))
console.log('delete', await deleteWindowsAccount('dshtest2', { dataDir }).catch(e => e.message))
console.log('list', await listWindowsAccounts())
