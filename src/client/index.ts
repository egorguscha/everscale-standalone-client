import safeStringify from 'fast-safe-stringify';
import type * as ever from 'everscale-inpage-provider';
import type * as nt from 'nekoton-wasm';

import core from '../core';
import { convertVersionToInt32, SafeEventEmitter } from './utils';
import {
  DEFAULT_NETWORK_GROUP,
  createConnectionController,
  ConnectionProperties,
  ConnectionController,
} from './ConnectionController';
import { SubscriptionController } from './SubscriptionController';
import { AccountsStorage } from './accountsStorage';
import { Keystore } from './keystore';
import { Clock } from './clock';

export { NETWORK_PRESETS, ConnectionData, ConnectionProperties } from './ConnectionController';
export { GqlSocketParams, JrpcSocketParams, ConnectionError, checkConnection } from './ConnectionController';
export { Account, AccountsStorage, SimpleAccountsStorage, PrepareMessageParams } from './accountsStorage';
export { Keystore, Signer, SimpleKeystore } from './keystore';
export { Clock } from './clock';
export type { Ed25519KeyPair } from 'nekoton-wasm';

const { ensureNekotonLoaded, nekoton } = core;

/**
 * Standalone provider which is used as a fallback when browser extension is not installed
 *
 * @category Client
 */
export type ClientProperties = {
  /**
   * Connection properties or network preset name
   */
  connection: ConnectionProperties,
  /**
   * Keystore which will be used for all methods with `accountInteraction`
   */
  keystore?: Keystore,
  /**
   * Accounts storage which will be used to send internal messages
   */
  accountsStorage?: AccountsStorage,
  /**
   * Clock object which can be used to adjust time offset
   */
  clock?: Clock,
  /**
   * Message behaviour properties
   */
  message?: MessageProperties,
  /**
   * Explicit params for nekoton wasm loader
   */
  initInput?: nt.InitInput | Promise<nt.InitInput>,
};

/**
 * Message behaviour properties
 *
 * @category Client
 */
export type MessageProperties = {
  /**
   * Number of attempts to send a message
   *
   * @default 5
   */
  retryCount?: number,
  /**
   * Message expiration timeout (seconds)
   *
   * @default 60
   */
  timeout?: number,
  /**
   * Message expiration timeout grow factor for each new retry
   *
   * @default 1.2
   */
  timeoutGrowFactor?: number;
}

function validateMessageProperties(message?: MessageProperties): Required<MessageProperties> {
  const m = message || {};
  return {
    retryCount: m.retryCount != null ? Math.max(1, ~~m.retryCount) : 5,
    timeout: m.timeout != null ? Math.max(1, ~~m.timeout) : 60,
    timeoutGrowFactor: m.timeoutGrowFactor || 1.2,
  };
}

/**
 * @category Client
 */
export const DEFAULT_CLIENT_PROPERTIES: ClientProperties = {
  connection: DEFAULT_NETWORK_GROUP,
};

/**
 * @category Client
 */
export const VERSION = '0.2.25';
/**
 * @category Client
 */
export const SUPPORTED_PERMISSIONS: ever.Permission[] = ['basic'];

/**
 * @category Client
 */
export class EverscaleStandaloneClient extends SafeEventEmitter implements ever.Provider {
  private readonly _context: Context;
  private _handlers: { [K in ever.ProviderMethod]?: ProviderHandler<K> } = {
    requestPermissions,
    // changeAccount, // not supported
    disconnect,
    subscribe,
    unsubscribe,
    unsubscribeAll,
    getProviderState,
    getFullContractState,
    getAccountsByCodeHash,
    getTransactions,
    getTransaction,
    runLocal,
    getExpectedAddress,
    getBocHash,
    packIntoCell,
    unpackFromCell,
    extractPublicKey,
    codeToTvc,
    mergeTvc,
    splitTvc,
    setCodeSalt,
    getCodeSalt,
    encodeInternalInput,
    decodeInput,
    decodeOutput,
    decodeEvent,
    decodeTransaction,
    decodeTransactionEvents,
    verifySignature,
    sendUnsignedExternalMessage,
    // addAsset, // not supported
    signData,
    signDataRaw,
    // encryptData, // not supported
    // decryptData, // not supported
    // estimateFees, // not supported
    sendMessage,
    sendMessageDelayed,
    sendExternalMessage,
    sendExternalMessageDelayed,
  };

  public static async create(params: ClientProperties): Promise<EverscaleStandaloneClient> {
    await ensureNekotonLoaded(params.initInput);

    // NOTE: capture client inside notify using wrapper object
    const notificationContext: { client?: EverscaleStandaloneClient } = {};

    const notify = <T extends ever.ProviderEvent>(method: T, params: ever.RawProviderEventData<T>) => {
      notificationContext.client?.emit(method, params);
    };

    const clock = new core.nekoton.ClockWithOffset();
    if (params.clock != null) {
      params.clock['impls'].push(clock);
      clock.updateOffset(params.clock.offset);
    }

    try {
      const connectionController = await createConnectionController(clock, params.connection);
      const subscriptionController = new SubscriptionController(connectionController, notify);

      const client = new EverscaleStandaloneClient({
        permissions: {},
        connectionController,
        subscriptionController,
        properties: {
          message: validateMessageProperties(params.message),
        },
        keystore: params.keystore,
        accountsStorage: params.accountsStorage,
        clock,
        notify,
      });
      // NOTE: WeakRef is not working here, so hope it will be garbage collected
      notificationContext.client = client;
      return client;
    } catch (e) {
      if (params.clock != null) {
        params.clock['impls'].pop();
      }

      clock.free();
      throw e;
    }
  }

  private constructor(ctx: Context) {
    super();
    this._context = ctx;
  }

  request<T extends ever.ProviderMethod>(req: ever.RawProviderRequest<T>): Promise<ever.RawProviderApiResponse<T>> {
    const handler = this._handlers[req.method] as any as ProviderHandler<T> | undefined;
    if (handler == null) {
      throw invalidRequest(req, `Method '${req.method}' is not supported by standalone provider`);
    }
    return handler(this._context, req);
  }

  computeWalletAddress(workchain: number, walletType: nt.WalletContractType, publicKey: string): string {
    return nekoton.computeWalletAddress(workchain, walletType, publicKey);
  }

  async sendTransfer(
    walletType: nt.WalletContractType,
    publicKey: string,
    recipient: string,
    gifts: nt.Gift[],
  ): Promise<nt.Transaction> {
    let repackedRecipient: string;
    try {
      repackedRecipient = nekoton.repackAddress(recipient);
    } catch (e: any) {
      throw new Error(e.toString());
    }

    const signer = await this._context.keystore?.getSigner(publicKey);
    if (signer == null) {
      throw new Error('Signer not found for public key');
    }

    const accountState = await this._context.connectionController.use(async ({ data: { transport } }) =>
      (await transport.getFullContractState(repackedRecipient))?.boc,
    );
    if (accountState == null) {
      throw new Error('Wallet does not exists');
    }

    let unsignedMessage: nt.UnsignedMessage | undefined;
    try {
      unsignedMessage = nekoton.walletPrepareTransfer(this._context.clock, accountState, walletType, publicKey, gifts, 60);
    } catch (e: any) {
      throw new Error(e.toString());
    }

    if (unsignedMessage === undefined) {
      throw new Error('Failed to prepare message');
    }

    let signedMessage: nt.SignedMessage;
    try {
      const signature = await signer.sign(unsignedMessage.hash);
      signedMessage = unsignedMessage.sign(signature);
    } catch (e: any) {
      throw new Error(e.toString());
    } finally {
      unsignedMessage.free();
    }

    const transaction = await this._context.subscriptionController.sendMessage(repackedRecipient, signedMessage);
    if (transaction == null) {
      throw new Error('Message expired');
    }
    return transaction;
  }
}

type Context = {
  permissions: Partial<ever.RawPermissions>,
  connectionController: ConnectionController,
  subscriptionController: SubscriptionController,
  properties: Properties,
  keystore?: Keystore,
  accountsStorage?: AccountsStorage,
  clock: nt.ClockWithOffset,
  notify: <T extends ever.ProviderEvent>(method: T, params: ever.RawProviderEventData<T>) => void
}

type Properties = {
  message: Required<MessageProperties>,
}

type ProviderHandler<T extends ever.ProviderMethod> = (ctx: Context, req: ever.RawProviderRequest<T>) => Promise<ever.RawProviderApiResponse<T>>;


const requestPermissions: ProviderHandler<'requestPermissions'> = async (ctx, req) => {
  requireParams(req);

  const { permissions } = req.params;
  requireArray(req, req.params, 'permissions');

  const newPermissions = { ...ctx.permissions };

  for (const permission of permissions) {
    if (permission === 'basic' || (permission as any) === 'tonClient') {
      newPermissions.basic = true;
    } else {
      throw invalidRequest(req, `Permission '${permission}' is not supported by standalone provider`);
    }
  }

  ctx.permissions = newPermissions;

  // NOTE: be sure to return object copy to prevent adding new permissions
  ctx.notify('permissionsChanged', {
    permissions: { ...newPermissions },
  });
  return { ...newPermissions };
};

const disconnect: ProviderHandler<'disconnect'> = async (ctx, _req) => {
  ctx.permissions = {};
  await ctx.subscriptionController.unsubscribeFromAllContracts();
  ctx.notify('permissionsChanged', { permissions: {} });
  return undefined;
};

const subscribe: ProviderHandler<'subscribe'> = async (ctx, req) => {
  requireParams(req);

  const { address, subscriptions } = req.params;
  requireString(req, req.params, 'address');
  requireOptionalObject(req, req.params, 'subscriptions');

  let repackedAddress: string;
  try {
    repackedAddress = nekoton.repackAddress(address);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  try {
    return await ctx.subscriptionController.subscribeToContract(repackedAddress, subscriptions);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const unsubscribe: ProviderHandler<'unsubscribe'> = async (ctx, req) => {
  requireParams(req);

  const { address } = req.params;
  requireString(req, req.params, 'address');

  let repackedAddress: string;
  try {
    repackedAddress = nekoton.repackAddress(address);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  await ctx.subscriptionController.unsubscribeFromContract(repackedAddress);
  return undefined;
};

const unsubscribeAll: ProviderHandler<'unsubscribeAll'> = async (ctx, _req) => {
  await ctx.subscriptionController.unsubscribeFromAllContracts();
  return undefined;
};

const getProviderState: ProviderHandler<'getProviderState'> = async (ctx, req) => {
  const transport = ctx.connectionController.initializedTransport;
  if (transport == null) {
    throw invalidRequest(req, 'Connection controller was not initialized');
  }

  const version = VERSION;

  return {
    version,
    numericVersion: convertVersionToInt32(version),
    networkId: transport.id,
    selectedConnection: transport.group,
    supportedPermissions: [...SUPPORTED_PERMISSIONS],
    permissions: { ...ctx.permissions },
    subscriptions: ctx.subscriptionController.subscriptionStates,
  };
};

const getFullContractState: ProviderHandler<'getFullContractState'> = async (ctx, req) => {
  requireParams(req);

  const { address } = req.params;
  requireString(req, req.params, 'address');

  const { connectionController } = ctx;

  try {
    return connectionController.use(async ({ data: { transport } }) => ({
      state: await transport.getFullContractState(address),
    }));
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const getAccountsByCodeHash: ProviderHandler<'getAccountsByCodeHash'> = async (ctx, req) => {
  requireParams(req);

  const { codeHash, limit, continuation } = req.params;
  requireString(req, req.params, 'codeHash');
  requireOptionalNumber(req, req.params, 'limit');
  requireOptionalString(req, req.params, 'continuation');

  const { connectionController } = ctx;

  try {
    return connectionController.use(({ data: { transport } }) =>
      transport.getAccountsByCodeHash(codeHash, limit || 50, continuation));
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const getTransactions: ProviderHandler<'getTransactions'> = async (ctx, req) => {
  requireParams(req);

  const { address, continuation, limit } = req.params;
  requireString(req, req.params, 'address');
  requireOptional(req, req.params, 'continuation', requireTransactionId);
  requireOptionalNumber(req, req.params, 'limit');

  const { connectionController } = ctx;

  try {
    return connectionController.use(({ data: { transport } }) =>
      transport.getTransactions(address, continuation?.lt, limit || 50));
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const getTransaction: ProviderHandler<'getTransaction'> = async (ctx, req) => {
  requireParams(req);

  const { hash } = req.params;
  requireString(req, req.params, 'hash');

  const { connectionController } = ctx;

  try {
    return {
      transaction: await connectionController.use(({ data: { transport } }) =>
        transport.getTransaction(hash)),
    };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const runLocal: ProviderHandler<'runLocal'> = async (ctx, req) => {
  requireParams(req);

  const { address, cachedState, responsible, functionCall } = req.params;
  requireString(req, req.params, 'address');
  requireOptional(req, req.params, 'cachedState', requireContractState);
  requireOptionalBoolean(req, req.params, 'responsible');
  requireFunctionCall(req, req.params, 'functionCall');

  const { clock, connectionController } = ctx;

  let contractState = cachedState;
  if (contractState == null) {
    contractState = await connectionController.use(async ({ data: { transport } }) =>
      transport.getFullContractState(address));
  }

  if (contractState == null) {
    throw invalidRequest(req, 'Account not found');
  }
  if (!contractState.isDeployed || contractState.lastTransactionId == null) {
    throw invalidRequest(req, 'Account is not deployed');
  }

  try {
    const { output, code } = nekoton.runLocal(
      clock,
      contractState.boc,
      functionCall.abi,
      functionCall.method,
      functionCall.params,
      responsible || false,
    );
    return { output, code };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const getExpectedAddress: ProviderHandler<'getExpectedAddress'> = async (_ctx, req) => {
  requireParams(req);

  const { tvc, abi, workchain, publicKey, initParams } = req.params;
  requireString(req, req.params, 'tvc');
  requireString(req, req.params, 'abi');
  requireOptionalNumber(req, req.params, 'workchain');
  requireOptionalString(req, req.params, 'publicKey');

  try {
    return nekoton.getExpectedAddress(tvc, abi, workchain || 0, publicKey, initParams);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const getBocHash: ProviderHandler<'getBocHash'> = async (_ctx, req) => {
  requireParams(req);

  const { boc } = req.params;
  requireString(req, req.params, 'boc');

  try {
    return { hash: nekoton.getBocHash(boc) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const packIntoCell: ProviderHandler<'packIntoCell'> = async (_ctx, req) => {
  requireParams(req);

  const { structure, data } = req.params;
  requireArray(req, req.params, 'structure');

  try {
    return { boc: nekoton.packIntoCell(structure as nt.AbiParam[], data) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const unpackFromCell: ProviderHandler<'unpackFromCell'> = async (_ctx, req) => {
  requireParams(req);

  const { structure, boc, allowPartial } = req.params;
  requireArray(req, req.params, 'structure');
  requireString(req, req.params, 'boc');
  requireBoolean(req, req.params, 'allowPartial');

  try {
    return { data: nekoton.unpackFromCell(structure as nt.AbiParam[], boc, allowPartial) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const extractPublicKey: ProviderHandler<'extractPublicKey'> = async (_ctx, req) => {
  requireParams(req);

  const { boc } = req.params;
  requireString(req, req.params, 'boc');

  try {
    return { publicKey: nekoton.extractPublicKey(boc) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const codeToTvc: ProviderHandler<'codeToTvc'> = async (_ctx, req) => {
  requireParams(req);

  const { code } = req.params;
  requireString(req, req.params, 'code');

  try {
    return { tvc: nekoton.codeToTvc(code) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const mergeTvc: ProviderHandler<'mergeTvc'> = async (_ctx, req) => {
  requireParams(req);

  const { code, data } = req.params;
  requireString(req, req.params, 'code');
  requireString(req, req.params, 'data');

  try {
    return { tvc: nekoton.mergeTvc(code, data) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const splitTvc: ProviderHandler<'splitTvc'> = async (_ctx, req) => {
  requireParams(req);

  const { tvc } = req.params;
  requireString(req, req.params, 'tvc');

  try {
    return nekoton.splitTvc(tvc);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const setCodeSalt: ProviderHandler<'setCodeSalt'> = async (_ctx, req) => {
  requireParams(req);

  const { code, salt } = req.params;
  requireString(req, req.params, 'code');
  requireString(req, req.params, 'salt');

  try {
    return { code: nekoton.setCodeSalt(code, salt) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const getCodeSalt: ProviderHandler<'getCodeSalt'> = async (_ctx, req) => {
  requireParams(req);

  const { code } = req.params;
  requireString(req, req.params, 'code');

  try {
    return { salt: nekoton.getCodeSalt(code) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const encodeInternalInput: ProviderHandler<'encodeInternalInput'> = async (_ctx, req) => {
  requireParams(req);

  requireFunctionCall(req, req, 'params');
  const { abi, method, params } = req.params;

  try {
    return { boc: nekoton.encodeInternalInput(abi, method, params) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const decodeInput: ProviderHandler<'decodeInput'> = async (_ctx, req) => {
  requireParams(req);

  const { body, abi, method, internal } = req.params;
  requireString(req, req.params, 'body');
  requireString(req, req.params, 'abi');
  requireMethodOrArray(req, req.params, 'method');
  requireBoolean(req, req.params, 'internal');

  try {
    return nekoton.decodeInput(body, abi, method, internal) || null;
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const decodeOutput: ProviderHandler<'decodeOutput'> = async (_ctx, req) => {
  requireParams(req);

  const { body, abi, method } = req.params;
  requireString(req, req.params, 'body');
  requireString(req, req.params, 'abi');
  requireMethodOrArray(req, req.params, 'method');

  try {
    return nekoton.decodeOutput(body, abi, method) || null;
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const decodeEvent: ProviderHandler<'decodeEvent'> = async (_ctx, req) => {
  requireParams(req);

  const { body, abi, event } = req.params;
  requireString(req, req.params, 'body');
  requireString(req, req.params, 'abi');
  requireMethodOrArray(req, req.params, 'event');

  try {
    return nekoton.decodeEvent(body, abi, event) || null;
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const decodeTransaction: ProviderHandler<'decodeTransaction'> = async (_ctx, req) => {
  requireParams(req);

  const { transaction, abi, method } = req.params;
  requireString(req, req.params, 'abi');
  requireMethodOrArray(req, req.params, 'method');

  try {
    return nekoton.decodeTransaction(transaction, abi, method) || null;
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const decodeTransactionEvents: ProviderHandler<'decodeTransactionEvents'> = async (_ctx, req) => {
  requireParams(req);

  const { transaction, abi } = req.params;
  requireString(req, req.params, 'abi');

  try {
    return { events: nekoton.decodeTransactionEvents(transaction, abi) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const verifySignature: ProviderHandler<'verifySignature'> = async (_ctx, req) => {
  requireParams(req);

  const { publicKey, dataHash, signature } = req.params;
  requireString(req, req.params, 'publicKey');
  requireString(req, req.params, 'dataHash');
  requireString(req, req.params, 'signature');

  try {
    return { isValid: nekoton.verifySignature(publicKey, dataHash, signature) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const sendUnsignedExternalMessage: ProviderHandler<'sendUnsignedExternalMessage'> = async (ctx, req) => {
  requireParams(req);

  const { recipient, stateInit, payload, local } = req.params;
  requireString(req, req.params, 'recipient');
  requireOptionalString(req, req.params, 'stateInit');
  requireFunctionCall(req, req.params, 'payload');
  requireOptionalBoolean(req, req.params, 'local');

  let repackedRecipient: string;
  try {
    repackedRecipient = nekoton.repackAddress(recipient);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  const { clock, subscriptionController, properties } = ctx;

  const makeSignedMessage = (timeout: number): nt.SignedMessage => {
    try {
      return nekoton.createExternalMessageWithoutSignature(
        clock,
        repackedRecipient,
        payload.abi,
        payload.method,
        stateInit,
        payload.params,
        timeout,
      );
    } catch (e: any) {
      throw invalidRequest(req, e.toString());
    }
  };

  const handleTransaction = (transaction: nt.Transaction) => {
    let output: ever.RawTokensObject | undefined;
    try {
      const decoded = nekoton.decodeTransaction(transaction, payload.abi, payload.method);
      output = decoded?.output;
    } catch (_) { /* do nothing */
    }

    return { transaction, output };
  };

  // Force local execution
  if (local === true) {
    const signedMessage = makeSignedMessage(60);
    const transaction = await subscriptionController.sendMessageLocally(repackedRecipient, signedMessage);
    return handleTransaction(transaction);
  }

  // Send and wait with several retries
  let timeout = properties.message.timeout;
  for (let retry = 0; retry < properties.message.retryCount; ++retry) {
    const signedMessage = makeSignedMessage(timeout);

    const transaction = await subscriptionController.sendMessage(repackedRecipient, signedMessage);
    if (transaction == null) {
      timeout *= properties.message.timeoutGrowFactor;
      continue;
    }

    return handleTransaction(transaction);
  }

  // Execute locally
  const errorMessage = 'Message expired';
  const signedMessage = makeSignedMessage(60);
  const transaction = await subscriptionController.sendMessageLocally(repackedRecipient, signedMessage)
    .catch((e) => {
      throw invalidRequest(req, `${errorMessage}. ${e.toString()}`);
    });

  const additionalText = transaction.exitCode != null ? `. Possible exit code: ${transaction.exitCode}` : '';
  throw invalidRequest(req, `${errorMessage}${additionalText}`);
};

const signData: ProviderHandler<'signData'> = async (ctx, req) => {
  requireKeystore(req, ctx);
  requireParams(req);

  const { publicKey, data } = req.params;
  requireString(req, req.params, 'publicKey');
  requireString(req, req.params, 'data');

  const { keystore } = ctx;
  const signer = await keystore.getSigner(publicKey);
  if (signer == null) {
    throw invalidRequest(req, 'Signer not found for public key');
  }

  try {
    const dataHash = nekoton.getDataHash(data);
    return {
      dataHash,
      ...(await signer.sign(dataHash).then(nekoton.extendSignature)),
    };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const signDataRaw: ProviderHandler<'signDataRaw'> = async (ctx, req) => {
  requireKeystore(req, ctx);
  requireParams(req);

  const { publicKey, data } = req.params;
  requireString(req, req.params, 'publicKey');
  requireString(req, req.params, 'data');

  const { keystore } = ctx;
  const signer = await keystore.getSigner(publicKey);
  if (signer == null) {
    throw invalidRequest(req, 'Signer not found for public key');
  }

  try {
    return await signer.sign(data).then(nekoton.extendSignature);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const sendMessage: ProviderHandler<'sendMessage'> = async (ctx, req) => {
  requireKeystore(req, ctx);
  requireAccountsStorage(req, ctx);
  requireParams(req);

  const { sender, recipient, amount, bounce, payload } = req.params;
  requireString(req, req.params, 'sender');
  requireString(req, req.params, 'recipient');
  requireString(req, req.params, 'amount');
  requireBoolean(req, req.params, 'bounce');
  requireOptional(req, req.params, 'payload', requireFunctionCall);

  const { clock, subscriptionController, keystore, accountsStorage } = ctx;

  let repackedSender: string;
  let repackedRecipient: string;
  try {
    repackedSender = nekoton.repackAddress(sender);
    repackedRecipient = nekoton.repackAddress(recipient);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  let signedMessage: nt.SignedMessage;
  try {
    const account = await accountsStorage.getAccount(repackedSender);
    if (account == null) {
      throw new Error('Sender not found');
    }

    signedMessage = await account.prepareMessage({
      recipient: repackedRecipient,
      amount,
      bounce,
      payload,
      stateInit: undefined,
    }, {
      clock,
      keystore,
    });
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  const transaction = await subscriptionController.sendMessage(repackedSender, signedMessage);
  if (transaction == null) {
    throw invalidRequest(req, 'Message expired');
  }

  return { transaction };
};

const sendMessageDelayed: ProviderHandler<'sendMessageDelayed'> = async (ctx, req) => {
  requireKeystore(req, ctx);
  requireAccountsStorage(req, ctx);
  requireParams(req);

  const { sender, recipient, amount, bounce, payload } = req.params;
  requireString(req, req.params, 'sender');
  requireString(req, req.params, 'recipient');
  requireString(req, req.params, 'amount');
  requireBoolean(req, req.params, 'bounce');
  requireOptional(req, req.params, 'payload', requireFunctionCall);

  const { clock, subscriptionController, keystore, accountsStorage, notify } = ctx;

  let repackedSender: string;
  let repackedRecipient: string;
  try {
    repackedSender = nekoton.repackAddress(sender);
    repackedRecipient = nekoton.repackAddress(recipient);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  let signedMessage: nt.SignedMessage;
  try {
    const account = await accountsStorage.getAccount(repackedSender);
    if (account == null) {
      throw new Error('Sender not found');
    }

    signedMessage = await account.prepareMessage({
      recipient: repackedRecipient,
      amount,
      bounce,
      payload,
      stateInit: undefined,
    }, {
      clock,
      keystore,
    });
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  subscriptionController.sendMessage(repackedSender, signedMessage)
    .then(transaction => {
      notify('messageStatusUpdated', {
        address: repackedSender,
        hash: signedMessage.hash,
        transaction,
      });
    })
    .catch(console.error);

  return {
    message: {
      account: repackedSender,
      hash: signedMessage.hash,
      expireAt: signedMessage.expireAt,
    },
  };
};

const sendExternalMessage: ProviderHandler<'sendExternalMessage'> = async (ctx, req) => {
  requireKeystore(req, ctx);
  requireParams(req);

  const { publicKey, recipient, stateInit, payload, local } = req.params;
  requireString(req, req.params, 'publicKey');
  requireString(req, req.params, 'recipient');
  requireOptionalString(req, req.params, 'stateInit');
  requireFunctionCall(req, req.params, 'payload');
  requireOptionalBoolean(req, req.params, 'local');

  let repackedRecipient: string;
  try {
    repackedRecipient = nekoton.repackAddress(recipient);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  const { clock, subscriptionController, keystore, properties } = ctx;
  const signer = await keystore.getSigner(publicKey);
  if (signer == null) {
    throw invalidRequest(req, 'Signer not found for public key');
  }

  const makeSignedMessage = async (timeout: number): Promise<nt.SignedMessage> => {
    let unsignedMessage: nt.UnsignedMessage;
    try {
      unsignedMessage = nekoton.createExternalMessage(
        clock,
        repackedRecipient,
        payload.abi,
        payload.method,
        stateInit,
        payload.params,
        publicKey,
        timeout,
      );
    } catch (e: any) {
      throw invalidRequest(req, e.toString());
    }

    try {
      const signature = await signer.sign(unsignedMessage.hash);
      return unsignedMessage.sign(signature);
    } catch (e: any) {
      throw invalidRequest(req, e.toString());
    } finally {
      unsignedMessage.free();
    }
  };

  const handleTransaction = (transaction: nt.Transaction) => {
    let output: ever.RawTokensObject | undefined;
    try {
      const decoded = nekoton.decodeTransaction(transaction, payload.abi, payload.method);
      output = decoded?.output;
    } catch (_) { /* do nothing */
    }

    return { transaction, output };
  };

  // Force local execution
  if (local === true) {
    const signedMessage = await makeSignedMessage(60);
    const transaction = await subscriptionController.sendMessageLocally(repackedRecipient, signedMessage);
    return handleTransaction(transaction);
  }

  // Send and wait with several retries
  let timeout = properties.message.timeout;
  for (let retry = 0; retry < properties.message.retryCount; ++retry) {
    const signedMessage = await makeSignedMessage(timeout);

    const transaction = await subscriptionController.sendMessage(repackedRecipient, signedMessage);
    if (transaction == null) {
      timeout *= properties.message.timeoutGrowFactor;
      continue;
    }

    return handleTransaction(transaction);
  }

  // Execute locally
  const errorMessage = 'Message expired';
  const signedMessage = await makeSignedMessage(60);
  const transaction = await subscriptionController.sendMessageLocally(repackedRecipient, signedMessage)
    .catch((e) => {
      throw invalidRequest(req, `${errorMessage}. ${e.toString()}`);
    });

  const additionalText = transaction.exitCode != null ? `. Possible exit code: ${transaction.exitCode}` : '';
  throw invalidRequest(req, `${errorMessage}${additionalText}`);
};

const sendExternalMessageDelayed: ProviderHandler<'sendExternalMessageDelayed'> = async (ctx, req) => {
  requireKeystore(req, ctx);
  requireParams(req);

  const { publicKey, recipient, stateInit, payload } = req.params;
  requireString(req, req.params, 'publicKey');
  requireString(req, req.params, 'recipient');
  requireOptionalString(req, req.params, 'stateInit');
  requireFunctionCall(req, req.params, 'payload');

  let repackedRecipient: string;
  try {
    repackedRecipient = nekoton.repackAddress(recipient);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  const { clock, subscriptionController, keystore, properties, notify } = ctx;
  const signer = await keystore.getSigner(publicKey);
  if (signer == null) {
    throw invalidRequest(req, 'Signer not found for public key');
  }

  let unsignedMessage: nt.UnsignedMessage;
  try {
    unsignedMessage = nekoton.createExternalMessage(
      clock,
      repackedRecipient,
      payload.abi,
      payload.method,
      stateInit,
      payload.params,
      publicKey,
      properties.message.timeout,
    );
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  let signedMessage: nt.SignedMessage;
  try {
    const signature = await signer.sign(unsignedMessage.hash);
    signedMessage = unsignedMessage.sign(signature);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  } finally {
    unsignedMessage.free();
  }

  subscriptionController.sendMessage(repackedRecipient, signedMessage)
    .then(transaction => {
      notify('messageStatusUpdated', {
        address: repackedRecipient,
        hash: signedMessage.hash,
        transaction,
      });
    })
    .catch(console.error);

  return {
    message: {
      account: repackedRecipient,
      hash: signedMessage.hash,
      expireAt: signedMessage.expireAt,
    },
  };
};


function requireKeystore(req: any, context: Context): asserts context is Context & { keystore: Keystore } {
  if (context.keystore == null) {
    throw invalidRequest(req, 'Keystore not found');
  }
}

function requireAccountsStorage(req: any, context: Context): asserts context is Context & { accountsStorage: AccountsStorage } {
  if (context.accountsStorage == null) {
    throw invalidRequest(req, 'AccountsStorage not found');
  }
}

function requireParams<T extends ever.ProviderMethod>(req: any): asserts req is ever.RawProviderRequest<T> {
  if (req.params == null || typeof req.params !== 'object') {
    throw invalidRequest(req, 'required params object');
  }
}

function requireObject<O, P extends keyof O>(req: ever.RawProviderRequest<ever.ProviderMethod>, object: O, key: P) {
  const property = object[key];
  if (typeof property !== 'object') {
    throw invalidRequest(req, `'${String(key)}' must be an object`);
  }
}

function requireOptionalObject<O, P extends keyof O>(req: ever.RawProviderRequest<ever.ProviderMethod>, object: O, key: P) {
  const property = object[key];
  if (property != null && typeof property !== 'object') {
    throw invalidRequest(req, `'${String(key)}' must be an object if specified`);
  }
}

function requireBoolean<O, P extends keyof O>(req: ever.RawProviderRequest<ever.ProviderMethod>, object: O, key: P) {
  const property = object[key];
  if (typeof property !== 'boolean') {
    throw invalidRequest(req, `'${String(key)}' must be a boolean`);
  }
}

function requireOptionalBoolean<O, P extends keyof O>(req: ever.RawProviderRequest<ever.ProviderMethod>, object: O, key: P) {
  const property = object[key];
  if (property != null && typeof property !== 'boolean') {
    throw invalidRequest(req, `'${String(key)}' must be a boolean if specified`);
  }
}

function requireString<O, P extends keyof O>(req: ever.RawProviderRequest<ever.ProviderMethod>, object: O, key: P) {
  const property = object[key];
  if (typeof property !== 'string' || property.length === 0) {
    throw invalidRequest(req, `'${String(key)}' must be non-empty string`);
  }
}

function requireOptionalString<O, P extends keyof O>(req: ever.RawProviderRequest<ever.ProviderMethod>, object: O, key: P) {
  const property = object[key];
  if (property != null && (typeof property !== 'string' || property.length === 0)) {
    throw invalidRequest(req, `'${String(key)}' must be a non-empty string if provided`);
  }
}

function requireOptionalNumber<O, P extends keyof O>(req: ever.RawProviderRequest<ever.ProviderMethod>, object: O, key: P) {
  const property = object[key];
  if (property != null && typeof property !== 'number') {
    throw invalidRequest(req, `'${String(key)}' must be a number if provider`);
  }
}

function requireArray<O, P extends keyof O>(req: ever.RawProviderRequest<ever.ProviderMethod>, object: O, key: P) {
  const property = object[key];
  if (!Array.isArray(property)) {
    throw invalidRequest(req, `'${String(key)}' must be an array`);
  }
}

function requireOptional<O, P extends keyof O>(
  req: ever.RawProviderRequest<ever.ProviderMethod>,
  object: O,
  key: P,
  predicate: (req: ever.RawProviderRequest<ever.ProviderMethod>, object: O, key: P) => void,
) {
  const property = object[key];
  if (property != null) {
    predicate(req, object, key);
  }
}

function requireTransactionId<O, P extends keyof O>(req: ever.RawProviderRequest<ever.ProviderMethod>, object: O, key: P) {
  requireObject(req, object, key);
  const property = (object[key] as unknown) as nt.TransactionId;
  requireString(req, property, 'lt');
  requireString(req, property, 'hash');
}

function requireLastTransactionId<O, P extends keyof O>(
  req: ever.RawProviderRequest<ever.ProviderMethod>,
  object: O,
  key: P,
) {
  requireObject(req, object, key);
  const property = (object[key] as unknown) as nt.LastTransactionId;
  requireBoolean(req, property, 'isExact');
  requireString(req, property, 'lt');
  requireOptionalString(req, property, 'hash');
}

function requireContractState<O, P extends keyof O>(req: ever.RawProviderRequest<ever.ProviderMethod>, object: O, key: P) {
  requireObject(req, object, key);
  const property = (object[key] as unknown) as ever.FullContractState;
  requireString(req, property, 'balance');
  requireOptional(req, property, 'lastTransactionId', requireLastTransactionId);
  requireBoolean(req, property, 'isDeployed');
}

function requireFunctionCall<O, P extends keyof O>(req: ever.RawProviderRequest<ever.ProviderMethod>, object: O, key: P) {
  requireObject(req, object, key);
  const property = (object[key] as unknown) as ever.FunctionCall<string>;
  requireString(req, property, 'abi');
  requireString(req, property, 'method');
  requireObject(req, property, 'params');
}

function requireMethodOrArray<O, P extends keyof O>(req: ever.RawProviderRequest<ever.ProviderMethod>, object: O, key: P) {
  const property = object[key];
  if (property != null && typeof property !== 'string' && !Array.isArray(property)) {
    throw invalidRequest(req, `'${String(key)}' must be a method name or an array of possible names`);
  }
}

const invalidRequest = (req: ever.RawProviderRequest<ever.ProviderMethod>, message: string, data?: unknown) =>
  new NekotonRpcError(2, `${req.method}: ${message}`, data);

class NekotonRpcError<T> extends Error {
  code: number;
  data?: T;

  constructor(code: number, message: string, data?: T) {
    if (!Number.isInteger(code)) {
      throw new Error('"code" must be an integer');
    }

    if (!message || (typeof message as any) !== 'string') {
      throw new Error('"message" must be a nonempty string');
    }

    super(message);

    this.code = code;
    this.data = data;
  }

  serialize(): JsonRpcError {
    const serialized: JsonRpcError = {
      code: this.code,
      message: this.message,
    };
    if (this.data !== undefined) {
      serialized.data = this.data;
    }
    if (this.stack) {
      serialized.stack = this.stack;
    }
    return serialized;
  }

  toString(): string {
    return safeStringify(this.serialize(), stringifyReplacer, 2);
  }
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
  stack?: string;
}

const stringifyReplacer = (_: unknown, value: unknown): unknown => {
  if (value === '[Circular]') {
    return undefined;
  }
  return value;
};
