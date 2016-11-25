import Etcd from 'node-etcd';

export default class EtcdClient {
  constructor(context, opts) {
    const { hosts, options } = (opts || {});
    if (context && context.logger && context.logger.info) {
      context.logger.info('Initializing etcd client', {
        hosts: hosts || '<default>',
      });
    }
    this.etcd = new Etcd(hosts, options);
  }

  async start() {
    return this.etcd;
  }
}
