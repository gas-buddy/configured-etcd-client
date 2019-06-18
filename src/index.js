import { EventEmitter } from 'events';
import assert from 'assert';
import Etcd from 'node-etcd';
import uuidv4 from 'uuid/v4';
import Lock, { AlreadyLockedError } from 'microlock';

function statusCode(error) {
  if (error) {
    return error.errorCode || 'unknown';
  }
  return 0;
}

const LOGGER = Symbol('Logger property for locks');

function unpackJson(node, prefix = '', hash = {}) {
  const { key, nodes, value } = node;
  const keyPart = key.substring(prefix.length).replace(/^\//, '');
  if (value) {
    hash[keyPart] = JSON.parse(value);
  } else {
    hash[keyPart] = {};
    nodes.forEach(subnode => unpackJson(subnode, key, hash[keyPart]));
  }
  return hash;
}

async function delay(ms) {
  return new Promise(accept => setTimeout(accept, ms));
}

export default class EtcdClient extends EventEmitter {
  constructor(context, opts) {
    super();
    const { hosts, options } = (opts || {});
    this.baseLogger = context.logger || context.gb?.logger;
    assert(this.baseLogger?.info, 'Constructor must have a logger property');
    context.logger.info('Initializing etcd client', {
      hosts: hosts || '<default>',
    });
    const finalOptions = {
      timeout: 1500,
      ...options,
    };
    this.maxRetries = (options && 'maxRetries' in options) ? options.maxRetries : 2;

    if (typeof hosts === 'string') {
      this.etcd = new Etcd(hosts.split(','), finalOptions);
    } else {
      this.etcd = new Etcd(hosts, finalOptions);
    }
  }

  async start() {
    return this;
  }

  finishCall(callInfo, status) {
    this.emit('finish', { status, ...callInfo });
  }

  getOptions(baseOptions) {
    if (!baseOptions) {
      return { maxRetries: this.maxRetries };
    }
    return {
      maxRetries: this.maxRetries,
      ...baseOptions,
    };
  }

  async get(context, key, options) {
    const callInfo = {
      client: this,
      context,
      key,
      method: 'get',
    };
    const logger = context.gb?.logger || this.baseLogger;
    logger.info('etcd get', { key });
    this.emit('start', callInfo);

    return new Promise((accept, reject) => {
      this.etcd.get(key, this.getOptions(options), (error, value) => {
        this.finishCall(callInfo, statusCode(error));
        logger.info('etcd got', { key, ok: !error });
        if (error && error.errorCode === 100) {
          accept();
        } else if (error) {
          reject(error);
        }
        if (options && options.recursive) {
          accept(value ? unpackJson(value.node) : null);
        } else {
          accept(value ? JSON.parse(value.node.value) : null);
        }
      });
    });
  }

  /**
   * ttl is in seconds
   */
  async set(context, key, value, ttlOrOptions) {
    const options = (ttlOrOptions && typeof ttlOrOptions !== 'object') ? { ttl: ttlOrOptions } : ttlOrOptions;
    const callInfo = {
      client: this,
      context,
      key,
      value,
      ttl: options?.ttl,
      method: 'set',
    };
    const logger = context.gb?.logger || this.baseLogger;
    logger.info('etcd set', { key });
    this.emit('start', callInfo);

    const stringValue = JSON.stringify(value);
    return new Promise((accept, reject) => {
      this.etcd.set(key, stringValue, this.getOptions(options), (error) => {
        this.finishCall(callInfo, statusCode(error));
        logger.info('etcd was set', { key });
        if (error) {
          reject(error);
        } else {
          accept();
        }
      });
    });
  }

  async del(context, key, options) {
    const callInfo = {
      client: this,
      context,
      key,
      method: 'del',
    };
    const logger = context.gb?.logger || this.baseLogger;
    logger.info('etcd del', { key });
    this.emit('start', callInfo);

    return new Promise((accept, reject) => {
      this.etcd.del(key, this.getOptions(options), (error) => {
        this.finishCall(callInfo, statusCode(error));
        logger.info('etcd deleted', { key });
        if (error) {
          reject(error);
        } else {
          accept();
        }
      });
    });
  }

  async acquireLock(context, key, timeout = 10, maxWait = 30) {
    const callInfo = {
      client: this,
      context,
      key,
      method: 'acquireLock',
    };
    const logger = context.gb?.logger || this.baseLogger;
    logger.info('etcd acquire', { key });
    this.emit('start', callInfo);
    const lock = new Lock(this.etcd, key, uuidv4(), timeout);
    lock[LOGGER] = { logger, key };
    let alerted = false;
    lock.once('unlock', () => {
      alerted = true;
    });
    const startTime = Date.now();
    let attempt = 0;
    while (Date.now() - startTime < maxWait * 1000) {
      attempt += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        await lock.lock();
        const waitTime = Date.now() - startTime;
        logger.info('Acquired lock', { key, waitTime });
        this.finishCall(callInfo, 'acq');
        return lock;
      } catch (error) {
        logger.warn('Lock contention', { key, attempt });
        if (!(error instanceof AlreadyLockedError)) {
          this.finishCall(callInfo, 'err');
          throw error;
        }
        // eslint-disable-next-line no-await-in-loop
        await delay(250 * attempt);
        if (alerted) {
          this.finishCall(callInfo, 'wait-acq');
          return lock;
        }
      }
    }
    this.finishCall(callInfo, 'timeout');
    const waitTime = Date.now() - startTime;
    const error = new Error('Timed out waiting for lock');
    error.waitTime = waitTime;
    throw error;
  }

  // eslint-disable-next-line class-methods-use-this
  async releaseLock(lock) {
    try {
      const { key, logger } = lock[LOGGER] || {};
      await lock.unlock();
      await lock.destroy();
      if (logger) {
        logger.info('Lock released', { key });
        delete lock[LOGGER];
      }
    } catch (error) {
      // Nothing to do for this error - eat it
    }
  }

  /**
   * This method is expensive. Please don't call it unless you need it.
   * For example: when making a critical area idempotent.
   * Even if you think you need it consult #guild-server-devs first.
   */
  async memoize(context, key, func, ttl = 60 * 5, timeout = 10, maxWait = 30) {
    const callInfo = {
      client: this,
      context,
      key,
      method: 'memoize',
    };

    const logger = context.gb?.logger || this.baseLogger;
    logger.info('etcd memoize', { key });
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
        lock = await this.acquireLock(context, lockKey, timeout, maxWait);
        value = await this.get(context, valueKey);
        if (value) {
          this.finishCall(callInfo, 'val-postlock');
        } else {
          const renewer = () => {
            logger.info('Renewing lock', { key: lockKey });
            lockRenewPromise = lock.renew().then(() => {
              if (lockRenewTimeout) {
                lockRenewTimeout = setTimeout(renewer, renewWait);
              }
            });
          };

          lockRenewTimeout = setTimeout(renewer, renewWait);

          value = (await func()) || {};
          if (ttl !== 0) {
            await this.set(context, valueKey, value, ttl);
          }
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
