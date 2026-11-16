// Can run under plain Node or the packaged Electron binary in Node mode.
// Importing this module has no side effects (the host boundary test does so).
async function main(argv = process.argv.slice(2)) {
  const path = require('node:path');
  const index = argv.indexOf('--data-dir');
  if (index < 0 || !argv[index + 1] || !path.isAbsolute(argv[index + 1])) throw Error('Use --data-dir with an absolute Tote profile path');
  delete process.env.ELECTRON_RUN_AS_NODE;
  const env = require('../main/environment');
  env.dropInheritedAgentSession(); env.adoptLoginShellPath();
  const { Runtime } = require('./runtime');
  const runtime = new Runtime(argv[index + 1]);
  runtime.onStopped = () => process.exit(0);
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => runtime.stop().then(() => process.exit(0)));
  await runtime.start();
  return runtime;
}
if (require.main === module) main().catch(error => { console.error('Tote host:', error.message); process.exit(1); });
module.exports = { main };
