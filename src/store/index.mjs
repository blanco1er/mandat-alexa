// Persistence interface for Mandat for Alexa+. One logical table, keyed like the DynamoDB design:
//   pk = "HOUSEHOLD#<id>", sk ∈ PROFILE | MANDATE#<id> | ENVELOPE#<mandateId>#<period> | PREF#<id> | OFFER#<id>
//                               | PLAN#<id> | ORDER#<id> | IDEMP#<key> | EVENT#<iso ts>#<n>
// Every implementation exposes the same async methods:
//   get(pk, sk)                -> value | null
//   put(pk, sk, value)         -> void            (overwrite)
//   putIfAbsent(pk, sk, value) -> boolean         (false if the key exists: idempotency, no double payment)
//   query(pk, skPrefix)        -> [{ sk, value }] (sorted by sk)
//   delete(pk, sk)             -> void
// MANDAT_STORE: "memory" (tests), "json" (default, local file data/store.json), "dynamodb" (AWS, table MANDAT_TABLE).
import { LocalJsonStore } from './local-json.mjs';
import { DynamoDbStore } from './dynamodb.mjs';

export function createStore(kind = process.env.MANDAT_STORE || 'json') {
  if (kind === 'memory') return new LocalJsonStore({ file: null });
  if (kind === 'json') return new LocalJsonStore({});
  if (kind === 'dynamodb') return new DynamoDbStore({});
  throw new Error(`Unknown MANDAT_STORE "${kind}" (memory | json | dynamodb)`);
}

export const pkOf = (householdId) => `HOUSEHOLD#${householdId}`;
