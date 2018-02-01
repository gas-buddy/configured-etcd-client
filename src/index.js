import { EventEmitter } from 'events';
import Etcd from 'node-etcd';
import uuidv4 from 'uuid/v4';
import bluebird from 'bluebird';
import Lock, { AlreadyLockedError } from 'microlock';

function statusCode(error) {
  if (error) {
    return error.errorCode || 'unknown';
  }
  return 0;
}

export default class EtcdClient extends EventEmitter {
  constructor(context, opts) {
    super();
    const { hosts, options } = (opts || {});
    if (context && context.logger && context.logger.info) {
      context.logger.info('Initializing etcd client', {
        hosts: hosts || '<default>',
      });
    }
    this.etcd = new Etcd(hosts, options);
  }

  async start() {
    return this;
  }

  finishCall(callInfo, status) {
    this.emit('finish', { status, ...callInfo });
  }

  async get(context, key) {
    const callInfo = {
      client: this,
      context,
      key,
      method: 'get',
    };
    this.emit('start', callInfo);

    return new Promise((accept, reject) => {
      this.etcd.get(key, (error, value) => {
        this.finishCall(callInfo, statusCode(error));
        if (error && error.errorCode === 100) {
          accept();
        } else if (error) {
          reject(error);
        }
        accept(value ? JSON.parse(value.node.value) : null);
      });
    });
  }

  /**
   * ttl is in seconds
   */
  async set(context, key, value, ttl) {
    const callInfo = {
      client: this,
      context,
      key,
      value,
      ttl,
      method: 'set',
    };
    this.emit('start', callInfo);

    const stringValue = JSON.stringify(value);
    return new Promise((accept, reject) => {
      this.etcd.set(key, stringValue, { ttl }, (error) => {
        this.finishCall(callInfo, statusCode(error));
        if (error) {
          reject(error);
        } else {
          accept();
        }
      });
    });
  }

  async del(context, key) {
    const callInfo = {
      client: this,
      context,
      key,
      method: 'del',
    };
    this.emit('start', callInfo);

    return new Promise((accept, reject) => {
      this.etcd.del(key, (error) => {
        this.finishCall(callInfo, statusCode(error));
        if (error) {
          reject(error);
        } else {
          accept();
        }
      });
    });
  }

  async acquireLock(context, key, timeout = 10) {
    const callInfo = {
      client: this,
      context,
      key,
      method: 'acquireLock',
    };
    this.emit('start', callInfo);
    const lock = new Lock(this.etcd, key, uuidv4(), timeout);
    let alerted = false;
    lock.once('unlock', () => {
      alerted = true;
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await lock.lock();
        context.gb.logger.info('Acquired lock', { key });
        this.finishCall(callInfo, 'acq');
        return lock;
      } catch (error) {
        context.gb.logger.warn('Lock contention', { key, attempt });
        if (!(error instanceof AlreadyLockedError)) {
          this.finishCall(callInfo, 'err');
          throw error;
        }
        // eslint-disable-next-line no-await-in-loop
        await bluebird.delay(250 * attempt);
        if (alerted) {
          this.finishCall(callInfo, 'wait-acq');
          return lock;
        }
      }
    }
    this.finishCall(callInfo, 'timeout');
    throw new Error('Timed out waiting for lock');
  }

  // eslint-disable-next-line class-methods-use-this
  async releaseLock(lock) {
    try {
      await lock.unlock();
      await lock.destroy();
    } catch (error) {
      // Nothing to do for this error - eat it
    }
  }

  /**
   * This method is expensive. Please don't call it unless you need it.
   * For example: when making a critical area idempotent.
   * Even if you think you need it consult #guild-server-devs first.
   */
  async memoize(context, key, func, ttl = 60 * 5, timeout = 10) {
    const callInfo = {
      client: this,
      context,
      key,
      method: 'memoize',
    };

    this.emit('start', callInfo);

    const renewWait = (timeout / 2) * 1000;
    let lock;
    let value;
    let lockRenewTimeout;
    let lockRenewPromise;
    try {
      const lockKey = `${key}-lock`;
      const valueKey = `${key}-value`;
      value = await this.get(context, valueKey);
      if (value) {
        this.finishCall(callInfo, 'val-prelock');
      } else {
        lock = await this.acquireLock(context, lockKey, timeout);
        value = await this.get(context, valueKey);
        if (value) {
          this.finishCall(callInfo, 'val-postlock');
        } else {
          const renewer = () => {
            context.gb.logger.info('Renewing lock', { key: lockKey });
            lockRenewPromise = lock.renew().then(() => {
              if (lockRenewTimeout) {
                lockRenewTimeout = setTimeout(renewer, renewWait);
              }
            });
          };

          lockRenewTimeout = setTimeout(renewer, renewWait);

          value = (await func()) || {};
          await this.set(context, valueKey, value, ttl);
          this.finishCall(callInfo, 'val-eval');
        }
      }
    } catch (e) {
      this.finishCall(callInfo, 'err');
      throw e;
    } finally {
      if (lockRenewTimeout) {
        clearTimeout(lockRenewTimeout);
        lockRenewTimeout = null;
        await lockRenewPromise;
      }
      if (lock) {
        await this.releaseLock(lock);
      }
    }

    return value;
  }
}
