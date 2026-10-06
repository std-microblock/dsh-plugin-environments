// Create, use and delete a dsh-managed Windows account (needs administrator approval):
//   node packages/plugin/test/manual/real-winuser2.ts
import { errorMessage } from '@dsh-environments/protocol'
import { createWindowsAccount, deleteWindowsAccount, listWindowsAccounts } from '../../src/env/winuser/accounts.ts'
import { openWindowsAccount } from '../../src/env/winuser/winuser-env.ts'

const dataDir = '.cache/wu-data2'
console.log('create', await createWindowsAccount('dshtest2', { dataDir }).catch(errorMessage))
console.log('list', await listWindowsAccounts())
try {
  const env = await openWindowsAccount({ id: 'w', name: 'W', account: 'dshtest2', dataDir })
  console.log('open', env.info?.user)
  const r = await env.exec({ command: 'whoami' })
  console.log(r.stdout.toString().trim())
  await env.close()
} catch (e) {
  console.log('open', errorMessage(e))
}
await new Promise(r => setTimeout(r, 2000))
console.log('delete', await deleteWindowsAccount('dshtest2', { dataDir }).catch(errorMessage))
console.log('list', await listWindowsAccounts())
