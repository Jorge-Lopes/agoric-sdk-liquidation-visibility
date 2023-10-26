/** @file Bootstrap test of liquidation across multiple collaterals */
import { test as anyTest } from '@agoric/zoe/tools/prepare-test-env-ava.js';

import { NonNullish } from '@agoric/assert';
import process from 'process';
import type { ExecutionContext, TestFn } from 'ava';
import type { ScheduleNotification } from '@agoric/inter-protocol/src/auction/scheduler.js';
import { BridgeHandler } from '@agoric/vats';
import {
  LiquidationTestContext,
  likePayouts,
  makeLiquidationTestContext,
  scale6,
  LiquidationSetup,
} from './liquidation.ts';

const test = anyTest as TestFn<LiquidationTestContext>;

//#region Product spec
const setup: LiquidationSetup = {
  vaults: [
    {
      atom: 15,
      ist: 100,
      debt: 100.5,
    },
    {
      atom: 15,
      ist: 103,
      debt: 103.515,
    },
    {
      atom: 15,
      ist: 105,
      debt: 105.525,
    },
  ],
  bids: [
    {
      give: '80IST',
      discount: 0.1,
    },
    {
      give: '90IST',
      price: 9.0,
    },
    {
      give: '150IST',
      discount: 0.15,
    },
  ],
  price: {
    starting: 12.34,
    trigger: 9.99,
  },
  auction: {
    start: {
      collateral: 45,
      debt: 309.54,
    },
    end: {
      collateral: 9.659301,
      debt: 0,
    },
  },
};

const outcome = {
  bids: [
    {
      payouts: {
        Bid: 0,
        Collateral: 8.897786,
      },
    },
    {
      payouts: {
        Bid: 0,
        Collateral: 10.01001,
      },
    },
    {
      payouts: {
        Bid: 10.46,
        Collateral: 16.432903,
      },
    },
  ],
  reserve: {
    allocations: {
      ATOM: 0.309852,
      STARS: 0.309852,
    },
    shortfall: 0,
  },
  vaultsSpec: [
    {
      locked: 3.373,
    },
    {
      locked: 3.024,
    },
    {
      locked: 2.792,
    },
  ],
  // TODO match spec https://github.com/Agoric/agoric-sdk/issues/7837
  vaultsActual: [
    {
      locked: 3.525747,
    },
    {
      locked: 3.181519,
    },
    {
      locked: 2.642185,
    },
  ],
} as const;
//#endregion

test.before(async t => {
  t.context = await makeLiquidationTestContext(t);
});
test.after.always(t => {
  return t.context.shutdown && t.context.shutdown();
});

// Reference: Flow 1 from https://github.com/Agoric/agoric-sdk/issues/7123
const checkFlow1 = async (
  t: ExecutionContext<LiquidationTestContext>,
  {
    collateralBrandKey,
    managerIndex,
  }: { collateralBrandKey: string; managerIndex: number },
  _expected: any,
) => {
  // fail if there are any unhandled rejections
  process.on('unhandledRejection', (error: Error) => {
    t.fail(error.message);
  });

  const {
    advanceTimeBy,
    advanceTimeTo,
    check,
    priceFeedDrivers,
    readLatest,
    walletFactoryDriver,
    setupVaults,
    placeBids,
    controller,
    buildProposal,
  } = t.context;
  const { EV } = t.context.runUtils;

  const buildAndExecuteProposal = async packageSpec => {
    const proposal = await buildProposal(packageSpec);

    for await (const bundle of proposal.bundles) {
      await controller.validateAndInstallBundle(bundle);
    }

    const bridgeMessage = {
      type: 'CORE_EVAL',
      evals: proposal.evals,
    };

    const coreEvalBridgeHandler: ERef<BridgeHandler> = await EV.vat(
      'bootstrap',
    ).consumeItem('coreEvalBridgeHandler');
    await EV(coreEvalBridgeHandler).fromBridge(bridgeMessage);
  };

  const metricsPath = `published.vaultFactory.managers.manager${managerIndex}.metrics`;

  await setupVaults(collateralBrandKey, managerIndex, setup);

  const buyer = await walletFactoryDriver.provideSmartWallet('agoric1buyer');
  await placeBids(collateralBrandKey, 'agoric1buyer', setup);

  {
    // ---------------
    //  Change price to trigger liquidation
    // ---------------

    await priceFeedDrivers[collateralBrandKey].setPrice(9.99);

    // check nothing liquidating yet
    const liveSchedule: ScheduleNotification = readLatest(
      'published.auction.schedule',
    );
    t.is(liveSchedule.activeStartTime, null);
    t.like(readLatest(metricsPath), {
      numActiveVaults: setup.vaults.length,
      numLiquidatingVaults: 0,
    });

    // advance time to start an auction
    console.log(collateralBrandKey, 'step 1 of 10');
    await advanceTimeTo(NonNullish(liveSchedule.nextDescendingStepTime));
    t.like(readLatest(metricsPath), {
      numActiveVaults: 0,
      numLiquidatingVaults: setup.vaults.length,
      liquidatingCollateral: {
        value: scale6(setup.auction.start.collateral),
      },
      liquidatingDebt: { value: scale6(setup.auction.start.debt) },
      lockedQuote: null,
    });

    console.log(collateralBrandKey, 'step 2 of 10');
    await advanceTimeBy(3, 'minutes');
    t.like(readLatest(`published.auction.book${managerIndex}`), {
      collateralAvailable: { value: scale6(setup.auction.start.collateral) },
      startCollateral: { value: scale6(setup.auction.start.collateral) },
      startProceedsGoal: { value: scale6(setup.auction.start.debt) },
    });

    console.log(collateralBrandKey, 'step 3 of 10');
    await advanceTimeBy(3, 'minutes');

    console.log(collateralBrandKey, 'step 4 of 10');
    await advanceTimeBy(3, 'minutes');
    // XXX updates for bid1 and bid2 are appended in the same turn so readLatest gives bid2
    // NB: console output shows 8897786n payout which matches spec 8.897ATOM
    // t.like(readLatest('published.wallet.agoric1buyer'), {
    //   status: {
    //     id: `${collateralBrandKey}-bid1`,
    //     payouts: {
    //       Bid: { value: 0n },
    //       Collateral: { value: scale6(outcome.bids[0].payouts.Collateral) },
    //     },
    //   },
    // });

    t.like(readLatest('published.wallet.agoric1buyer'), {
      status: {
        id: `${collateralBrandKey}-bid2`,
        payouts: likePayouts(outcome.bids[1].payouts),
      },
    });

    console.log(collateralBrandKey, 'step 5 of 10');
    await advanceTimeBy(3, 'minutes');

    console.log(collateralBrandKey, 'step 6 of 10');
    await advanceTimeBy(3, 'minutes');
    t.like(readLatest(`published.auction.book${managerIndex}`), {
      collateralAvailable: { value: 9659301n },
    });

    console.log(collateralBrandKey, 'step 7 of 10');
    await advanceTimeBy(3, 'minutes');

    console.log(collateralBrandKey, 'step 8 of 10');
    await advanceTimeBy(3, 'minutes');

    console.log(collateralBrandKey, 'step 9 of 10');
    await advanceTimeBy(3, 'minutes');
    // Not part of product spec
    t.like(readLatest(metricsPath), {
      numActiveVaults: 0,
      numLiquidationsCompleted: setup.vaults.length,
      numLiquidatingVaults: 0,
      retainedCollateral: { value: 0n },
      totalCollateral: { value: 0n },
      totalCollateralSold: { value: 35340699n },
      totalDebt: { value: 0n },
      totalOverageReceived: { value: 0n },
      totalProceedsReceived: { value: 309540000n },
      totalShortfallReceived: { value: 0n },
    });

    console.log(collateralBrandKey, 'step 10 of 10');
    // continuing after now would start a new auction
    {
      const { nextDescendingStepTime, nextStartTime } = readLatest(
        'published.auction.schedule',
      ) as Record<string, import('@agoric/time/src/types.js').TimestampRecord>;
      t.is(nextDescendingStepTime.absValue, nextStartTime.absValue);
    }

    // bid3 still live because it's not fully satisfied
    const { liveOffers } = readLatest('published.wallet.agoric1buyer.current');
    t.is(liveOffers[0][1].id, `${collateralBrandKey}-bid3`);

    // restart Zoe
    // /////// Upgrading ////////////////////////////////
    const zoeUpgradeSpec = {
      package: 'builders',
      packageScriptName: 'build:null-upgrade-zoe-proposal',
    };
    await buildAndExecuteProposal(zoeUpgradeSpec);

    await buyer.tryExitOffer(`${collateralBrandKey}-bid3`);
    t.like(readLatest('published.wallet.agoric1buyer'), {
      status: {
        id: `${collateralBrandKey}-bid3`,
        payouts: likePayouts(outcome.bids[2].payouts),
      },
    });

    // TODO express spec up top in a way it can be passed in here
    //   check.vaultNotification(managerIndex, 0, {
    //     debt: undefined,
    //     vaultState: 'liquidated',
    //     locked: {
    //       value: scale6(outcome.vaultsActual[0].locked),
    //     },
    //   });
    //   check.vaultNotification(managerIndex, 1, {
    //     debt: undefined,
    //     vaultState: 'liquidated',
    //     locked: {
    //       value: scale6(outcome.vaultsActual[1].locked),
    //     },
    // });
  }

  // // check reserve balances
  // t.like(readLatest('published.reserve.metrics'), {
  //   allocations: {
  //     [collateralBrandKey]: {
  //       value: scale6(outcome.reserve.allocations[collateralBrandKey]),
  //     },
  //   },
  //   shortfallBalance: { value: scale6(outcome.reserve.shortfall) },
  // });
};

test.serial.failing(
  'wallet survives zoe null upgrade',
  checkFlow1,
  { collateralBrandKey: 'ATOM', managerIndex: 0 },
  {},
);
