import restify from 'restify';
import Gateway from './lib/Gateway.mjs';
import Notifier from './lib/Notifier.mjs';
import { AccountSubId, clone, Env, ResultsReadable } from 'timeld-common';
import AblyApi from './lib/AblyApi.mjs';
import LOG from 'loglevel';
import isFQDN from 'validator/lib/isFQDN.js';
import isEmail from 'validator/lib/isEmail.js';
import errors from 'restify-errors';
import Authorization from './lib/Authorization.mjs';
import { pipeline } from 'stream/promises';

/**
 * @typedef {object} process.env required for Gateway node startup
 * @property {string} [TIMELD_GATEWAY_DATA_PATH] should point to a volume, default `/data`
 * @property {string} [LOG_LEVEL] defaults to "INFO"
 * @property {string} TIMELD_GATEWAY_GATEWAY domain name or URL of gateway
 * @property {string} TIMELD_GATEWAY_GENESIS "true" iff the gateway is new
 * @property {string} TIMELD_GATEWAY_ABLY__KEY gateway Ably app key
 * @property {string} TIMELD_GATEWAY_ABLY__API_KEY gateway Ably api key
 * @property {string} TIMELD_GATEWAY_COURIER__AUTHORIZATION_TOKEN
 */

const env = new Env({
  // Default is a volume mount, see fly.toml
  data: process.env.TIMELD_GATEWAY_DATA_PATH || '/data'
}, 'timeld-gateway');
// Parse command line, environment variables & configuration
const config = /**@type {*}*/(await env.yargs()).parse();
LOG.setLevel(config.logLevel || 'INFO');
LOG.debug('Loaded configuration', config);

// Set the m-ld domain from the declared gateway
if (config['@domain'] == null) {
  config['@domain'] = isFQDN(config.gateway) ?
    config.gateway : new URL(config.gateway).hostname;
}

const ablyApi = new AblyApi(config.ably);
const gateway = await new Gateway(env, config, clone, ablyApi).initialise();
const notifier = new Notifier(config.courier);
const server = restify.createServer();
server.use(restify.plugins.queryParser({ mapParams: true }));
server.use(restify.plugins.authorizationParser());
server.use(restify.plugins.bodyParser());
server.on('InternalServer', function (req, res, err, cb) {
  LOG.warn(err);
  cb();
});
const ND_JSON = { stringify: JSON.stringify, separator: '\n' };

server.get('/api/:user/jwe',
  async (req, res, next) => {
    const { user, email } = req.params;
    if (!AccountSubId.isComponentId(user))
      return next(new errors.BadRequestError('Bad user %s', user));
    if (!email || !isEmail(email))
      return next(new errors.BadRequestError('Bad email %s', email));
    try {
      const { jwe, code } = await gateway.activation(user, email);
      await notifier.sendActivationCode(email, code);
      res.json({ jwe });
      next();
    } catch (e) {
      next(e);
    }
  });

server.get('/api/:user/key',
  async (req, res, next) => {
    try {
      const auth = new Authorization(gateway, req);
      const { email } = gateway.verify(auth.jwt);
      if (!email || !isEmail(email))
        return next(new errors.BadRequestError('Bad email %s', email));
      const acc = await gateway.account(auth.user, { orCreate: true });
      const key = await acc.activate(email);
      res.json({ key });
      next();
    } catch (e) {
      next(e);
    }
  });

server.get('/api/:account/tsh/:timesheet/cfg',
  async (req, res, next) => {
    // account is the timesheet account (may not be user account)
    const { account, timesheet } = req.params;
    try {
      const tsId = gateway.tsId(account, timesheet).validate();
      try {
        await new Authorization(gateway, req).verifyUser(tsId);
        res.json(await gateway.timesheetConfig(tsId));
      } catch (e) {
        next(e);
      }
      next();
    } catch (e) {
      // TimesheetId.validate throw strings
      return next(new errors.BadRequestError(
        'Bad timesheet %s/%s', account, timesheet));
    }
  });

server.post('/api/read',
  async (req, res, next) => {
    try {
      const auth = new Authorization(gateway, req);
      await auth.verifyUser();
      const acc = await gateway.account(auth.user);
      const results = await acc.read(req.body);
      res.header('transfer-encoding', 'chunked');
      res.header('content-type', 'application/x-ndjson');
      res.status(200);
      await pipeline(new ResultsReadable(results, ND_JSON), res);
      next();
    } catch (e) {
      next(e);
    }
  });

server.post('/api/write',
  async (req, res, next) => {
    try {
      const auth = new Authorization(gateway, req);
      await auth.verifyUser();
      const acc = await gateway.account(auth.user);
      await acc.write(req.body);
      res.send(200);
      next();
    } catch (e) {
      next(e);
    }
  });

server.listen(8080, function () {
  // noinspection JSUnresolvedVariable
  console.log('%s listening at %s', server.name, server.url);
});

process.on('beforeExit', async () => {
  LOG.info('Gateway shutting down...');
  await gateway.close();
  LOG.info('Gateway shut down');
});

