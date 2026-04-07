/**
 * LNURL-P resolver — converts a Lightning address (user@domain) into a BOLT11 invoice.
 * Flow: parse address → GET /.well-known/lnurlp/user → validate → GET callback?amount=Xmsat → return invoice
 */
export async function resolveLnAddress(address: string, amountSats: number): Promise<string> {
  const atIdx = address.lastIndexOf('@');
  if (atIdx < 1) throw new Error(`Invalid Lightning address: ${address}`);
  const user = address.slice(0, atIdx);
  const domain = address.slice(atIdx + 1);
  if (!user || !domain) throw new Error(`Invalid Lightning address: ${address}`);

  const metaUrl = `https://${domain}/.well-known/lnurlp/${user}`;
  const metaRes = await fetch(metaUrl, { signal: AbortSignal.timeout(10_000) });
  if (!metaRes.ok) throw new Error(`LNURL-P metadata fetch failed: ${metaRes.status} ${metaUrl}`);
  const meta = await metaRes.json() as {
    callback: string;
    minSendable: number;
    maxSendable: number;
    tag?: string;
  };
  if (meta.tag && meta.tag !== 'payRequest') throw new Error(`Unexpected LNURL tag: ${meta.tag}`);

  const amountMsat = amountSats * 1000;
  if (amountMsat < meta.minSendable) throw new Error(`Amount ${amountSats} sats below minimum ${meta.minSendable / 1000} sats`);
  if (amountMsat > meta.maxSendable) throw new Error(`Amount ${amountSats} sats above maximum ${meta.maxSendable / 1000} sats`);

  const callbackUrl = new URL(meta.callback);
  callbackUrl.searchParams.set('amount', String(amountMsat));
  const invoiceRes = await fetch(callbackUrl.toString(), { signal: AbortSignal.timeout(10_000) });
  if (!invoiceRes.ok) throw new Error(`LNURL-P invoice fetch failed: ${invoiceRes.status}`);
  const invoiceData = await invoiceRes.json() as { pr?: string; reason?: string };
  if (!invoiceData.pr) throw new Error(`No invoice returned: ${invoiceData.reason ?? 'unknown error'}`);

  return invoiceData.pr;
}
