import tap from 'tap';
import winston from 'winston';
import uuidv4 from 'uuid/v4';
import EtcdClient from '../src/index';

tap.test('test_memoize', async (t) => {
  const context = { logger: winston };
  context.gb = context;
  const etcd = new EtcdClient(context, {
    hosts: [process.env.ETCD_URL || 'http://localhost:2379'],
  });
  const client = await etcd.start();

  const key = uuidv4();
  const oldValue = uuidv4();
  const newValue = uuidv4();
  let value = oldValue;

  const memoFunc = () => value;

  let result = await client.memoize(context, key, memoFunc);
  t.strictEquals(memoFunc(), oldValue);
  t.strictEquals(result, oldValue);

  value = newValue;

  result = await client.memoize(context, key, memoFunc);
  t.strictEquals(memoFunc(), newValue);
  t.strictEquals(result, oldValue);
});
