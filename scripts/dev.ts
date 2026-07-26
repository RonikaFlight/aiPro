import { spawn } from 'child_process'
const child = spawn('node', ['node_modules/.bin/next', 'dev', '-p', '3000', '--webpack'], {
  stdio: ['ignore', 'inherit', 'inherit'],
  cwd: process.cwd(),
  env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=1024' },
})
child.on('exit', (code, signal) => { console.log(`exit code=${code} signal=${signal}`); process.exit(code ?? 1) })
process.on('SIGTERM', () => child.kill('SIGTERM'))
process.on('SIGINT', () => child.kill('SIGINT'))
process.on('SIGHUP', () => console.log('SIGHUP ignored'))
