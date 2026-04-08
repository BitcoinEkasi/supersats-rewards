import { createClient } from 'graphql-ws';
import WebSocket from 'ws';

const API_URL = process.env.BLINK_API_URL!;
const WS_URL = process.env.BLINK_WS_URL!;
const API_KEY = process.env.BLINK_API_KEY!;
const WALLET_ID = process.env.BLINK_WALLET_ID!;

// ── HTTP GraphQL helpers ──────────────────────────────────────────────────────

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': API_KEY,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Blink HTTP error: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new Error(`Blink GraphQL error: ${json.errors.map((e) => e.message).join(', ')}`);
  }
  return json.data as T;
}

// ── createInvoice ─────────────────────────────────────────────────────────────

interface InvoiceData {
  lnInvoiceCreate: {
    errors: { message: string }[];
    invoice: { paymentHash: string; paymentRequest: string } | null;
  };
}

export async function createInvoice(
  amountSats: number,
  memo: string
): Promise<{ paymentHash: string; paymentRequest: string }> {
  const data = await gql<InvoiceData>(
    `mutation LnInvoiceCreate($input: LnInvoiceCreateInput!) {
      lnInvoiceCreate(input: $input) {
        errors { message }
        invoice { paymentHash paymentRequest }
      }
    }`,
    { input: { walletId: WALLET_ID, amount: amountSats, memo } }
  );
  if (data.lnInvoiceCreate.errors.length) {
    throw new Error(data.lnInvoiceCreate.errors.map((e) => e.message).join(', '));
  }
  if (!data.lnInvoiceCreate.invoice) {
    throw new Error('No invoice returned from Blink');
  }
  return data.lnInvoiceCreate.invoice;
}

// ── payInvoice ────────────────────────────────────────────────────────────────

export type PaymentStatus = 'SUCCESS' | 'FAILURE' | 'PENDING' | 'ALREADY_PAID';

interface PaymentData {
  lnInvoicePaymentSend: {
    errors: { message: string }[];
    status: PaymentStatus;
  };
}

export async function payInvoice(paymentRequest: string): Promise<PaymentStatus> {
  const data = await gql<PaymentData>(
    `mutation LnInvoicePaymentSend($input: LnInvoicePaymentInput!) {
      lnInvoicePaymentSend(input: $input) {
        errors { message }
        status
      }
    }`,
    { input: { walletId: WALLET_ID, paymentRequest } }
  );
  if (data.lnInvoicePaymentSend.errors.length) {
    throw new Error(data.lnInvoicePaymentSend.errors.map((e) => e.message).join(', '));
  }
  return data.lnInvoicePaymentSend.status;
}

// ── getBalance ────────────────────────────────────────────────────────────────

interface BalanceData {
  me: {
    defaultAccount: {
      wallets: { id: string; balance: number; walletCurrency: string }[];
    };
  };
}

export async function getBalance(): Promise<number> {
  const data = await gql<BalanceData>(
    `query GetBalance {
      me { defaultAccount { wallets { id balance walletCurrency } } }
    }`
  );
  const wallets = data.me.defaultAccount.wallets;
  const btcWallet = wallets.find(
    (w) => w.walletCurrency === 'BTC' || w.id === WALLET_ID
  );
  return btcWallet?.balance ?? 0;
}

// ── getTransactions ───────────────────────────────────────────────────────────

export interface BlinkTx {
  id: string;
  status: string;
  direction: 'SEND' | 'RECEIVE';
  memo: string | null;
  settlementAmount: number;
  settlementFee: number;
  createdAt: number;
}

interface TxData {
  me: {
    defaultAccount: {
      wallets: {
        id: string;
        transactions: {
          edges: { node: BlinkTx }[];
        };
      }[];
    };
  };
}

export async function getTransactions(first = 50): Promise<BlinkTx[]> {
  const data = await gql<TxData>(
    `query GetTransactions {
      me {
        defaultAccount {
          wallets {
            id
            transactions(first: ${first}) {
              edges {
                node {
                  id
                  status
                  direction
                  memo
                  settlementAmount
                  settlementFee
                  createdAt
                }
              }
            }
          }
        }
      }
    }`
  );
  const wallet = data.me.defaultAccount.wallets.find(
    (w) => w.id === WALLET_ID
  );
  return wallet?.transactions.edges.map((e) => e.node) ?? [];
}

// ── WebSocket subscription ────────────────────────────────────────────────────

export function startBlinkSubscription(
  onPayment: (paymentHash: string, amountSats: number) => void
): () => void {
  const wsClient = createClient({
    url: WS_URL,
    webSocketImpl: WebSocket,
    connectionParams: {
      'X-API-KEY': API_KEY,
    },
    retryAttempts: Infinity,
    shouldRetry: () => true,
    on: {
      connected: () => console.log('[blink-ws] connected'),
      closed: () => console.log('[blink-ws] closed'),
      error: (err) => console.error('[blink-ws] error', err),
    },
  });

  const unsubscribe = wsClient.subscribe(
    {
      query: `subscription {
        myUpdates {
          errors { message }
          update {
            __typename
            ... on LnUpdate {
              paymentHash
              status
              transaction {
                settlementAmount
                settlementCurrency
              }
            }
          }
        }
      }`,
    },
    {
      next(data) {
        const update = (data as any)?.data?.myUpdates?.update;
        if (
          update?.__typename === 'LnUpdate' &&
          update.status === 'PAID' &&
          update.transaction?.settlementAmount > 0
        ) {
          const sats: number = Math.abs(update.transaction.settlementAmount);
          onPayment(update.paymentHash as string, sats);
        }
      },
      error(err) {
        console.error('[blink-ws] subscription error', err);
      },
      complete() {
        console.warn('[blink-ws] subscription completed unexpectedly');
      },
    }
  );

  return () => {
    unsubscribe();
    wsClient.dispose();
  };
}
