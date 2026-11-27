// Retry a Telegram bot transport failure while the *same* issued code remains
// valid. Never mint another code or bypass the login attempt limits here.
const delays = [2_000, 5_000, 10_000, 20_000, 40_000];

export function retryableBotDelivery(error) {
  const status = Number(error?.error_code ?? error?.status ?? 0);
  if (status === 429 || status >= 500) return true;
  if (status >= 400) return false;
  const description = String(error?.message ?? error?.description ?? "");
  return /network request|fetch failed|econnreset|etimedout|eai_again|socket hang up/i.test(description);
}

export async function deliverWithRetry(send, expiresAt, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now(), onRetry = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    if (now() >= expiresAt * 1000) return false;
    try {
      const message = await send();
      if (message?.message_id) return message;
      throw new Error("bot message has no message_id");
    } catch (error) {
      const wait = Math.max(delays[attempt] ?? 0, Math.min(60_000, Number(error?.parameters?.retry_after ?? 0) * 1000));
      if (!retryableBotDelivery(error) || attempt >= delays.length || now() + wait >= expiresAt * 1000) {
        throw error;
      }
      onRetry(attempt + 1);
      await sleep(wait);
    }
  }
}
