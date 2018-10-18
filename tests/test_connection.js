import tap from 'tap';
import EtcdClient from '../src/index';

tap.test('test_connection', async (t) => {
  const context = { gb: { logger: console } };
  const etcd = new EtcdClient({ logger: console }, {
    hosts: [process.env.ETCD_URL || 'http://localhost:2379'],
  });
  const client = await etcd.start();

  const testKey = `test-key-${Date.now()}`;
  const lockKey = `lock-key-${Date.now()}`;

  const objValue = { a: true, b: 3, c: 'four', d: [1, 2, 3] };
  t.notOk(await client.get(context, testKey), 'Should start with no value');
  await client.set(context, testKey, 'helloworld', 1);
  t.strictEquals(await client.get(context, testKey), 'helloworld', 'Should get a key');
  await client.set(context, testKey, objValue, 1);
  t.same(await client.get(context, testKey), objValue, 'Should get a key with object value');
  await new Promise(accept => setTimeout(accept, 2000));
  t.notOk(await client.get(context, testKey), 'TTL should work');

  await client.set(context, testKey, 'helloworld');
  await client.del(context, testKey);
  t.notOk(await client.get(context, testKey), 'Del should work');

  const lock1 = await client.acquireLock(context, lockKey);
  let lock2;
  const lockPromise = client.acquireLock(context, lockKey).then((l) => { lock2 = l; });
  await new Promise(accept => setTimeout(accept, 100));
  t.notOk(lock2, 'After acquiring lock1, lock2 should not fulfill');
  await etcd.releaseLock(lock1);
  await lockPromise;
  t.ok(lock2, 'After releasing lock1, lock2 should fulfill');
  await etcd.releaseLock(lock2);
});
