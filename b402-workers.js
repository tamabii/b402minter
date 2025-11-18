require('dotenv').config();
const axios = require('axios');
const { ethers } = require('ethers');
const { Worker } = require("worker_threads");

const {
    PRIVATE_KEY,
    JWT,
    MINT_COUNT,
    RPC = "https://bsc.drpc.org",
    API_BASE = "https://www.b402.ai/api/api/v1",

    // USDT recipient (kontrak B402, tempat USDT masuk)
    CONTRACTRELAY = "0x42d59C9cb3082d668568FB7260E1413a31cCc297",

    // Relayer resmi B402
    RELAYER = "0xE1Af7DaEa624bA3B5073f24A6Ea5531434D82d88",

    // BSC-USD (USDT) di BSC
    TOKEN = "0x55d398326f99059fF775485246999027B3197955",

    WORKER_COUNT = 20,

    // opsional override NFT recipient; kalau kosong = WALLET (minter)
    RECIPIENT: RECIPIENT_ENV,
} = process.env;

// 🔹 kontrak NFT B402 Bronze/Silver/Gold
const NFT_CONTRACT = "0xafcD15f17D042eE3dB94CdF6530A97bf32A74E02";

// 🔹 mapping tokenId → tier
const TIER_LABEL = {
    "0": "Bronze",
    "1": "Silver",
    "2": "Gold",
};

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const WALLET = wallet.address;

// 🔹 NFT recipient = override dari .env, kalau kosong pakai WALLET (minter)
const RECIPIENT = RECIPIENT_ENV && RECIPIENT_ENV !== "" ? RECIPIENT_ENV : WALLET;

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function approveUnlimited() {
    const abi = ["function approve(address spender, uint256 value)"];
    const token = new ethers.Contract(TOKEN, abi, wallet);
    const Max = ethers.MaxUint256;

    console.log("--- Approving unlimited USDT for RELAYER...");
    const tx = await token.approve(RELAYER, Max);
    console.log("--- Approve TX:", tx.hash);
    await tx.wait();
    console.log("--- Unlimited USDT approved!");
}

// 🔹 EIP-3009 style permit: USDT keluar dari WALLET → CONTRACTRELAY
async function buildPermit(amount, relayerContract) {
    const net = await provider.getNetwork();
    const now = Math.floor(Date.now() / 1000);

    const msg = {
        token: TOKEN,
        from: WALLET,          // pemilik USDT (minter)
        to: CONTRACTRELAY,     // penerima USDT (kontrak 0x42d59...)
        value: amount,
        validAfter: now - 20,
        validBefore: now + 1800,
        nonce: ethers.hexlify(ethers.randomBytes(32))
    };

    const domain = {
        name: "B402",
        version: "1",
        chainId: net.chainId,
        verifyingContract: relayerContract
    };

    const types = {
        TransferWithAuthorization: [
            { name: "token", type: "address" },
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" }
        ]
    };

    const sig = await wallet.signTypedData(domain, types, msg);
    return { authorization: msg, signature: sig };
}

// 🔹 Interface untuk decode event Transfer ERC-721
const nftIface = new ethers.Interface([
    "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
]);

// 🔹 statistik mint
const nftStats = {
    total: 0,
    byId: {},       // tokenId → jumlah
    byTier: { Bronze: 0, Silver: 0, Gold: 0, Unknown: 0 },
};
let successCount = 0;
let failedCount = 0;
const errorCounts = {};   // code → jumlah

async function logNftFromTx(txHash) {
    try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt) {
            console.log("   (tx receipt belum tersedia, skip detail NFT)");
            return;
        }

        let found = false;

        for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== NFT_CONTRACT.toLowerCase()) continue;

            let parsed;
            try {
                parsed = nftIface.parseLog(log);
            } catch {
                continue;
            }

            const to = parsed.args.to;
            const tokenId = parsed.args.tokenId.toString();

            // hanya catat NFT yang masuk ke RECIPIENT
            if (to.toLowerCase() !== RECIPIENT.toLowerCase()) continue;

            found = true;
            const tier = TIER_LABEL[tokenId] || "Unknown";

            nftStats.total++;
            nftStats.byId[tokenId] = (nftStats.byId[tokenId] || 0) + 1;
            nftStats.byTier[tier] = (nftStats.byTier[tier] || 0) + 1;

            console.log(`   🧩 NFT RECEIVED → Contract ${NFT_CONTRACT}`);
            console.log(`   🎴 Token ID: ${tokenId} (${tier})`);
        }

        if (!found) {
            console.log("   (tidak ada NFT dari kontrak target di tx ini)");
        }
    } catch (e) {
        console.log("   (gagal baca receipt / decode NFT):", e.message || e);
    }
}

(async () => {
    console.log("B402 - WORKERS - SPAM - OTW 🚀");
    console.log("WALLET (minter)      :", WALLET);
    console.log("NFT RECIPIENT        :", RECIPIENT);
    console.log("USDT → CONTRACTRELAY :", CONTRACTRELAY);
    console.log("NFT CONTRACT         :", NFT_CONTRACT);
    console.log("MINT_COUNT           :", MINT_COUNT);
    console.log("WORKER_COUNT         :", WORKER_COUNT);

    const jwt = JWT;

    // 1. Approve USDT unlimited ke RELAYER
    await approveUnlimited();

    // 2. Tes JWT + ambil paymentRequirements via 402
    console.log("--- Fetching payment requirements via 402...");
    let pay;
    try {
        await axios.post(
            `${API_BASE}/faucet/drip`,
            { recipientAddress: RECIPIENT }, // NFT akan dikirim ke RECIPIENT (minter)
            { headers: { Authorization: `Bearer ${jwt}` } }
        );
    } catch (err) {
        if (err.response?.status === 402) {
            pay = err.response.data.paymentRequirements;
            console.log("--- JWT VALID");
            console.log("--- Payment amount     :", pay.amount);
            console.log("--- pay.network        :", pay.network);
            console.log("--- pay.relayerContract:", pay.relayerContract);
        } else {
            console.error(err.response?.data || err.message);
            throw new Error("--- JWT Invalid / tidak bisa baca paymentRequirements");
        }
    }

    // 3. Build semua permit sesuai amount dari server
    console.log(`--- Building ${MINT_COUNT} permits...`);
    const permits = [];
    for (let i = 0; i < MINT_COUNT; i++) {
        permits.push(await buildPermit(pay.amount, pay.relayerContract));

        // 🔹 log progress per 100 permit
        if ((i + 1) % 100 === 0 || i === MINT_COUNT - 1) {
            console.log(`   ✔ Permit built: ${i + 1}/${MINT_COUNT}`);
        }
    }

    // 4. Kirim ke banyak worker paralel – pola sama, hanya log yang kita rapikan
    console.log(`\n[Spawning ${WORKER_COUNT} workers]\n`);
    let nextTask = 0;
    let finished = 0;
    const results = new Array(MINT_COUNT);
    const workers = [];

    function assignJob(worker) {
        if (nextTask >= MINT_COUNT) return;
        const p = permits[nextTask];
        const jobIndex = nextTask;

        worker.busy = true;
        worker.postMessage({
            index: jobIndex + 1,
            jwt,
            API_BASE,
            RECIPIENT,
            TOKEN,
            p,
            pay,
        });

        nextTask++;
    }

    for (let i = 0; i < WORKER_COUNT; i++) {
        const worker = new Worker("./worker.js");
        worker.busy = false;
        workers.push(worker);

        worker.on("message", async (res) => {
            results[res.index - 1] = res;
            worker.busy = false;
            finished++;

            if (res.success) {
                successCount++;
                console.log(`✅ Mint #${res.index} SUCCESS → ${res.tx}`);
                await logNftFromTx(res.tx);
            } else {
                failedCount++;
                const errObj = res.error;
                let code = "unknown";

                if (typeof errObj === "object" && errObj !== null && errObj.code) {
                    code = errObj.code;
                }

                errorCounts[code] = (errorCounts[code] || 0) + 1;

                // 🔹 log FAILED per 100 mint saja (dan beberapa pertama)
                if (failedCount <= 3 || res.index % 100 === 0) {
                    console.log(`⚠️  Mint #${res.index} FAILED (code=${code})`);
                }
            }

            if (finished === Number(MINT_COUNT)) {
                console.log("\n================ SUMMARY ================");
                console.log("Total attempts :", MINT_COUNT);
                console.log("Success mints  :", successCount);
                console.log("Failed mints   :", failedCount);
                console.log("\nError counts:");
                Object.entries(errorCounts).forEach(([code, count]) => {
                    console.log(`  - ${code}: ${count}`);
                });

                console.log("\nNFT received (from contract", NFT_CONTRACT, "to", RECIPIENT, "):");
                console.log("  Total NFT :", nftStats.total);
                console.log("  By Token ID:");
                Object.entries(nftStats.byId).forEach(([id, count]) => {
                    const tier = TIER_LABEL[id] || "Unknown";
                    console.log(`    - ID ${id} (${tier}): ${count}`);
                });
                console.log("  By Tier:");
                Object.entries(nftStats.byTier).forEach(([tier, count]) => {
                    console.log(`    - ${tier}: ${count}`);
                });

                console.log("=========================================\n");

                // 🔹 matikan semua worker & exit process, biar benar-benar stop
                workers.forEach(w => w.terminate());
                setTimeout(() => {
                    process.exit(0);
                }, 500);
                return;
            }

            // tugas berikutnya
            assignJob(worker);
        });

        worker.on("error", (err) => {
            console.log("❌ Worker error:", err);
        });

        worker.on("exit", (code) => {
            if (code !== 0) console.log(`⚠ Worker stopped, code=${code}`);
        });

        assignJob(worker);
    }
})();
