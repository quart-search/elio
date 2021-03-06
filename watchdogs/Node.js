// Cluster Node Daemon
const vm = require('vm');
const path = require('path');
const util = require('util');
const setImmediatePromise = util.promisify(setImmediate);
const { runInNewContext } = vm;
const REFAllocationMap = new Map()
const SANDBOX_EXPANSION_SCRIPTS = [];

let INFLIGHT_INVOKATIONS = 0;
let NODE_CONFIG = {};
let NODE_READY = false;

const SUPPORT_ERROR = (type) => {
  return () => {
    throw new Error(`No support for ${type} in this node`);
  };
};

const GRACEFUL_SHUTDOWN = async (ttl) => {
  if (INFLIGHT_INVOKATIONS < 0) return setImmediate(() => process.exit(0));
  await setImmediatePromise();
  return await GRACEFUL_SHUTDOWN(ttl);
};

const LOCAL_REQUIRE = function (p) {
  const basePath = NODE_CONFIG['ELIO_MODULE_PATH'];
};

let NODE_CAPABILITIES = {
  require: false,
  Buffer: true
};

const EXPAND_SANDBOX = async (source) => {
  const sandbox = Object.assign({}, global, { module: {}, require });

  runInNewContext(new Buffer(source).toString('utf8'), sandbox);
  if (typeof sandbox.module.exports === 'function') {
    SANDBOX_EXPANSION_SCRIPTS.push(sandbox.module.exports);
    return true;
  }

  return false;
};

const ALLOCATE_REF = (digest, ref) => {
  REFAllocationMap.set(digest, ref);
};

const DEALLOCATE_REF = (digest) => {
  REFAllocationMap.delete(digest);
};

const REF_DEPLOY = async (digest, source) => {
  const scriptsLength = SANDBOX_EXPANSION_SCRIPTS.length;
  const sandbox = {
    module: {},
    console: console, /** @todo: Replace console with output stream */
    setTimeout,
    clearTimeout,
    setImmediate,
    Buffer: (NODE_CAPABILITIES.Buffer)
      ? Buffer
      : SUPPORT_ERROR("Buffer"),
    require: (NODE_CAPABILITIES.require)
      ? LOCAL_REQUIRE
      : SUPPORT_ERROR("require")
  };

  // ALlow expansion scripts to modify sandbox
  for (let i = 0; i < scriptsLength; i++) {
    await SANDBOX_EXPANSION_SCRIPTS[i](sandbox);
  }

  runInNewContext(new Buffer(source).toString('utf8'), sandbox);
  ALLOCATE_REF(digest, sandbox.module.exports);

  return digest;
};

const REF_UNDEPLOY = async (digest) => {
  return DEALLOCATE_REF(digest);
};

const REF_INVOKE_FROM_ALLOCATION = async (digest, context) => {
  const handle = REFAllocationMap.get(digest);
  const result = await handle(context || {});
  INFLIGHT_INVOKATIONS--;
  return result;
};

const REF_INVOKE = async (digest, context) => {
  INFLIGHT_INVOKATIONS++;
  if (!REFAllocationMap.has(digest)) {
    INFLIGHT_INVOKATIONS--;
    const error = new Error("Digest was not found");
    error.code = 404;
    throw error;
  } else {
    return REF_INVOKE_FROM_ALLOCATION(digest, context);
  }
};

const SET_CONFIG = async (config) => {
  NODE_CONFIG = config;
  NODE_CAPABILITIES = {
    require: config['ELIO_MODULE_PATH'] && (config['ELIO_MODULE_PATH'].length > 1),
    Buffer: true
  };

  return {
    capabilities: NODE_CAPABILITIES
  };
};

const REF_ACK_FACTORY = (id) => async (handle, ...args) => {
  if (!process.send) return;

  try {
    const response = await handle(...args);
    process.send({ type: 'ACK', id, response, status: 'OK' })
  } catch (error) {
    process.send({ type: 'ACK', id, error: error.message, errorCode: error.code, status: 'ERROR' });
  }
};

const HANDLE_IPC_MESSAGE = function (packet) {
  if (!packet || (typeof packet !== 'object') || !packet.type) return;
  const ACK = REF_ACK_FACTORY(packet.id);

  switch (packet.type) {
    case 'REFDeploy':
      return ACK(REF_DEPLOY, packet.digest, packet.source);

    case 'REFInvoke':
      return ACK(REF_INVOKE, packet.digest, packet.context);

    case 'REFUndeploy':
      return ACK(REF_UNDEPLOY, packet.digest);

    case 'EXPAND_SANDBOX':
      return ACK(EXPAND_SANDBOX, packet.source);

    case 'SET_CONFIG':
      return ACK(SET_CONFIG, packet.config);

    case 'GET_INFO':
      return ACK(() => ({ lang: "javascript", host: "node" }));

    case 'GRACEFUL_SHUTDOWN':
      return ACK(GRACEFUL_SHUTDOWN, packet.ttl);

    case 'PING':
      return ACK(() => ({ pong: true }));
  }
};

process.on('uncaughtException', (error) => {
  process.send({ type: 'uncaughtException', error, status: 'ERROR' })
});

process.on('message', HANDLE_IPC_MESSAGE);

module.exports = HANDLE_IPC_MESSAGE;