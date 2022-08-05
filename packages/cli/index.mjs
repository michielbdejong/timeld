#!/usr/bin/env node
import Cli from './lib/Cli.mjs';
import { Env } from 'timeld-common';

/**
 * @typedef {object} _TimeldCliConfig
 * @property {string | URL | false} [gateway]
 * @property {string} user User account (may not be the same as timesheet account)
 * @property {string} account Timesheet account (default in config)
 * @property {string} timesheet Timesheet name
 * @property {boolean} [create]
 * @typedef {TimeldConfig & _TimeldCliConfig} TimeldCliConfig
 */

// Support override of config and data paths for testing
const env = new Env({
  config: process.env.TIMELD_CLI_CONFIG_PATH,
  data: process.env.TIMELD_CLI_DATA_PATH
});
await new Cli(env).start();
