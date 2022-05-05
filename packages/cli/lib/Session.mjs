import { Repl } from '@m-ld/m-ld-cli/lib/Repl.js';
import { Proc, SyncProc } from '@m-ld/m-ld-cli/lib/Proc.js';
import fileCmd from '@m-ld/m-ld-cli/cmd/repl/file.js';
import { createReadStream } from 'fs';
import { truncate as truncateFile } from 'fs/promises';
import parseDuration from 'parse-duration';
import { parseDate } from 'chrono-node';
import { ResultsProc } from './ResultsProc.mjs';
import { dateJsonLd } from './util.mjs';
import { Entry } from './Entry.mjs';
import { DefaultFormat, jsonLdFormat } from './Format.mjs';

export class Session extends Repl {
  /**
   * @param {string} id unique session Id
   * @param {import('@m-ld/m-ld').MeldClone} meld
   * @param {string} prompt
   * @param {string} logFile
   * @param {string|number} logLevel
   */
  constructor(id, meld, prompt, logFile, logLevel) {
    super({ logLevel, prompt });
    this.id = id;
    this.meld = meld;
    this.logFile = logFile;
    this.startTime = new Date;
    this.nextTaskId = 1;
  }

  buildCommands(yargs, ctx) {
    const COMPLETES_TASK = '. Using this option will mark the task complete.';
    // noinspection JSCheckFunctionSignatures
    return yargs
      .updateStrings({ 'Positionals:': 'Details:' })
      .command(fileCmd(ctx))
      .command(
        'log',
        'fetch the timesheet system log',
        yargs => yargs
          .boolean('truncate')
          .boolean('status')
          .conflicts('truncate', 'status'),
        argv => ctx.exec(
          () => this.logProc(argv))
      )
      .command(
        ['add <task> [duration]', 'a', '+'],
        'Add a new timesheet entry',
        yargs => yargs
          .positional('task', {
            describe: 'The name of the task being worked on',
            type: 'string'
          })
          .positional('duration', {
            describe: 'The duration of the task e.g. 1h' + COMPLETES_TASK,
            type: 'string',
            coerce: arg => parseDuration(arg)
          })
          .option('start', {
            describe: 'The start date/time of the task',
            type: 'array',
            default: ['now'],
            coerce: arg => parseDate(arg.join(' '))
          })
          .option('end', {
            describe: 'The end date & time of the task' + COMPLETES_TASK,
            type: 'array',
            coerce: arg => parseDate(arg.join(' '))
          }),
        argv => ctx.exec(
          () => this.addTaskProc(argv))
      )
      .command(
        ['modify <selector> [duration]', 'mod', 'm'],
        'Change the value of an existing entry',
        yargs => yargs
          .positional('selector', {
            // TODO: entry by [task and] date-time e.g. "work yesterday 12pm"
            describe: 'Entry to modify, using a number or a task name'
          })
          .positional('duration', {
            describe: 'The new duration of the task e.g. 1h',
            type: 'string',
            coerce: arg => parseDuration(arg)
          })
          .option('start', {
            describe: 'The new start date & time of the task',
            type: 'array',
            coerce: arg => parseDate(arg.join(' '))
          })
          .option('end', {
            describe: 'The new end date & time of the task',
            type: 'array',
            coerce: arg => parseDate(arg.join(' '))
          })
          .check(argv => {
            if (argv.start == null && argv.end == null && argv.duration == null)
              return 'Please specify something to modify: duration, --start, or --end';
            return true;
          }),
        argv => ctx.exec(
          () => this.modifyEntryProc(argv))
      )
      .command(
        ['list [selector]', 'ls'],
        'List a selection of entries',
        yargs => yargs
          .positional('selector', {
            describe: 'A time range, like "today" or "this month"',
            type: 'string',
            default: 'today'
          })
          .option('format', {
            describe: 'Timesheet format to use',
            choices: [
              'default',
              'JSON-LD', 'json-ld', 'ld'
            ],
            default: 'default'
          }),
        argv => ctx.exec(
          () => this.listTasksProc(argv))
      );
  }

  /**
   * @param {string} selector
   * @param {'default'|'JSON-LD'} format
   * @returns {Proc}
   */
  listTasksProc({ selector, format }) {
    // TODO: selectors
    return new ResultsProc(this.meld.read({
      '@describe': '?task',
      '@where': { '@id': '?task', '@type': 'TimesheetEntry' }
    }), {
      'JSON-LD': jsonLdFormat,
      'json-ld': jsonLdFormat,
      ld: jsonLdFormat
    }[format] || new DefaultFormat(this));
  }

  /**
   * @param {string | number} selector Entry to modify, using a number or a task name
   * @param {number} [duration] in millis
   * @param {Date} [start]
   * @param {Date} [end]
   * @returns {Proc}
   */
  modifyEntryProc({ selector, duration, start, end }) {
    // TODO: selector is not specific enough?
    const proc = new PromiseProc(this.meld.write(async state => {
      async function updateEntry(src) {
        const entry = Entry.fromJSON(src);
        if (start != null)
          entry.start = start;
        if (end != null)
          entry.end = end;
        if (end == null && duration != null)
          entry.end = new Date(entry.start.getTime() + duration);
        proc.emit('message', entry.toString());
        return state.write({
          '@delete': src,
          '@insert': entry.toJSON()
        });
      }
      if (typeof selector == 'number') {
        const src = await state.get(`${this.id}/${selector}`);
        if (src != null)
          await updateEntry(src);
        else
          throw 'No such task sequence number found in this session.';
      } else {
        for (let src of await state.read({
          '@describe': '?id',
          '@where': {
            '@id': '?id',
            '@type': 'TimesheetEntry',
            task: selector
          }
        })) {
          state = await updateEntry(src);
        }
      }
    }));
    return proc;
  }

  /**
   * @param {string} task
   * @param {number} [duration] in millis
   * @param {Date} start
   * @param {Date} [end]
   * @returns {Proc}
   */
  addTaskProc({ task, duration, start, end }) {
    // TODO: Replace use of console with proc 'message' events
    if (end == null && duration != null)
      end = new Date(start.getTime() + duration);
    const entry = new Entry({
      seqNo: `${this.nextTaskId++}`, sessionId: this.id, task, start, end
    });
    const proc = new PromiseProc(this.meld.write({
      '@graph': [entry.toJSON(), this.toJSON()]
    }).then(() => {
      proc.emit('message', entry.toString());
      proc.emit('message', 'Use a "modify" command if this is wrong.');
    }));
    return proc;
  }

  /**
   * @param {boolean} [truncate]
   * @param {boolean} [status]
   * @returns {Proc}
   */
  logProc({ truncate, status }) {
    if (truncate) {
      return new PromiseProc(truncateFile(this.logFile));
    } else if (status) {
      const proc = new PromiseProc(Promise.resolve().then(() => {
        proc.emit('message', 'Status:', this.meld.status.value);
      }));
      return proc;
    } else {
      return new SyncProc(createReadStream(this.logFile));
    }
  }

  toJSON() {
    return {
      '@id': this.id,
      '@type': 'TimesheetSession',
      start: dateJsonLd(this.startTime)
    };
  }

  async close() {
    await this.meld?.close();
    await super.close();
  }
}

class PromiseProc extends Proc {
  /** @param {Promise} promise */
  constructor(promise) {
    super();
    promise.then(() => this.setDone(), this.setDone);
  }
}