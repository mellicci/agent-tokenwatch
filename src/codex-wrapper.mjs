import { spawnPortable } from './spawn.mjs';
import { loadConfig } from './config.mjs';
import { startOtlpServer } from './otlp-server.mjs';
import { CODEX_WRAPPER_ENV } from './constants.mjs';

export async function runCodexWrapper(args, injected = {}) {
  const { config } = injected.config ? { config: injected.config } : loadConfig();
  let receiver;
  try {
    receiver = await startOtlpServer(config, { host: config.codex.otlpHost, port: config.codex.otlpPort });
    if (process.env.TOKENWATCH_DEBUG === '1') console.error(`tokenwatch: OTLP receiver on ${receiver.host}:${receiver.address.port}`);
  } catch (error) {
    if (error?.code !== 'EADDRINUSE') throw error;
    // Never send a session to an unknown listener, or depend on another
    // wrapper staying alive. Concurrent sessions each own their receiver.
    receiver = await startOtlpServer(config, { host: config.codex.otlpHost, port: 0 });
    if (process.env.TOKENWATCH_DEBUG === '1') console.error(`tokenwatch: OTLP port in use; using port ${receiver.address.port}.`);
  }
  const command = config.codex.command || 'codex';
  const host = config.codex.otlpHost.includes(':') ? `[${config.codex.otlpHost}]` : config.codex.otlpHost;
  const endpoint = `http://${host}:${receiver.address.port}`;
  const protocol = config.codex.otlpProtocol === 'binary' ? 'http/protobuf' : 'http/json';
  // Codex reads its exporter from TOML, not just OTEL_* environment variables.
  // These per-invocation overrides work without installation, and leave the
  // user's persistent exporter and notifier unchanged.
  const exporter = `{ otlp-http = { endpoint = ${JSON.stringify(`${endpoint}/v1/logs`)}, protocol = ${JSON.stringify(config.codex.otlpProtocol === 'binary' ? 'binary' : 'json')} } }`;
  const codexArgs = ['-c', `otel.exporter=${exporter}`, '-c', 'otel.log_user_prompt=false', ...args];
  let child;
  try {
    child = (injected.spawn ?? spawnPortable)(command, codexArgs, {
      stdio: 'inherit',
      env: {
        ...process.env,
        OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
        OTEL_EXPORTER_OTLP_PROTOCOL: protocol,
        // Lets `tokenwatch agents`, run inside this Codex session, say that the
        // session was launched through the wrapper.
        [CODEX_WRAPPER_ENV]: '1'
      }
    });
  } catch (error) {
    await receiver.close().catch(() => {});
    throw error;
  }
  // Forwarding alone replaced Node's default terminate behaviour with a handler
  // that did nothing when the child had failed to start, so the first Ctrl+C
  // was silently swallowed and the receiver held the process open.
  const forward = (signal) => {
    if (child.pid && !child.killed) child.kill(signal);
    else process.exit(130);
  };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
    });
  } finally {
    // Always, including when the child never started. The receiver keeps the
    // event loop alive, so skipping this on the failure path meant `tokenwatch
    // codex` hung forever holding the OTLP port instead of reporting the error.
    process.removeListener('SIGINT', forward);
    process.removeListener('SIGTERM', forward);
    if (receiver) await receiver.close().catch(() => {});
  }
}
