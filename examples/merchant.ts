/**
 * A Veil merchant in one file: your server, a wallet, a price.
 *
 *     node examples/merchant.ts
 *     curl -i localhost:4021/data            # 402 with a one-time account
 *
 * Everything else — the network, the mint, the one-time account pool, the
 * confidentiality gate — defaults. The first run provisions the pool on disk;
 * later runs reuse it. Point `VEIL_PAY_TO` at the wallet you want to be paid at.
 */
import { veil } from '../packages/server/src/index.ts';

const { server, config } = await veil({
  payTo: process.env.VEIL_PAY_TO ?? 'YourWalletAddress11111111111111111111111111',
  price: '0.05',
  path: '/data',
  description: 'My paid endpoint',
  produce: () => ({ hello: 'you paid, privately' }),
});

const port = Number(process.env.PORT ?? 4021);
server.listen(port, () => {
  console.log(`Veil merchant listening on http://127.0.0.1:${port}/data`);
  console.log(`network ${config.network} · mint ${config.mint}`);
  console.log(`discovery http://127.0.0.1:${port}/.well-known/veil`);
});
