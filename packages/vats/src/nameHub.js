// @ts-check

import { assert } from '@agoric/assert';
import { E, Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { mapIterable } from '@endo/marshal';
import { makeLegacyMap } from '@agoric/store';

import './types.js';

const { Fail } = assert;

/**
 * Make two facets of a node in a name hierarchy: the nameHub
 * is read access and the nameAdmin is write access.
 *
 * @returns {import('./types.js').NameHubKit}
 */
export const makeNameHubKit = () => {
  /** @typedef {Partial<PromiseRecord<unknown> & { value: unknown }>} NameRecord */
  /** @type {LegacyMap<string, NameRecord>} */
  // Legacy because a promiseKit is not a passable
  const keyToRecord = makeLegacyMap('nameKey');

  /** @type {NameHub} */
  const nameHub = Far('nameHub', {
    lookup: async (...path) => {
      if (path.length === 0) {
        return nameHub;
      }
      const [first, ...remaining] = path;
      const record = keyToRecord.get(first);
      /** @type {any} */
      const firstValue = record.promise || record.value;
      if (remaining.length === 0) {
        return firstValue;
      }
      return E(firstValue).lookup(...remaining);
    },
    entries: () => {
      return harden([
        ...mapIterable(
          keyToRecord.entries(),
          ([key, record]) =>
            /** @type {[string, ERef<unknown>]} */ ([
              key,
              record.promise || record.value,
            ]),
        ),
      ]);
    },
    values: () => {
      return [
        ...mapIterable(
          keyToRecord.values(),
          record => record.promise || record.value,
        ),
      ];
    },
    keys: () => {
      return harden([...keyToRecord.keys()]);
    },
  });

  /** @type {LegacyMap<string, NameRecord>} */
  // Legacy because a promiseKit is not a passable
  const keyToAdminRecord = makeLegacyMap('nameKey');
  /** @type {undefined | ((entries: [string, unknown][]) => ERef<void>)} */
  let updateCallback;
  const updated = () => {
    let result;
    if (updateCallback) {
      result = updateCallback(
        harden(
          [
            ...mapIterable(keyToRecord.entries(), ([name, record]) =>
              record.promise
                ? []
                : [/** @type {[string, unknown]} */ ([name, record.value])],
            ),
          ].flat(),
        ),
      );
    }
    // return Promise regardless of result type
    return Promise.resolve(result);
  };

  /** @type {import('./types.js').NameAdmin} */
  const nameAdmin = Far('nameAdmin', {
    provideChild(key, reserved = []) {
      if (
        keyToAdminRecord.has(key) &&
        'value' in keyToAdminRecord.get(key) &&
        keyToRecord.has(key) &&
        'value' in keyToRecord.get(key)
      ) {
        /** @type {import('./types.js').NameAdmin} */
        // @ts-expect-error XXX relies on callers
        // to supply NameAdmin in newAdminValue param
        // and when they do, NameHub in newValue param.
        const childAdmin = keyToAdminRecord.get(key).value;
        /** @type {import('./types.js').NameHub} */
        // @ts-expect-error XXX not quite guaranteed, is it?
        const childHub = keyToRecord.get(key).value;
        return harden({ nameHub: childHub, nameAdmin: childAdmin });
      }
      const child = makeNameHubKit();
      for (const r of reserved) {
        child.nameAdmin.reserve(r);
      }
      nameAdmin.update(key, child.nameHub, child.nameAdmin);
      return child;
    },
    reserve: async key => {
      assert.typeof(key, 'string');
      for (const map of [keyToAdminRecord, keyToRecord]) {
        if (!map.has(key)) {
          map.init(key, makePromiseKit());
        }
      }
    },
    default: (key, newValue, adminValue) => {
      assert.typeof(key, 'string');
      if (keyToRecord.has(key)) {
        const record = keyToRecord.get(key);
        if (!record.promise) {
          // Already initalized.
          return /** @type {any} */ (record.value);
        }
      }
      nameAdmin.update(key, newValue, adminValue);
      return newValue;
    },
    set: (key, newValue, adminValue) => {
      assert.typeof(key, 'string');
      let record;
      if (keyToRecord.has(key)) {
        record = keyToRecord.get(key);
      }
      (record && !record.promise) ||
        Fail`key ${key} is not already initialized`;
      nameAdmin.update(key, newValue, adminValue);
    },
    onUpdate: fn => {
      if (updateCallback) {
        assert(!fn, 'updateCallback accidentally reassigned?');
      }
      updateCallback = fn;
    },
    update: (key, newValue, adminValue) => {
      assert.typeof(key, 'string');
      /** @type {[LegacyMap<string, NameRecord>, unknown][]} */
      const valueMapEntries = [
        [keyToAdminRecord, adminValue], // The optional admin goes in the admin record.
        [keyToRecord, newValue], // The value goes in the normal record.
      ];
      for (const [map, value] of valueMapEntries) {
        const record = harden({ value });
        if (map.has(key)) {
          const old = map.get(key);
          if (old.resolve) {
            old.resolve(value);
          }
          map.set(key, record);
        } else {
          map.init(key, record);
        }
      }
      return updated();
    },
    lookupAdmin: async (...path) => {
      if (path.length === 0) {
        return nameAdmin;
      }
      const [first, ...remaining] = path;
      const record = keyToAdminRecord.get(first);
      /** @type {any} */
      const firstValue = record.promise || record.value;
      if (remaining.length === 0) {
        return firstValue;
      }
      return E(firstValue).lookupAdmin(...remaining);
    },
    delete: async key => {
      for (const map of [keyToAdminRecord, keyToRecord]) {
        if (map.has(key)) {
          // Reject only if already exists.
          const old = map.get(key);
          if (old.reject) {
            old.reject(Error(`Value has been deleted`));
            // Silence unhandled rejections.
            if (old.promise) {
              void old.promise.catch(_ => {});
            }
          }
        }
      }
      try {
        // This delete may throw.  Reflect it to callers.
        keyToRecord.delete(key);
      } finally {
        keyToAdminRecord.delete(key);
        void updated();
      }
    },
    readonly: () => nameHub,
  });

  const nameHubKit = harden({
    nameHub,
    nameAdmin,
  });
  return nameHubKit;
};
