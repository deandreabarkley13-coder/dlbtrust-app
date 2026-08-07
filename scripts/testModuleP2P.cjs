const { StablecoinDexEngine } = require('/app/server/integrations/dapp/stablecoinDexEngine');
const { ModuleP2PSwapEngine } = require('/app/server/integrations/dapp/moduleP2PSwapEngine');

(async () => {
  try {
    // Mint $0.01 DLBUSD from treasury to operator
    const mint = await StablecoinDexEngine.mintFromSource({ sourceType: 'treasury', sourceAccountId: 'TREASURY_HOT', amount: 0.01 });
    console.log('mint', mint);
    const dlbusdToken = mint.tokenAddress;

    // List for 0.01 USDC
    const order = await ModuleP2PSwapEngine.createOrder({
      tokenIn: dlbusdToken,
      amountIn: 0.01,
      tokenOut: process.env.DAPP_USDC_ADDRESS,
      amountOut: 0.01,
      recipient: process.env.DAPP_OPERATOR_ADDRESS,
    });
    console.log('order', order);

    // List active orders
    const orders = await ModuleP2PSwapEngine.listOrders();
    console.log('orders', orders);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
