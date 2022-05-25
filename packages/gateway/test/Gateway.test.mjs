import { describe, expect, jest, test } from '@jest/globals';
import { clone as meldClone } from '@m-ld/m-ld';
import { MeldMemDown } from '@m-ld/m-ld/dist/memdown';
import Gateway from '../lib/Gateway.mjs';
import { Env, timeldContext } from 'timeld-common';
import { dirSync } from 'tmp';
import { join } from 'path';
import Account from '../lib/Account.mjs';
import Cryptr from 'cryptr';
import DeadRemotes from './DeadRemotes.mjs';

describe('Gateway', () => {
  let env;
  let clone;
  let tmpDir;
  let ablyApi;

  beforeEach(() => {
    // noinspection JSCheckFunctionSignatures
    tmpDir = dirSync({ unsafeCleanup: true });
    env = new Env({ data: join(tmpDir.name, 'data') });
    // noinspection JSCheckFunctionSignatures
    clone = jest.fn(config =>
      meldClone(new MeldMemDown(), DeadRemotes, config));
    ablyApi = {
      listAppKeys: jest.fn(),
      createAppKey: jest.fn()
    };
  });

  afterEach(async () => {
    tmpDir.removeCallback();
  });

  test('throws if no ably config', async () => {
    await expect(async () => {
      const gateway = new Gateway(
        env, { '@domain': 'ex.org' }, clone, ablyApi);
      return gateway.initialise();
    }).rejects.toBeDefined();
  });

  test('throws if no domain', async () => {
    await expect(async () => {
      const gateway = new Gateway(
        env, { ably: { key: 'id:secret' } }, clone, ablyApi);
      return gateway.initialise();
    }).rejects.toBeDefined();
  });

  describe('initialised', () => {
    let /**@type Gateway*/gateway;

    beforeEach(async () => {
      gateway = new Gateway(env, {
        '@domain': 'ex.org',
        genesis: true,
        ably: { key: 'id:secret' }
      }, clone, ablyApi);
      await gateway.initialise();
    });

    afterEach(async () => {
      await gateway?.close();
    });

    test('initialises against data dir', () => {
      expect(clone.mock.calls).toMatchObject([[
        {
          '@id': expect.stringMatching(/\w+/),
          '@domain': 'ex.org',
          '@context': timeldContext,
          genesis: true, // has to be true because dead remotes
          ably: { key: 'id:secret' }
        },
        join(tmpDir.name, 'data', 'gw')
      ]]);
    });

    test('has registered account', async () => {
      await gateway.domain.write({
        '@id': 'test',
        '@type': 'Account',
        email: 'test@ex.org'
      });
      await expect(gateway.account('test')).resolves.toBeInstanceOf(Account);
      await expect(gateway.account('garbage')).resolves.toBeUndefined();
    });

    test('does not activate if email not registered', async () => {
      await gateway.domain.write({
        '@id': 'test',
        '@type': 'Account',
        email: 'test@ex.org'
      });
      await expect(gateway.activation('test', 'garbage@ex.org'))
        .rejects.toBeDefined();
    });

    test('activates if email is registered', async () => {
      await gateway.domain.write({
        '@id': 'test',
        '@type': 'Account',
        email: 'test@ex.org'
      });
      const activation = await gateway.activation('test', 'test@ex.org');
      expect(activation).toEqual({
        // Hex with sensible minimum length
        jwe: expect.stringMatching(/[\da-f]{32,}/),
        code: expect.stringMatching(/\d{6}/)
      });
    });

    test('allows non-existent account', async () => {
      const activation = await gateway.activation('test', 'test@ex.org');
      expect(activation).toEqual({
        // Hex with sensible minimum length
        jwe: expect.stringMatching(/[\da-f]{32,}/),
        code: expect.stringMatching(/\d{6}/)
      });
    });

    test('rejects garbage jwt', async () => {
      expect(() => gateway.verify('garbage')).toThrow();
    });

    test('verifies own decoded jwt', async () => {
      const activation = await gateway.activation('test', 'test@ex.org');
      const jwt = new Cryptr(activation.code).decrypt(activation.jwe);
      expect(jwt).not.toBe(activation.jwe); // Some encryption did happen
      expect(gateway.verify(jwt)).toMatchObject({ email: 'test@ex.org' });
    });

    test('gets timesheet config', async () => {
      const tsConfig = await gateway.timesheetConfig('test', 'ts1');
      expect(tsConfig).toMatchObject({
        '@id': undefined,
        '@domain': 'ts1.test.ex.org',
        '@context': timeldContext,
        genesis: false,
        ably: { key: undefined } // Gateway key NOT present
      });
      // Expect to have created the timesheet genesis clone
      expect(clone).lastCalledWith(
        {
          '@id': expect.stringMatching(/\w+/),
          '@domain': 'ts1.test.ex.org',
          '@context': timeldContext,
          genesis: true,
          ably: { key: 'id:secret' }
        },
        join(tmpDir.name, 'data', 'tsh', 'test', 'ts1'));
      await expect(gateway.domain.get('test')).resolves.toEqual({
        '@id': 'test',
        timesheet: 'https://ex.org/test/ts1'
      });
    });
  });
});