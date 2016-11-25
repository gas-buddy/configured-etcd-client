import tap from 'tap';
import winston from 'winston';
import EtcdClient from '../src/index';

tap.test('test_connection', async (t) => {
  const etcd = new EtcdClient({ logger: winston }, {
    hosts: ['etcd'],
  });
  const client = await etcd.start();
  t.ok(client.get, 'Should have a get method');
  t.ok(client.set, 'Should have a set method');
});
