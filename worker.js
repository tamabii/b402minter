const { parentPort } = require("worker_threads");
const axios = require("axios");

parentPort.on("message", async (job) => {
  const { index, jwt, API_BASE, RECIPIENT, TOKEN, p, pay } = job;
  try {
    const res = await axios.post(
      `${API_BASE}/faucet/drip`,
      {
        recipientAddress: RECIPIENT,
        paymentPayload: {
          token: TOKEN,
          payload: p
        },
        paymentRequirements: {
          network: pay.network,
          relayerContract: pay.relayerContract
        }
      },
      {
        headers: { Authorization: `Bearer ${jwt}` },
      },
    );
    parentPort.postMessage({
      index,
      success: true,
      tx: res.data.nftTransaction
    });
  } catch (e) {
    parentPort.postMessage({
      index,
      success: false,
      error: e.response?.data || e.message
    });
  }
});
