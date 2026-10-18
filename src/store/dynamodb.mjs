// DynamoDB store (stub, ready for the AWS account): one on-demand table, PK (string) + SK (string), the value in
// attribute "v" (a map). The command inputs are built by pure functions (unit-tested without AWS); the client is
// imported lazily from @aws-sdk/client-dynamodb + @aws-sdk/lib-dynamodb, which the Lambda Node.js runtime already
// ships (AWS SDK v3), so nothing AWS is loaded or called in local runs and tests.
// Env: MANDAT_TABLE (default "mandat"), AWS_REGION (default us-east-1). Credentials: the Lambda role, never a file.
const TABLE = () => process.env.MANDAT_TABLE || 'mandat';

export const commands = {
  get: (pk, sk) => ({ TableName: TABLE(), Key: { PK: pk, SK: sk }, ConsistentRead: true }),
  // Live-activity rows (ACT#…) expire after a day through the table's TTL attribute "ttl" (enabled by the deploy).
  // OAuth codes and tokens (OAUTH#…) expire with their own exp (seconds), plus a day of grace for reuse detection.
  put: (pk, sk, value) => ({ TableName: TABLE(), Item: { PK: pk, SK: sk, v: value, updatedAt: new Date().toISOString(), ...(sk.startsWith('ACT#') ? { ttl: Math.floor(Date.now() / 1000) + 86400 } : pk.startsWith('OAUTH#') && Number(value?.exp) ? { ttl: Number(value.exp) + 86400 } : {}) } }),
  // Idempotency: the write only happens if the key does not exist yet (confirm_plan uses IDEMP#<plan_id>).
  putIfAbsent: (pk, sk, value) => ({ ...commands.put(pk, sk, value), ConditionExpression: 'attribute_not_exists(PK)' }),
  query: (pk, prefix) => ({
    TableName: TABLE(),
    KeyConditionExpression: prefix ? 'PK = :pk AND begins_with(SK, :p)' : 'PK = :pk',
    ExpressionAttributeValues: prefix ? { ':pk': pk, ':p': prefix } : { ':pk': pk },
    ConsistentRead: true,
  }),
  delete: (pk, sk) => ({ TableName: TABLE(), Key: { PK: pk, SK: sk } }),
  // Atomic counter (the shared LLM spend ledger): ADD n to attribute "n".
  add: (pk, sk, n) => ({ TableName: TABLE(), Key: { PK: pk, SK: sk }, UpdateExpression: 'ADD n :n SET updatedAt = :t', ExpressionAttributeValues: { ':n': n, ':t': new Date().toISOString() } }),
};

export class DynamoDbStore {
  constructor() { this.kind = 'dynamodb'; this.doc = null; }
  async client() {
    if (this.doc) return this.doc;
    let ddb, lib;
    try {
      ddb = await import('@aws-sdk/client-dynamodb');
      lib = await import('@aws-sdk/lib-dynamodb');
    } catch {
      throw new Error('MANDAT_STORE=dynamodb needs the AWS SDK v3 (bundled in the Lambda Node.js runtime; locally: npm i @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb).');
    }
    this.lib = lib;
    this.doc = lib.DynamoDBDocumentClient.from(new ddb.DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' }), { marshallOptions: { removeUndefinedValues: true } });
    return this.doc;
  }
  async get(pk, sk) { const c = await this.client(); return (await c.send(new this.lib.GetCommand(commands.get(pk, sk)))).Item?.v ?? null; }
  async put(pk, sk, value) { const c = await this.client(); await c.send(new this.lib.PutCommand(commands.put(pk, sk, value))); }
  async putIfAbsent(pk, sk, value) {
    const c = await this.client();
    try { await c.send(new this.lib.PutCommand(commands.putIfAbsent(pk, sk, value))); return true; } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  }
  async query(pk, prefix = '') {
    const c = await this.client();
    const out = [];
    let ExclusiveStartKey;
    do {
      const r = await c.send(new this.lib.QueryCommand({ ...commands.query(pk, prefix), ExclusiveStartKey }));
      for (const it of r.Items || []) out.push({ sk: it.SK, value: it.v });
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }
  async delete(pk, sk) { const c = await this.client(); await c.send(new this.lib.DeleteCommand(commands.delete(pk, sk))); }
  // Shared spend ledger for core/spend.mjs: one item, PK "SPEND", SK "LLM", attribute n = USD spent on models.
  ledger(pk = 'SPEND', sk = 'LLM') {
    return {
      total: async () => { const c = await this.client(); return Number((await c.send(new this.lib.GetCommand(commands.get(pk, sk)))).Item?.n || 0); },
      add: async (usd) => { const c = await this.client(); await c.send(new this.lib.UpdateCommand(commands.add(pk, sk, usd))); },
    };
  }
}
