import Gateway from './lib/Gateway.mjs';
import Notifier from './lib/Notifier.mjs';
import { clone, Env } from 'timeld-common';
import AblyApi from './lib/AblyApi.mjs';
import LOG from 'loglevel';
import isFQDN from 'validator/lib/isFQDN.js';
import rest from './rest/index.mjs';
import gracefulShutdown from 'http-graceful-shutdown';
import AuditLogger from './lib/AuditLogger.mjs';

/**
 * @typedef {object} process.env required for Gateway node startup
 * @property {string} [TIMELD_GATEWAY_DATA_PATH] should point to a volume, default `/data`
 * @property {string} [LOG_LEVEL] defaults to "INFO"
 * @property {string} TIMELD_GATEWAY_GATEWAY domain name or URL of gateway
 * @property {string} TIMELD_GATEWAY_GENESIS "true" iff the gateway is new
 * @property {string} TIMELD_GATEWAY_ABLY__KEY gateway Ably app key
 * @property {string} TIMELD_GATEWAY_ABLY__API_KEY gateway Ably api key
 * @property {string} TIMELD_GATEWAY_COURIER__AUTHORIZATION_TOKEN
 * @property {string} TIMELD_GATEWAY_COURIER__ACTIVATION_TEMPLATE
 * @property {string} TIMELD_GATEWAY_LOGZ__KEY
 */

/**
 * @typedef {object} _TimeldGatewayConfig
 * @property {string} gateway domain name or URL of gateway
 * @property {string} ably.apiKey gateway Ably api key
 * @property {string} courier.authorizationToken
 * @property {string} courier.activationTemplate
 * @property {string} logz.key
 * @typedef {TimeldConfig & _TimeldGatewayConfig} TimeldGatewayConfig
 * @see process.env
 */

const env = new Env({
  // Default is a volume mount, see fly.toml
  data: process.env.TIMELD_GATEWAY_DATA_PATH || '/data'
}, 'timeld-gateway');
// Parse command line, environment variables & configuration
const config = /**@type {TimeldGatewayConfig}*/(await env.yargs()).parse();
LOG.setLevel(config.logLevel || 'INFO');
LOG.debug('Loaded configuration', config);

// Set the m-ld domain from the declared gateway
if (config['@domain'] == null) {
  config['@domain'] = isFQDN(config.gateway) ?
    config.gateway : new URL(config.gateway).hostname;
}

// noinspection JSCheckFunctionSignatures WebStorm incorrectly merges ably property
const ablyApi = new AblyApi(config.ably);
const auditLogger = new AuditLogger(config.logz);
const gateway = await new Gateway(env, config, clone, ablyApi, auditLogger).initialise();
const notifier = new Notifier(config.courier);
const server = rest({ gateway, notifier });

server.listen(8080, function () {
  // noinspection JSUnresolvedVariable
  console.log('%s listening at %s', server.name, server.url);
});

gracefulShutdown(server, {
  async onShutdown() {
    LOG.info('Gateway shutting down...');
    await gateway.close();
    await auditLogger.close();
    LOG.info('Gateway shut down');
  }
});
