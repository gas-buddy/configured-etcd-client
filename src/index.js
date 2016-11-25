import assert from 'assert';
import Etcd from 'node-etcd';

export default class EtcdClient {
  constructor(context, opts) {
    assert(opts, 'configured-etcd-client must be passed arguments');
    assert(opts.hosts, 'configured-etcd-client missing hosts setting');

    if (context && context.logger && context.logger.info) {
      context.logger.info('Initializing etcd client', {
        hosts: opts.hosts,
      });
    }
    this.etcd = new Etcd(opts.hosts);
  }

  async start() {
    return this.etcd;
  }
}
