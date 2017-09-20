import tap from 'tap';
import winston from 'winston';
import EtcdClient from '../src/index';

tap.test('test_get_event', async (t) => {
  const context = { logger: winston };
  const etcd = new EtcdClient(context);
  const client = await etcd.start();
  const keyName = 'testkey';

  client.addListener('start', (info) => {
    t.equal(info.key, keyName);
    t.equal(info.method, 'get');
  });
  client.addListener('finish', (info) => {
    t.equal(info.key, keyName);
    t.equal(info.method, 'get');
  });

  await client.get(context, keyName);
});

tap.test('test_set_event', async (t) => {
  const context = { logger: winston };
  const etcd = new EtcdClient(context);
  const client = await etcd.start();
  const keyName = 'testkey';

  client.addListener('start', (info) => {
    t.equal(info.key, keyName);
    t.equal(info.method, 'set');
  });

  client.addListener('finish', (info) => {
    t.equal(info.key, keyName);
    t.equal(info.method, 'set');
  });

  await client.set(context, keyName, { a: 1 }, 60);
});
