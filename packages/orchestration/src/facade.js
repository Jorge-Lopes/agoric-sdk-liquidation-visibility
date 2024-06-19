/** @file Orchestration service */

import { Fail } from '@agoric/assert';
import { V as E } from '@agoric/vow/vat.js';
import { Far } from '@endo/far';
// eslint-disable-next-line import/no-cycle -- FIXME
import { prepareOrchestrator } from './exos/orchestrator.js';

/**
 * @import {AsyncFlowTools} from '@agoric/async-flow';
 * @import {Zone} from '@agoric/zone';
 * @import {Vow} from '@agoric/vow';
 * @import {TimerService} from '@agoric/time';
 * @import {IBCConnectionID} from '@agoric/vats';
 * @import {LocalChain} from '@agoric/vats/src/localchain.js';
 * @import {RecorderKit, MakeRecorderKit} from '@agoric/zoe/src/contractSupport/recorder.js'.
 * @import {Remote} from '@agoric/internal';
 * @import {OrchestrationService} from './service.js';
 * @import {Chain, ChainInfo, CosmosChainInfo, IBCConnectionInfo, OrchestrationAccount, Orchestrator} from './types.js';
 */

// FIXME turn this into an Exo
/**
 * @param {Remote<LocalChain>} localchain
 * @param {ReturnType<
 *   typeof import('./exos/local-chain-account-kit.js').prepareLocalChainAccountKit
 * >} makeLocalChainAccountKit
 * @param {ChainInfo} localInfo
 * @returns {Chain}
 */
export const makeLocalChainFacade = (
  localchain,
  makeLocalChainAccountKit,
  localInfo,
) => {
  return Far('LocalChainFacade', {
    /** @returns {Promise<ChainInfo>} */
    async getChainInfo() {
      return localInfo;
    },

    async makeAccount() {
      const lcaP = E(localchain).makeAccount();
      const [lca, address] = await Promise.all([lcaP, E(lcaP).getAddress()]);
      const { holder: account } = makeLocalChainAccountKit({
        account: lca,
        address: harden({
          address,
          chainId: localInfo.chainId,
          addressEncoding: 'bech32',
        }),
        // @ts-expect-error TODO: Remote
        storageNode: null,
      });

      // FIXME turn this into an Exo LocalChainOrchestrationAccount or make that a facet of makeLocalChainAccountKit
      return {
        async deposit(payment) {
          console.log('deposit got', payment);
          await E(account).deposit(payment);
        },
        getAddress() {
          return account.getAddress();
        },
        async getBalance(denomArg) {
          // FIXME look up real values
          // UNTIL https://github.com/Agoric/agoric-sdk/issues/9211
          const [brand, denom] =
            typeof denomArg === 'string'
              ? [/** @type {any} */ (null), denomArg]
              : [denomArg, 'FIXME'];

          const natAmount = await E(lca).getBalance(brand);
          return harden({ denom, value: natAmount.value });
        },
        getBalances() {
          throw new Error('not yet implemented');
        },
        async send(toAccount, amount) {
          // FIXME implement
          console.log('send got', toAccount, amount);
        },
        async transfer(amount, destination, opts) {
          console.log('transfer got', amount, destination, opts);
          return account.transfer(amount, destination, opts);
        },
        transferSteps(amount, msg) {
          console.log('transferSteps got', amount, msg);
          return Promise.resolve();
        },
      };
    },
  });
};

/**
 * @param {{
 *   zone: Zone;
 *   timerService: Remote<TimerService>;
 *   zcf: ZCF;
 *   storageNode: Remote<StorageNode>;
 *   orchestrationService: Remote<OrchestrationService>;
 *   localchain: Remote<LocalChain>;
 *   chainHub: import('./utils/chainHub.js').ChainHub;
 *   makeLocalChainAccountKit: ReturnType<
 *     typeof import('./exos/local-chain-account-kit.js').prepareLocalChainAccountKit
 *   >;
 *   makeRecorderKit: MakeRecorderKit;
 *   makeCosmosOrchestrationAccount: any;
 *   makeRemoteChainFacade: any;
 *   asyncFlowTools: AsyncFlowTools;
 * }} powers
 */
export const makeOrchestrationFacade = ({
  zone,
  timerService,
  zcf,
  storageNode,
  orchestrationService,
  localchain,
  chainHub,
  makeLocalChainAccountKit,
  makeRecorderKit,
  makeRemoteChainFacade,
  asyncFlowTools,
}) => {
  (zone &&
    timerService &&
    zcf &&
    storageNode &&
    orchestrationService &&
    // @ts-expect-error type says defined but double check
    makeLocalChainAccountKit &&
    // @ts-expect-error type says defined but double check
    makeRecorderKit &&
    makeRemoteChainFacade &&
    asyncFlowTools) ||
    Fail`params missing`;

  const makeOrchestrator = prepareOrchestrator(zone, {
    asyncFlowTools,
    chainHub,
    localchain,
    makeLocalChainAccountKit,
    makeRecorderKit,
    makeRemoteChainFacade,
    orchestrationService,
    storageNode,
    timerService,
    zcf,
  });

  return {
    /**
     * @template Context
     * @template {any[]} Args
     * @param {string} durableName - the orchestration flow identity in the zone
     *   (to resume across upgrades)
     * @param {Context} ctx - values to pass through the async flow membrane
     * @param {(orc: Orchestrator, ctx2: Context, ...args: Args) => object} fn
     * @returns {(...args: Args) => Promise<unknown>}
     */
    orchestrate(durableName, ctx, fn) {
      const orc = makeOrchestrator();

      return async (...args) => fn(orc, ctx, ...args);
    },
  };
};
harden(makeOrchestrationFacade);
/** @typedef {ReturnType<typeof makeOrchestrationFacade>} OrchestrationFacade */
