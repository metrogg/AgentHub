const { spawn } = require('child_process');
const { writeFileSync } = require('fs');
const { join } = require('path');
const logPath = join(__dirname, '..', 'logs', 'verify-server.log');
const pidPath = join(__dirname, '..', 'logs', 'verify-server.pid');
const out = require('fs').openSync(logPath, 'a');
const err = require('fs').openSync(logPath, 'a');
const child = spawn('bun', ['run', 'dev:server'], {
  detached: true,
  stdio: ['ignore', out, err],
  cwd: join(__dirname, '..'),
});
writeFileSync(pidPath, String(child.pid), 'utf8');
child.unref();
setTimeout(() => process.exit(0), 2000);
