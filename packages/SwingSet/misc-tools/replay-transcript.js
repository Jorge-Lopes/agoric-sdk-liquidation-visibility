// @ts-check

/* global WeakRef FinalizationRegistry */
/* eslint-disable no-constant-condition */
import fs from 'fs';
// import '@endo/init';
import '../tools/install-ses-debug.js';
import zlib from 'zlib';
import readline from 'readline';
import process from 'process';
import { spawn } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { pipeline } from 'stream';
import { performance } from 'perf_hooks';
// eslint-disable-next-line import/no-extraneous-dependencies
import { file as tmpFile, tmpName } from 'tmp';
// eslint-disable-next-line import/no-extraneous-dependencies
import sqlite3 from 'better-sqlite3';
import bundleSource from '@endo/bundle-source';
import { makeMeasureSeconds } from '@agoric/internal';
import { makeSnapStore } from '@agoric/swing-store';
import { entryPaths as lockdownEntryPaths } from '@agoric/xsnap-lockdown/src/paths.js';
import { entryPaths as supervisorEntryPaths } from '@agoric/swingset-xsnap-supervisor/src/paths.js';
import { waitUntilQuiescent } from '../src/lib-nodejs/waitUntilQuiescent.js';
import { makeStartXSnap } from '../src/controller/startXSnap.js';
import { makeXsSubprocessFactory } from '../src/kernel/vat-loader/manager-subprocess-xsnap.js';
import { makeLocalVatManagerFactory } from '../src/kernel/vat-loader/manager-local.js';
import { requireIdentical } from '../src/kernel/vat-loader/transcript.js';
import { makeDummyMeterControl } from '../src/kernel/dummyMeterControl.js';
import { makeGcAndFinalize } from '../src/lib-nodejs/gc-and-finalize.js';
import engineGC from '../src/lib-nodejs/engine-gc.js';

// Rebuild the bundles when starting the replay.
// Disable if bundles were previously extracted form a Kernel DB, or
// to save a few seconds and rely upon previously built versions instead
const REBUILD_BUNDLES = false;

// Enable to continue if snapshot hash doesn't match transcript
const IGNORE_SNAPSHOT_HASH_DIFFERENCES = true;

const FORCED_SNAPSHOT_INITIAL = 2;
const FORCED_SNAPSHOT_INTERVAL = 1000;
const FORCED_RELOAD_FROM_SNAPSHOT = true;
const KEEP_WORKER_RECENT = 10;
const KEEP_WORKER_INITIAL = 0;
const KEEP_WORKER_INTERVAL = 10;
const KEEP_WORKER_EXPLICIT_LOAD = true;
const KEEP_WORKER_DIVERGENT_SNAPSHOTS = true;
const KEEP_WORKER_TRANSACTION_NUMS = [];

const SKIP_EXTRA_SYSCALLS = true;
const SIMULATE_VC_SYSCALLS = true;

// Use a simplified snapstore which derives the snapshot filename from the
// transcript and doesn't compress the snapshot
const USE_CUSTOM_SNAP_STORE = false;

// Enable to output xsnap debug traces corresponding to the transcript replay
const RECORD_XSNAP_TRACE = false;

const USE_XSNAP_DEBUG = false;

const pipe = promisify(pipeline);

/** @type {(filename: string) => Promise<string>} */
async function fileHash(filename) {
  const hash = createHash('sha256');
  const input = fs.createReadStream(filename);
  await pipe(input, hash);
  return hash.digest('hex');
}

function makeSnapStoreIO() {
  return {
    createReadStream: fs.createReadStream,
    createWriteStream: fs.createWriteStream,
    measureSeconds: makeMeasureSeconds(performance.now),
    open: fs.promises.open,
    stat: fs.promises.stat,
    tmpFile,
    tmpName,
    unlink: fs.promises.unlink,
  };
}

async function makeBundles() {
  // we explicitly re-bundle these entry points, rather than using
  // getLockdownBundle(), because if you're calling this, you're
  // probably editing the sources anyways
  const lockdownPath = lockdownEntryPaths.lockdown;
  const lockdown = await bundleSource(lockdownPath, 'nestedEvaluate');
  const supervisorPath = supervisorEntryPaths.supervisor;
  const supervisor = await bundleSource(supervisorPath, 'nestedEvaluate');
  fs.writeFileSync('lockdown-bundle', JSON.stringify(lockdown));
  fs.writeFileSync('supervisor-bundle', JSON.stringify(supervisor));
  console.log(`xs bundles written`);
}

// relative timings:
// 3.8s v8-false, 27.5s v8-gc
// 10.8s xs-no-gc, 15s xs-gc
/** @type {import('../src/types-external.js').ManagerType} */
const worker = 'xs-worker';

async function replay(transcriptFile) {
  let vatID; // we learn this from the first line of the transcript
  /** @type {import('../src/types-internal.js').VatManagerFactory} */
  let factory;

  let loadSnapshotID = null;
  let saveSnapshotID = null;
  let lastTranscriptNum = 0;
  let startTranscriptNum;
  const snapshotOverrideMap = new Map();

  const snapshotActivityFd = fs.openSync('snapshot-activity.jsonl', 'a');

  const fakeKernelKeeper =
    /** @type {import('../src/types-external.js').KernelKeeper} */ ({
      provideVatKeeper: _vatID =>
        /** @type {import('../src/types-external.js').VatKeeper} */ (
          /** @type {Partial<import('../src/types-external.js').VatKeeper>} */ ({
            addToTranscript: () => {},
            getLastSnapshot: () =>
              loadSnapshotID && { snapshotID: loadSnapshotID },
          })
        ),
      getRelaxDurabilityRules: () => false,
    });

  const kernelSlog =
    /** @type {import('../src/types-external.js').KernelSlog} */ (
      /** @type {Partial<import('../src/types-external.js').KernelSlog>} */ ({
        write() {},
        delivery: () => () => undefined,
        syscall: () => () => undefined,
      })
    );

  const snapStore = USE_CUSTOM_SNAP_STORE
    ? /** @type {SnapStore} */ ({
        async saveSnapshot(_vatID, endPos, saveRaw) {
          const snapFile = `${vatID}-${endPos}-${
            saveSnapshotID || 'unknown'
          }.xss`;
          await saveRaw(snapFile);
          const hash = await fileHash(snapFile);
          const filePath = `${vatID}-${endPos}-${hash}.xss`;
          await fs.promises.rename(snapFile, filePath);
          return { hash };
        },
        async loadSnapshot(hash, loadRaw) {
          const snapFile = `${hash}.xss`;
          return loadRaw(snapFile);
        },
      })
    : makeSnapStore(
        sqlite3(':memory:'),
        () => {},
        makeSnapStoreIO(),
        undefined,
        {
          keepSnapshots: true,
        },
      );
  const testLog = () => {};
  const meterControl = makeDummyMeterControl();
  const gcTools = harden({
    WeakRef,
    FinalizationRegistry,
    waitUntilQuiescent,
    gcAndFinalize: makeGcAndFinalize(engineGC),
    meterControl,
  });
  const allVatPowers =
    /** @type {import('../src/types-external.js').VatPowers} */ (
      /** @type {Partial<import('../src/types-external.js').VatPowers>} */ ({
        testLog,
      })
    );
  /**
   * @typedef {{
   *  manager: import('../src/types-internal.js').VatManager;
   *  xsnapPID: number | undefined;
   *  deliveryTimeTotal: number;
   *  deliveryTimeSinceLastSnapshot: number;
   *  loadSnapshotID: string | undefined;
   *  keep: boolean;
   *  firstTranscriptNum: number | null;
   * }} WorkerData
   */
  /** @type {WorkerData[]} */
  const workers = [];

  if (worker === 'xs-worker') {
    // eslint-disable-next-line no-constant-condition
    if (REBUILD_BUNDLES) {
      console.log(`creating xsnap helper bundles`);
      await makeBundles();
      console.log(`xsnap helper bundles created`);
    }
    const bundles = [
      JSON.parse(fs.readFileSync('lockdown-bundle', 'utf-8')),
      JSON.parse(fs.readFileSync('supervisor-bundle', 'utf-8')),
    ];

    const capturePIDSpawn = /** @type {typeof spawn} */ (
      /** @param  {Parameters<typeof spawn>} args */
      (...args) => {
        const child = spawn(...args);
        workers[workers.length - 1].xsnapPID = child.pid;
        return child;
      }
    );
    const startXSnap = makeStartXSnap({
      snapStore,
      spawn: capturePIDSpawn,
      debug: USE_XSNAP_DEBUG,
      workerTraceRootPath: RECORD_XSNAP_TRACE ? process.cwd() : undefined,
      overrideBundles: bundles,
      bundleHandler: /** @type {*} */ (undefined),
    });
    factory = makeXsSubprocessFactory({
      allVatPowers,
      kernelKeeper: fakeKernelKeeper,
      kernelSlog,
      startXSnap,
      testLog,
    });
  } else if (worker === 'local') {
    factory = makeLocalVatManagerFactory({
      allVatPowers,
      kernelKeeper: fakeKernelKeeper,
      vatEndowments: {},
      gcTools,
      kernelSlog,
    });
  } else {
    throw Error(`unhandled worker type ${worker}`);
  }

  const [
    bestRequireIdentical,
    extraSyscall,
    missingSyscall,
    vcSyscallRE,
    supportsRelaxedSyscalls,
  ] = await (async () => {
    /** @type {any} */
    const transcriptModule = await import(
      '../src/kernel/vat-loader/transcript.js'
    );

    /** @type {RegExp} */
    const syscallRE =
      transcriptModule.vcSyscallRE || /^vc\.\d+\.\|(?:schemata|label)$/;

    if (
      typeof transcriptModule.requireIdenticalExceptStableVCSyscalls !==
      'function'
    ) {
      return [
        requireIdentical,
        Symbol('never extra'),
        Symbol('never missing'),
        syscallRE,
        false,
      ];
    }

    /** @type {{requireIdenticalExceptStableVCSyscalls: import('../src/kernel/vat-loader/transcript.js').CompareSyscalls}} */
    const { requireIdenticalExceptStableVCSyscalls } = transcriptModule;

    if (
      typeof transcriptModule.extraSyscall === 'symbol' &&
      typeof transcriptModule.missingSyscall === 'symbol'
    ) {
      return [
        requireIdenticalExceptStableVCSyscalls,
        /** @type {symbol} */ (transcriptModule.extraSyscall),
        /** @type {symbol} */ (transcriptModule.missingSyscall),
        syscallRE,
        true,
      ];
    }

    /** @type {unknown} */
    const dynamicExtraSyscall = requireIdenticalExceptStableVCSyscalls(
      'vat0',
      ['vatstoreGet', 'vc.0.|label'],
      ['vatstoreGet', 'ignoreExtraSyscall'],
    );
    /** @type {unknown} */
    const dynamicMissingSyscall = requireIdenticalExceptStableVCSyscalls(
      'vat0',
      ['vatstoreGet', 'ignoreMissingSyscall'],
      ['vatstoreGet', 'vc.0.|label'],
    );

    return [
      requireIdenticalExceptStableVCSyscalls,
      typeof dynamicExtraSyscall === 'symbol'
        ? dynamicExtraSyscall
        : Symbol('never extra'),
      typeof dynamicMissingSyscall === 'symbol'
        ? dynamicMissingSyscall
        : Symbol('never missing'),
      syscallRE,
      typeof dynamicExtraSyscall === 'symbol' &&
        typeof dynamicMissingSyscall === 'symbol',
    ];
  })();

  if (
    (SIMULATE_VC_SYSCALLS || SKIP_EXTRA_SYSCALLS) &&
    !supportsRelaxedSyscalls
  ) {
    console.warn(
      'Transcript replay does not support relaxed replay. Cannot simulate or skip syscalls',
    );
  }

  /** @type {Map<string, import('@agoric/swingset-liveslots').VatSyscallResult | undefined>} */
  const knownVCSyscalls = new Map();

  /**
   * @param {import('../src/types-external.js').VatSyscallObject} vso
   */
  const vatSyscallHandler = vso => {
    if (vso[0] === 'vatstoreGet') {
      const response = knownVCSyscalls.get(vso[1]);

      if (!response) {
        throw new Error(`Unknown vc vatstore entry ${vso[1]}`);
      }

      return response;
    }

    throw new Error(`Unexpected syscall ${vso[0]}(${vso.slice(1).join(', ')})`);
  };

  /**
   * @param {WorkerData} workerData
   * @returns {import('../src/kernel/vat-loader/transcript.js').CompareSyscalls}
   */
  const makeCompareSyscalls =
    workerData => (_vatID, originalSyscall, newSyscall, originalResponse) => {
      const error = bestRequireIdentical(vatID, originalSyscall, newSyscall);
      if (
        error &&
        JSON.stringify(originalSyscall).indexOf('error:liveSlots') !== -1
      ) {
        return undefined; // Errors are serialized differently, sometimes
      }

      if (error) {
        console.error(
          `during transcript num= ${lastTranscriptNum} for worker PID ${workerData.xsnapPID} (start delivery ${workerData.firstTranscriptNum})`,
        );

        if (
          // @ts-expect-error may be a symbol in some versions
          error === extraSyscall &&
          !SKIP_EXTRA_SYSCALLS
        ) {
          return new Error('Extra syscall disallowed');
        }
      }

      const newSyscallKind = newSyscall[0];

      if (
        // @ts-expect-error may be a symbol in some versions
        error === missingSyscall &&
        !SIMULATE_VC_SYSCALLS
      ) {
        return new Error('Missing syscall disallowed');
      }

      if (
        SIMULATE_VC_SYSCALLS &&
        supportsRelaxedSyscalls &&
        !error &&
        (newSyscallKind === 'vatstoreGet' ||
          newSyscallKind === 'vatstoreSet') &&
        vcSyscallRE.test(newSyscall[1])
      ) {
        if (newSyscallKind === 'vatstoreGet') {
          if (originalResponse !== undefined) {
            knownVCSyscalls.set(newSyscall[1], originalResponse);
          } else if (!knownVCSyscalls.has(newSyscall[1])) {
            console.warn(
              `Cannot store vc syscall result for vatstoreGet(${newSyscall[1]})`,
            );
            knownVCSyscalls.set(newSyscall[1], undefined);
          }
        } else if (newSyscallKind === 'vatstoreSet') {
          knownVCSyscalls.set(newSyscall[1], ['ok', newSyscall[2]]);
        }
      }

      return error;
    };

  let vatParameters;
  let vatSourceBundle;

  /** @param {boolean} keep */
  const createManager = async keep => {
    /** @type {WorkerData} */
    const workerData = {
      manager: /** @type {WorkerData['manager']} */ (
        /** @type {unknown} */ (undefined)
      ),
      xsnapPID: NaN,
      deliveryTimeTotal: 0,
      deliveryTimeSinceLastSnapshot: 0,
      loadSnapshotID,
      keep,
      firstTranscriptNum: null,
    };
    workers.push(workerData);
    const managerOptions =
      /** @type {import('../src/types-internal.js').ManagerOptions} */ (
        /** @type {Partial<import('../src/types-internal.js').ManagerOptions>} */ ({
          sourcedConsole: console,
          vatParameters,
          compareSyscalls: makeCompareSyscalls(workerData),
          useTranscript: true,
        })
      );
    workerData.manager = await factory.createFromBundle(
      vatID,
      vatSourceBundle,
      managerOptions,
      {},
      vatSyscallHandler,
    );
    return workerData;
  };

  let loadLock = Promise.resolve();
  const loadSnapshot = async (data, keep = false) => {
    if (worker !== 'xs-worker') {
      return;
    }
    await loadLock;

    await Promise.all(
      workers
        .filter(
          ({ firstTranscriptNum, keep: keepRequested }, idx) =>
            firstTranscriptNum != null &&
            !(
              keepRequested ||
              (KEEP_WORKER_INTERVAL &&
                Math.floor(
                  (firstTranscriptNum - startTranscriptNum) /
                    FORCED_SNAPSHOT_INTERVAL,
                ) %
                  KEEP_WORKER_INTERVAL ===
                  0) ||
              idx < KEEP_WORKER_INITIAL ||
              idx >= workers.length - KEEP_WORKER_RECENT ||
              KEEP_WORKER_TRANSACTION_NUMS.includes(firstTranscriptNum)
            ),
        )
        .map(async workerData => {
          workers.splice(workers.indexOf(workerData), 1);

          const {
            manager,
            xsnapPID,
            deliveryTimeSinceLastSnapshot,
            deliveryTimeTotal,
            firstTranscriptNum,
          } = workerData;
          // eslint-disable-next-line no-await-in-loop
          await manager.shutdown();
          console.log(
            `Shutdown worker PID ${xsnapPID} (start delivery ${firstTranscriptNum}).\n    Delivery time since last snapshot ${
              Math.round(deliveryTimeSinceLastSnapshot) / 1000
            }s. Delivery time total ${
              Math.round(deliveryTimeTotal) / 1000
            }s. Up ${
              lastTranscriptNum - (firstTranscriptNum ?? NaN)
            } deliveries.`,
          );
        }),
    );

    loadSnapshotID = data.snapshotID;
    /** @type {() => void} */
    let releaseLock;
    loadLock = new Promise(resolve => {
      releaseLock = resolve;
    });
    // @ts-expect-error
    assert(releaseLock);
    try {
      if (snapshotOverrideMap.has(loadSnapshotID)) {
        loadSnapshotID = snapshotOverrideMap.get(loadSnapshotID);
      }
      const existingWorkerData = workers.find(
        workerData => workerData.loadSnapshotID === loadSnapshotID,
      );
      if (existingWorkerData) {
        existingWorkerData.keep ||= !!keep;
        console.log(
          `found an existing manager for snapshot ${loadSnapshotID}, skipping duplicate creation`,
        );
        return;
      }
      if (data.vatID) {
        vatID = data.vatID;
      }
      const { xsnapPID } = await createManager(keep);
      console.log(
        `created manager from snapshot ${loadSnapshotID}, worker PID: ${xsnapPID}`,
      );
      fs.writeSync(
        snapshotActivityFd,
        `${JSON.stringify({
          transcriptFile,
          type: 'load',
          xsnapPID,
          vatID,
          snapshotID: data.snapshotID,
          loadSnapshotID,
        })}\n`,
      );
    } finally {
      loadSnapshotID = null;
      releaseLock();
    }
  };

  /** @type {import('stream').Readable} */
  let transcriptF = fs.createReadStream(transcriptFile);
  if (transcriptFile.endsWith('.gz')) {
    transcriptF = transcriptF.pipe(zlib.createGunzip());
  }
  const lines = readline.createInterface({ input: transcriptF });
  let lineNumber = 1;
  for await (const line of lines) {
    if (lineNumber % 1000 === 0) {
      console.log(` (slog line ${lineNumber})`);
    }
    lineNumber += 1;
    const data = JSON.parse(line);
    if (data.type === 'heap-snapshot-load') {
      if (worker === 'xs-worker') {
        await loadSnapshot(data, KEEP_WORKER_EXPLICIT_LOAD);
      } else if (!workers.length) {
        throw Error(
          `Cannot replay transcript in ${worker} starting with a heap snapshot load.`,
        );
      }
    } else if (!workers.length) {
      if (data.type !== 'create-vat') {
        throw Error(
          `first line of transcript was not a create-vat or heap-snapshot-load`,
        );
      }
      ({ vatParameters, vatSourceBundle } = data);
      vatID = data.vatID;
      const { xsnapPID } = await createManager(KEEP_WORKER_EXPLICIT_LOAD);
      console.log(
        `manager created from bundle source, worker PID: ${xsnapPID}`,
      );
      fs.writeSync(
        snapshotActivityFd,
        `${JSON.stringify({
          transcriptFile,
          type: 'create',
          xsnapPID,
          vatID,
        })}\n`,
      );
    } else if (data.type === 'heap-snapshot-save') {
      saveSnapshotID = data.snapshotID;

      /** @param {WorkerData} workerData */
      const doWorkerSnapshot = async workerData => {
        const { manager, xsnapPID, firstTranscriptNum } = workerData;
        if (!manager.makeSnapshot) return null;
        const { hash, rawSaveSeconds } = await manager.makeSnapshot(
          lastTranscriptNum,
          snapStore,
        );
        fs.writeSync(
          snapshotActivityFd,
          `${JSON.stringify({
            transcriptFile,
            type: 'save',
            xsnapPID,
            vatID,
            transcriptNum: lastTranscriptNum,
            snapshotID: hash,
            saveSnapshotID,
          })}\n`,
        );
        if (hash !== saveSnapshotID) {
          const errorMessage = `Snapshot hash does not match. ${hash} !== ${saveSnapshotID} for worker PID ${xsnapPID} (start delivery ${firstTranscriptNum})`;
          if (IGNORE_SNAPSHOT_HASH_DIFFERENCES) {
            console.warn(errorMessage);
          } else {
            throw new Error(errorMessage);
          }
        } else {
          console.log(
            `made snapshot ${hash} of worker PID ${xsnapPID} (start delivery ${firstTranscriptNum}).\n    Save time = ${
              Math.round(rawSaveSeconds * 1000) / 1000
            }s. Delivery time since last snapshot ${
              Math.round(workerData.deliveryTimeSinceLastSnapshot) / 1000
            }s. Up ${
              lastTranscriptNum - (workerData.firstTranscriptNum ?? NaN)
            } deliveries.`,
          );
        }
        workerData.deliveryTimeSinceLastSnapshot = 0;
        return hash;
      };
      const savedSnapshots = await (USE_CUSTOM_SNAP_STORE
        ? workers.reduce(
            async (hashes, workerData) => [
              ...(await hashes),
              await doWorkerSnapshot(workerData),
            ],
            Promise.resolve(/** @type {(string| null)[]} */ ([])),
          )
        : Promise.all(workers.map(doWorkerSnapshot)));
      saveSnapshotID = null;

      const uniqueSnapshotIDs = new Set(savedSnapshots);
      let divergent = uniqueSnapshotIDs.size > 1;
      if (
        !uniqueSnapshotIDs.has(data.snapshotID) &&
        (divergent || savedSnapshots[0] !== null)
      ) {
        divergent = true;
        snapshotOverrideMap.set(
          data.snapshotID,
          /** @type {string} */ (savedSnapshots[0]),
        );
      }
      if (FORCED_RELOAD_FROM_SNAPSHOT) {
        for (const snapshotID of uniqueSnapshotIDs) {
          // eslint-disable-next-line no-await-in-loop
          await loadSnapshot(
            { ...data, snapshotID },
            KEEP_WORKER_DIVERGENT_SNAPSHOTS && divergent,
          );
        }
      }
    } else {
      const { transcriptNum, d: delivery, syscalls } = data;
      lastTranscriptNum = transcriptNum;
      if (startTranscriptNum == null) {
        startTranscriptNum = transcriptNum - 1;
      }
      const makeSnapshot =
        FORCED_SNAPSHOT_INTERVAL &&
        (transcriptNum - FORCED_SNAPSHOT_INITIAL) % FORCED_SNAPSHOT_INTERVAL ===
          0;
      // syscalls = [{ d, response }, ..]
      // console.log(`replaying:`);
      // console.log(
      //   `delivery ${transcriptNum} (L ${lineNumber}):`,
      //   JSON.stringify(delivery).slice(0, 200),
      // );
      // for (const s of syscalls) {
      //   // s.response = 'nope';
      //   console.log(
      //     ` syscall:`,
      //     s.response[0],
      //     JSON.stringify(s.d).slice(0, 200),
      //     JSON.stringify(s.response[1]).slice(0, 200),
      //   );
      // }
      const start = performance.now();
      const snapshotIDs = await Promise.all(
        workers.map(async workerData => {
          const { manager, xsnapPID } = workerData;
          await manager.replayOneDelivery(delivery, syscalls, transcriptNum);
          const deliveryTime = performance.now() - start;
          workerData.deliveryTimeTotal += deliveryTime;
          workerData.deliveryTimeSinceLastSnapshot += deliveryTime;
          workerData.firstTranscriptNum ??= transcriptNum - 1;

          // console.log(`dr`, dr);

          // enable this to write periodic snapshots, for #5975 leak
          if (makeSnapshot && manager.makeSnapshot) {
            const { hash: snapshotID, rawSaveSeconds } =
              await manager.makeSnapshot(transcriptNum, snapStore);
            fs.writeSync(
              snapshotActivityFd,
              `${JSON.stringify({
                transcriptFile,
                type: 'save',
                xsnapPID,
                vatID,
                transcriptNum,
                snapshotID,
              })}\n`,
            );
            console.log(
              `made snapshot ${snapshotID} after delivery ${transcriptNum} to worker PID ${xsnapPID} (start delivery ${
                workerData.firstTranscriptNum
              }).\n    Save time = ${
                Math.round(rawSaveSeconds * 1000) / 1000
              }s. Delivery time since last snapshot ${
                Math.round(workerData.deliveryTimeSinceLastSnapshot) / 1000
              }s. Up ${
                transcriptNum - workerData.firstTranscriptNum
              } deliveries.`,
            );
            workerData.deliveryTimeSinceLastSnapshot = 0;
            return snapshotID;
          } else {
            return null;
          }
        }),
      );
      const uniqueSnapshotIDs = [...new Set(snapshotIDs)].filter(
        snapshotID => snapshotID != null,
      );

      const divergent = uniqueSnapshotIDs.length !== 1;

      if (makeSnapshot && divergent) {
        const errorMessage = `Snapshot hashes do not match each other: ${uniqueSnapshotIDs.join(
          ', ',
        )}`;
        if (IGNORE_SNAPSHOT_HASH_DIFFERENCES) {
          console.warn(errorMessage);
        } else {
          throw new Error(errorMessage);
        }
      }

      if (FORCED_RELOAD_FROM_SNAPSHOT) {
        for (const snapshotID of uniqueSnapshotIDs) {
          // eslint-disable-next-line no-await-in-loop
          await loadSnapshot(
            {
              snapshotID,
              vatID,
            },
            KEEP_WORKER_DIVERGENT_SNAPSHOTS && divergent,
          );
        }
      }
    }
  }

  lines.close();
  fs.closeSync(snapshotActivityFd);
  await Promise.all(
    workers.map(
      async ({
        xsnapPID,
        manager,
        deliveryTimeSinceLastSnapshot,
        deliveryTimeTotal,
        firstTranscriptNum,
      }) => {
        await manager.shutdown();
        console.log(
          `Shutdown worker PID ${xsnapPID} (start delivery ${firstTranscriptNum}).\n    Delivery time since last snapshot ${
            Math.round(deliveryTimeSinceLastSnapshot) / 1000
          }s. Delivery time total ${
            Math.round(deliveryTimeTotal) / 1000
          }s. Up ${
            lastTranscriptNum - (firstTranscriptNum ?? NaN)
          } deliveries.`,
        );
      },
    ),
  );
}

async function run() {
  const args = process.argv.slice(2);
  console.log(`argv`, args);
  if (args.length < 1) {
    console.log(`replay-transcript.js transcript.sst`);
    return;
  }
  const [transcriptFile] = args;
  console.log(`using transcript ${transcriptFile}`);
  await replay(transcriptFile);
}

run().catch(err => console.log('RUN ERR', err));
