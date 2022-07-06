"use strict";

/* ===== TODO LIST =====
 * [DONE] Database write locks.
 * Feedback for listing -- spinner.
 * Create page: Change to link instead of View NFT button.
 * [DONE] Test royalty.
 * [DONE] Minimum listing fee.
 * Guide page.
 * [DONE] Increase content size.
 * [DONE] Split profile: Meta and lists.
 * Socials (sharing).
 * Checkmarks for verified profiles.
 * [DONE] Search bar.
 * [DONE] Prompt to install browser extension wallet if not exists.
 * [DONE] Home page.
 * Non similar profile names
 * NFT stats uploaded
 * [DONE] Fix homepage footer.
 * [DONE] Lower homepage cover image resolution
 *
 * ===== Main website =====
 * [DONE] Update prologue for trailmap.
 * [DONE] Add trailmap link.
 */

const cryptoUtils = require("./cryptoUtils");
const database = require("./database.js");
const fs = require("fs");
const dingo = require("./dingo");
const express = require("express");
const cors = require("cors");
const assert = require("assert");
const storage = require("./storage");
const sizeOf = require("buffer-image-size");
const {
  parseNftTransaction,
  ListTransactionProcessor,
  RepriceTransactionProcessor,
  BuyTransactionProcessor,
} = require("./transactionProcessing");
const AsyncLock = require("async-lock");

const MAX_CONTENT_LENGTH = 10 * 1e6; // 10 MB
const MAX_PREVIEW_LENGTH = 1 * 1e6; // 1 MB
const ACTIVITY_DECAY = 0.1 ** (1 / 1440); // Decay by 90% every 24 hours.

const DINGO_NFTP1_HEIGHT = 511272; // Disable increasing price in reprice.

const isPng = (buffer) => {
  if (!buffer || buffer.length < 8) {
    return false;
  }
  return (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  );
};

const isWebp = (buffer) => {
  if (!buffer || buffer.length < 12) {
    return false;
  }

  return (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  );
};

function asyncHandler(fn) {
  return async function (req, res) {
    try {
      return await fn(req, res);
    } catch (err) {
      console.log(`>>>>> ERROR START [${new Date().toUTCString()}] >>>>>\n`);
      console.log(err);
      console.log("<<<<<< ERROR END <<<<<<\n");
      res.status(500).json(err.stack);
    }
  };
}

(async function main() {
  // Initialize settings.
  const args = process.argv.slice(2);
  const settingsFolder = args.length >= 1 ? args[0] : "settings";
  const privateSettings = JSON.parse(
    fs.readFileSync(`${settingsFolder}/private.DO_NOT_SHARE_THIS.json`)
  );
  const addressingSecret = Buffer.from(privateSettings.addressingSecret, "hex");
  const platformPrivateKey = Buffer.from(
    privateSettings.platformPrivateKey,
    "hex"
  );
  const platformPublicKey =
    cryptoUtils.privateKeyToPublicKey(platformPrivateKey);
  const platformAddress = cryptoUtils.publicKeyToAddress(platformPublicKey);

  // Initialize external services.
  await database.load("database/database.db");
  storage.createClient();

  const listTransactionProcessor = new ListTransactionProcessor(
    platformPrivateKey
  );
  const repriceTransactionProcessor = new RepriceTransactionProcessor(
    platformPrivateKey
  );
  const buyTransactionProcessor = new BuyTransactionProcessor(
    platformPrivateKey
  );

  /*
  // Reupload restore previews.
  for (const f of fs.readdirSync('./restore')) {
    if (f.endsWith('.preview')) {
      const address = f.split('.')[0];
      console.log(`Restoring ${address}...`);

      //const content = fs.readFileSync(`restore/${address}.restore`);
      const meta = await database.getAsset(address);
      const preview = fs.readFileSync(`restore/${address}.preview`);

      //await storage.uploadContent(address, content);
      await storage.uploadPreview(address, preview);
      await storage.uploadMeta(address, {
        name: meta.name,
        description: meta.description,
        tags: meta.tags,
      });

    }
  }
  */

  // Reupload all collections
  /*
  for (const c of await database.getCollections()) {
    await storage.uploadCollection(c.handle, {
      owner: c.owner,
      name: c.name,
      thumbnail: c.thumbnail,
      description: c.description
    });
  }
  */

  // Services and shortcuts.
  const lock = new AsyncLock();
  const acquire = (f) => lock.acquire("lock", f);
  const getNftTransaction = async (txid) => {
    return await parseNftTransaction(
      await dingo.decodeRawTransaction(await dingo.getRawTransaction(txid))
    );
  };
  const getContentPrivateKey = (contentHash) => {
    return cryptoUtils.hmacsha256(contentHash, addressingSecret);
  };
  const getContentAddress = (contentHash) => {
    return cryptoUtils.privateKeyToAddress(getContentPrivateKey(contentHash));
  };
  const getBusy = async (address) => {
    for (const txid of await dingo.getRawMempool()) {
      const tx = await getNftTransaction(txid);
      const listTx = listTransactionProcessor.infer(tx);
      if (listTx !== null && listTx.address === address) {
        return tx;
      }
      const buyTx = buyTransactionProcessor.infer(tx);
      if (buyTx !== null && buyTx.address === address) {
        return tx;
      }
      const repriceTx = repriceTransactionProcessor.infer(tx);
      if (repriceTx !== null && repriceTx.address === address) {
        return tx;
      }
    }
    return null;
  };

  /* ===== Automata and REPL state ===== */
  console.log("Starting live sync...");
  let height = await database.getLastTransactionHeight();
  if (height === null) {
    height = 430000;
  } else {
    height += 1;
  }
  const liveStep = async () => {
    const targetHeight = (await dingo.getBlockchainInfo()).blocks;
    while (height <= targetHeight) {
      // Get block.
      const block = await dingo.getBlock(await dingo.getBlockHash(height));
      // Iterate trasactions.
      for (const txid of block.tx.sort()) {
        const unverifiedTx = await getNftTransaction(txid);
        let tx = null;
        if ((tx = listTransactionProcessor.infer(unverifiedTx)) !== null) {
          // Verify.
          if ((await database.getAssetNonce(tx.address)) === tx.nonce) {
            console.log(`${height} | PROC LIST | ${txid}`);
            // Initialize database transaction.
            await database.beginTransaction();
            // Add transaction to database.
            await database.addTransaction({
              address: tx.address,
              owner: tx.owner,
              txid: txid,
              height: height,
            });
            // Update nft stats.
            const nftStats = await database.getNftStats(tx.address);
            nftStats.creator = tx.owner;
            nftStats.owner = tx.owner;
            nftStats.listHeight = height;
            nftStats.price = tx.price;
            await database.setNftStats(nftStats);
            // Update profile stats.
            const profileStats = await database.getProfileStats(tx.owner);
            if (profileStats.firstListHeight === null) {
              profileStats.firstListHeight = height;
            }
            profileStats.lastListHeight = height;
            profileStats.listCount += 1;
            await database.setProfileStats(profileStats);
            // Complete database transaction.
            await database.endTransaction();
            // Upload nft state.
            await storage.uploadState(tx.address, {
              creator: tx.owner,
              owner: tx.owner,
              stats: nftStats,
            });
          }
        } else if (
          (tx = repriceTransactionProcessor.infer(unverifiedTx)) !== null
        ) {
          // Extract history.
          const txs = await database.getTransactions(tx.address);
          const lastTx = ((tx) =>
            listTransactionProcessor.infer(tx) ||
            buyTransactionProcessor.infer(tx) ||
            repriceTransactionProcessor.infer(tx))(
            await getNftTransaction(txs[txs.length - 1].txid)
          );
          let sellTx = null;
          for (let i = txs.length - 1; sellTx === null; i--) {
            sellTx = ((tx) =>
              listTransactionProcessor.infer(tx) ||
              buyTransactionProcessor.infer(tx))(
              await getNftTransaction(txs[i].txid)
            );
          }
          // Verify tx against chain.
          if (repriceTransactionProcessor.verify(height >= DINGO_NFTP1_HEIGHT ? null : sellTx, lastTx, tx) !== null) {
            console.log(`${height} | PROC REPR  | ${txid}`);
            // Initialize database transaction.
            await database.beginTransaction();
            // Add transaction to database.
            await database.addTransaction({
              address: tx.address,
              owner: tx.owner,
              txid: txid,
              height: height,
            });
            // Update NFT stats.
            const nftStats = await database.getNftStats(tx.address);
            nftStats.price = tx.price;
            await database.setNftStats(nftStats);
            // End database transaction
            await database.endTransaction();
            await storage.uploadState(tx.address, {
              creator: nftStats.creator,
              owner: nftStats.owner,
              stats: nftStats,
            });
          }
        } else if (
          (tx = buyTransactionProcessor.infer(unverifiedTx)) !== null
        ) {
          // Verify nonce.
          if ((await database.getAssetNonce(tx.address)) === tx.nonce) {
            // Get listTx and sellTx.
            // listTX must exist in transaction database and must be valid at
            // this point.
            const listTx = listTransactionProcessor.infer(
              await getNftTransaction(
                (
                  await database.getFirstTransaction(tx.address)
                ).txid
              )
            );
            let sellTx = await database.getLastTransaction(tx.address);
            if (sellTx !== null) {
              sellTx = ((tx) =>
                listTransactionProcessor.infer(tx) ||
                buyTransactionProcessor.infer(tx) ||
                repriceTransactionProcessor.infer(tx))(
                await getNftTransaction(sellTx.txid)
              );
            }
            // Verify link.
            const paymentDetails = buyTransactionProcessor.verifyPayments(
              listTx,
              sellTx,
              tx
            );
            if (paymentDetails !== null) {
              console.log(`${height} | PROC BUY  | ${txid}`);
              // Initialize database transaction.
              await database.beginTransaction();
              // Add transaction to database.
              await database.addTransaction({
                address: tx.address,
                owner: tx.owner,
                txid: txid,
                height: height,
              });
              // Update NFT stats.
              const nftStats = await database.getNftStats(tx.address);
              nftStats.owner = tx.owner;
              if (nftStats.tradeHeight !== null) {
                // Decay previous activity if exists.
                nftStats.tradeCountScaled *=
                  ACTIVITY_DECAY ** (height - nftStats.tradeHeight);
                nftStats.tradeVolumeScaled *=
                  ACTIVITY_DECAY ** (height - nftStats.tradeHeight);
              }
              nftStats.tradeHeight = height;
              nftStats.tradeCount += 1;
              nftStats.tradeVolume = (
                BigInt(nftStats.tradeVolume) + BigInt(sellTx.price)
              ).toString();
              nftStats.price = tx.price;
              nftStats.tradeCountScaled += 1;
              nftStats.tradeVolumeScaled += parseFloat(
                BigInt(sellTx.price) / BigInt(1e8)
              );
              await database.setNftStats(nftStats);
              // Update creator profile stats.
              const listerProfileStats = await database.getProfileStats(
                listTx.owner
              );
              listerProfileStats.listSoldCount += 1;
              listerProfileStats.royaltyVolume = (
                BigInt(listerProfileStats.royaltyVolume) +
                BigInt(paymentDetails.royalty)
              ).toString();
              await database.setProfileStats(listerProfileStats);
              // Update seller profile stats.
              const sellerProfileStats = await database.getProfileStats(
                sellTx.owner
              );
              sellerProfileStats.tradeHeight = height;
              sellerProfileStats.tradeCount += 1;
              sellerProfileStats.sellVolume = (
                BigInt(sellerProfileStats.sellVolume) + BigInt(sellTx.price)
              ).toString();
              await database.setProfileStats(sellerProfileStats);
              // Update buyer profile stats.
              const buyerProfileStats = await database.getProfileStats(
                tx.owner
              );
              buyerProfileStats.tradeHeight = height;
              buyerProfileStats.tradeCount += 1;
              buyerProfileStats.buyVolume = (
                BigInt(buyerProfileStats.buyVolume) + BigInt(sellTx.price)
              ).toString();
              await database.setProfileStats(buyerProfileStats);
              // End database transaction
              await database.endTransaction();
              await storage.uploadState(tx.address, {
                creator: listTx.owner,
                owner: tx.owner,
                stats: nftStats,
              });
            }
          }
        }
      }

      console.log("[Live sync] Height = " + height + " / " + targetHeight);
      height += 1;
    }
    setTimeout(() => liveStep().catch(console.log), 1000);
  };
  liveStep().catch((e) => {
    console.log(e);
  });

  /* ===== Interface ===== */

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "15mb" }));

  app.post(
    "/nft/getListTransaction",
    asyncHandler(async (req, res) => {
      // Extract sell details.
      const { contentHash: contentHashRaw, price, royalty } = req.body;
      const contentHash = Buffer.from(contentHashRaw, "hex");
      res.send({
        vouts: listTransactionProcessor.create(
          getContentAddress(contentHash),
          price,
          royalty
        ),
      });
    })
  );

  app.post(
    "/nft/sendListTransaction",
    asyncHandler(async (req, res) => {
      // Extract and infer transaction.
      let {
        content: contentRaw,
        preview: previewRaw,
        name,
        description,
        tags,
        transaction: rawTx,
      } = req.body;

      // Extract and validate content.
      const content = Buffer.from(contentRaw, "base64");
      if (content.length === 0) {
        return res.send({ error: "Content empty" });
      }
      if (content.length > MAX_CONTENT_LENGTH) {
        return res.send({ error: "Size limit exceeded" });
      }
      const contentHash = cryptoUtils.sha256(content);

      // Extract and validate preview.
      let preview = null;
      if (previewRaw !== null) {
        preview = Buffer.from(previewRaw, "base64");
        if (!isPng(preview) && !isWebp(preview)) {
          return res.send({ error: "Image must be a PNG or WEBP" });
        }
        if (preview.length > MAX_PREVIEW_LENGTH) {
          return res.send({ error: "File size limit exceeded" });
        }
        if (sizeOf(preview).width === 0 || sizeOf(preview).width !== sizeOf(preview).height) {
          return res.send({ error: "Image must have non-zero equal dimensions" });
        }
      }

      // Validate meta
      if (name.length > 40) {
        return res.send({ error: "Name too long" });
      }
      if (description.length > 500) {
        return res.send({ error: "Description too long" });
      }
      if (tags.length > 100) {
        return res.send({ error: "Tags too long" });
      }

      // Extract and validate transaction.
      let tx = await parseNftTransaction(
        await dingo.decodeRawTransaction(rawTx)
      );
      if ((tx = listTransactionProcessor.infer(tx)) === null) {
        return res.send({ error: "Invalid transaction" });
      }
      if (tx.address !== getContentAddress(contentHash)) {
        return res.send({ error: "Content does not match transaction" });
      }

      // Nonce.
      if ((await getBusy(tx.address)) !== null) {
        return res.send({ error: "Asset busy" });
      }

      // Lock write.
      let result = null;
      await acquire(async () => {
        // Check database first.
        if (await database.hasAsset(tx.address)) {
          return res.send({
            error: "Content already registered",
          });
        }

        try {
          // Finally do send.
          result = await dingo.sendRawTransaction(rawTx);
        } catch {
          console.log("Error sending tranasction to mainnet");
          console.log(rawTx);
          return res.send({
            error: "Error sending transaction to mainnet",
          });
        }

        // Write to db.
        await database.addAsset({
          contentHash: contentHash.toString("hex"),
          address: tx.address,
          name: name, // Local copy for lookup.
          tags: tags, // Local copy for lookup.
          description: description, // Local copy for lookup
        });
      });

      if (result !== null) {
        // Add to storage..
        await storage.uploadMeta(tx.address, {
          name: name,
          description: description,
          tags: tags,
        });

        await storage.uploadContent(tx.address, content);
        if (preview !== null) {
          await storage.uploadPreview(tx.address, preview);
        }

        // Respond.
        res.send({
          address: tx.address,
          txid: result,
        });
      }
    })
  );

  app.post(
    "/nft/getRepriceTransaction",
    asyncHandler(async (req, res) => {
      let { address, price } = req.body;
      const nonce = await database.getAssetNonce(address);
      if (nonce === 0) {
        return res.send({ error: "Asset is not listed" });
      }

      const txs = await database.getTransactions(address);
      const lastTx = ((tx) =>
        listTransactionProcessor.infer(tx) ||
        buyTransactionProcessor.infer(tx) ||
        repriceTransactionProcessor.infer(tx))(
        await getNftTransaction(txs[txs.length - 1].txid)
      );
      let sellTx = null;
      for (let i = txs.length - 1; sellTx === null; i--) {
        sellTx = ((tx) =>
          listTransactionProcessor.infer(tx) ||
          buyTransactionProcessor.infer(tx))(
          await getNftTransaction(txs[i].txid)
        );
      }

      const repriceTx = repriceTransactionProcessor.create(
        height >= DINGO_NFTP1_HEIGHT ? null : sellTx,
        lastTx,
        address,
        txs.length,
        price
      );

      if (repriceTx === null) {
        return res.send({ error: "Invalid transaction" });
      }

      res.send({ vins: repriceTx[0], vouts: repriceTx[1] });
    })
  );

  app.post(
    "/nft/sendRepriceTransaction",
    asyncHandler(async (req, res) => {
      // Extract and infer transaction.
      let { transaction: rawTx } = req.body;
      let tx = await parseNftTransaction(
        await dingo.decodeRawTransaction(rawTx)
      );
      if ((tx = repriceTransactionProcessor.infer(tx)) === null) {
        return res.send({ error: "Invalid transaction" });
      }

      await acquire(async () => {
        // Extract history.
        const txs = await database.getTransactions(tx.address);
        const lastTx = ((tx) =>
          listTransactionProcessor.infer(tx) ||
          buyTransactionProcessor.infer(tx) ||
          repriceTransactionProcessor.infer(tx))(
          await getNftTransaction(txs[txs.length - 1].txid)
        );
        let sellTx = null;
        for (let i = txs.length - 1; sellTx === null; i--) {
          sellTx = ((tx) =>
            listTransactionProcessor.infer(tx) ||
            buyTransactionProcessor.infer(tx))(
            await getNftTransaction(txs[i].txid)
          );
        }

        // Verify transaction payments
        if (repriceTransactionProcessor.verify(height >= DINGO_NFTP1_HEIGHT ? null : sellTx, lastTx, tx) === null) {
          return res.send({ error: "Invalid transaction" });
        }

        // Compute asset private key.
        const asset = await database.getAsset(tx.address);
        const assetPrivateKey = getContentPrivateKey(
          Buffer.from(asset.contentHash, "hex")
        );
        const assetAddress = cryptoUtils.privateKeyToAddress(assetPrivateKey);
        assert(tx.address === assetAddress);

        const { hex: signedRawTx, complete: signSuccess } =
          await dingo.signRawTransaction(
            rawTx,
            [],
            [cryptoUtils.toWif(assetPrivateKey)]
          );
        if (!signSuccess) {
          console.log("Hex = ", rawTx);
          throw new Error("Error signing transaction.");
        }

        // Nonce.
        if ((await getBusy(tx.address)) !== null) {
          return res.send({ error: "Asset busy" });
        }

        let result = null;
        try {
          result = await dingo.sendRawTransaction(signedRawTx);
        } catch {
          return res.send({
            error: "Error sending transaction to mainnet",
          });
        }

        res.send({
          txid: result,
        });
      });
    })
  );

  app.post(
    "/nft/getBuyTransaction",
    asyncHandler(async (req, res) => {
      // Extract sell details.
      let { address, price } = req.body;

      const nonce = await database.getAssetNonce(address);
      if (nonce === 0) {
        return res.send({ error: "Asset is not listed" });
      }

      let listTx = listTransactionProcessor.infer(
        await getNftTransaction(
          (
            await database.getFirstTransaction(address)
          ).txid
        )
      );

      let sellTx = await database.getLastTransaction(address);
      sellTx = ((tx) =>
        listTransactionProcessor.infer(tx) ||
        buyTransactionProcessor.infer(tx) ||
        repriceTransactionProcessor.infer(tx))(
        await getNftTransaction(sellTx.txid)
      );

      const [vins, vouts] = buyTransactionProcessor.create(
        listTx,
        sellTx,
        address,
        nonce,
        price
      );

      res.send({ vins: vins, vouts: vouts });
    })
  );

  app.post(
    "/nft/sendBuyTransaction",
    asyncHandler(async (req, res) => {
      // Extract and infer transaction.
      let { transaction: rawTx } = req.body;
      let tx = await parseNftTransaction(
        await dingo.decodeRawTransaction(rawTx)
      );
      if ((tx = buyTransactionProcessor.infer(tx)) === null) {
        return res.send({ error: "Invalid transaction" });
      }

      await acquire(async () => {
        // Extract history.
        let listTx = listTransactionProcessor.infer(
          await getNftTransaction(
            (
              await database.getFirstTransaction(tx.address)
            ).txid
          )
        );
        let sellTx = await database.getLastTransaction(tx.address);
        sellTx = ((tx) =>
          listTransactionProcessor.infer(tx) ||
          buyTransactionProcessor.infer(tx) ||
          repriceTransactionProcessor.infer(tx))(
          await getNftTransaction(sellTx.txid)
        );

        // Verify transaction payments
        if (
          buyTransactionProcessor.verifyPayments(listTx, sellTx, tx) === null
        ) {
          return res.send({ error: "Invalid transaction" });
        }

        // Compute asset private key.
        const asset = await database.getAsset(tx.address);
        const assetPrivateKey = getContentPrivateKey(
          Buffer.from(asset.contentHash, "hex")
        );
        const assetAddress = cryptoUtils.privateKeyToAddress(assetPrivateKey);
        assert(tx.address === assetAddress);

        const { hex: signedRawTx, complete: signSuccess } =
          await dingo.signRawTransaction(
            rawTx,
            [],
            [cryptoUtils.toWif(assetPrivateKey)]
          );
        if (!signSuccess) {
          console.log("Hex = ", rawTx);
          throw new Error("Error signing transaction.");
        }

        // Nonce.
        if ((await getBusy(tx.address)) !== null) {
          return res.send({ error: "Asset busy" });
        }

        let result = null;
        try {
          result = await dingo.sendRawTransaction(signedRawTx);
        } catch {
          return res.send({
            error: "Error sending transaction to mainnet",
          });
        }

        res.send({
          txid: result,
        });
      });
    })
  );

  app.post(
    "/nft/getBusy",
    asyncHandler(async (req, res) => {
      const { address } = req.body;
      res.send({
        busy: await getBusy(address),
      });
    })
  );

  app.post(
    "/nft/getContent",
    asyncHandler(async (req, res) => {
      const { address, timestamp, signature } = req.body;

      if (timestamp < Date.now() - 60 * 1000) {
        return res.send({ error: "Request expired" });
      }

      const sellTx = await database.getLastTransaction(address);
      if (sellTx === null) {
        return res.send({ error: "Asset has no owner" });
      }

      const message = `${address}|${timestamp}`;
      const signaturePublicKeys = cryptoUtils.recover(
        cryptoUtils.sha256(Buffer.from(message, "utf8")),
        Buffer.from(signature, "hex")
      );
      if (
        signaturePublicKeys.every(
          (x) => cryptoUtils.publicKeyToAddress(x) !== sellTx.owner
        )
      ) {
        return res.send({ error: "Wrong signature" });
      }

      res.send({ content: await storage.authorizeContent(address) });
    })
  );

  app.post(
    "/nft/query",
    asyncHandler(async (req, res) => {
      const { key, direction, offset, limit } = req.body;
      return res.send({
        results: await database.queryNft(key, direction, offset, limit),
      });
    })
  );

  app.post(
    "/nft/queryBySearch",
    asyncHandler(async (req, res) => {
      const { search } = req.body;
      if (
        search === null ||
        search === undefined ||
        search.trim() === "" ||
        search.trim().length > 50
      ) {
        return res.send({ results: null });
      }

      return res.send({
        results: await database.queryNftBySearch(search),
      });
    })
  );

  app.post(
    "/nft/queryByNewest",
    asyncHandler(async (req, res) => {
      const { beforeId } = req.body;
      return res.send({
        results: await database.queryNftByNewest(beforeId),
      });
    })
  );

  app.post(
    "/profile/update",
    asyncHandler(async (req, res) => {
      const { timestamp, owner, name, thumbnail, signature } = req.body;
      const message = JSON.stringify({
        timestamp: timestamp,
        owner: owner,
        name: name,
        thumbnail: thumbnail,
      });

      // Verify signature
      const signaturePublicKeys = cryptoUtils.recover(
        cryptoUtils.sha256(Buffer.from(message, "utf8")),
        Buffer.from(signature, "hex")
      );
      if (
        signaturePublicKeys.every(
          (x) => cryptoUtils.publicKeyToAddress(x) !== owner
        )
      ) {
        return res.send({ error: "Wrong signature" });
      }

      // Verify timestamp
      if (timestamp < Date.now() - 60 * 1000) {
        return res.send({ error: "Request expired" });
      }

      // Validate name length.
      if (name.trim() !== name) {
        return res.send({ error: "Name has trailing spaces" });
      }
      if (name.length > 40) {
        return res.send({ error: "Name too long" });
      }

      // Validate thumbnail.
      if (thumbnail !== null) {
        if (!(await database.isProfileHistoricalAsset(owner, thumbnail))) {
          return res.send({ error: "Wrong thumbnail creator" });
        }
      }

      // Update database.
      await acquire(async () => {
        const profile = (await database.getProfile(owner)) || {};
        if (profile.owner === undefined) {
          // Not previously defined.
          profile.owner = owner;
        }
        if (name !== null) {
          profile.name = name;
        }
        if (profile.name === undefined) {
          // Not previously defined, and not setting.
          profile.name = "";
        }
        profile.thumbnail = thumbnail;
        await database.setProfile(profile);
      });
      // Update storage.
      await storage.uploadProfile(owner, {
        name: name,
        thumbnail: thumbnail,
      });

      res.send({});
    })
  );

  app.post(
    "/profile/getCreatedNfts",
    asyncHandler(async (req, res) => {
      const { owner } = req.body;
      return res.send({
        results: await database.getProfileCreatedAssets(owner),
      });
    })
  );

  app.post(
    "/profile/getOwnedNfts",
    asyncHandler(async (req, res) => {
      const { owner } = req.body;
      return res.send({ results: await database.getProfileOwnedAssets(owner) });
    })
  );

  app.post(
    "/profile/getHistoricalNfts",
    asyncHandler(async (req, res) => {
      const { owner } = req.body;
      return res.send({
        results: await database.getProfileHistoricalAssets(owner),
      });
    })
  );

  app.post(
    "/profile/getStats",
    asyncHandler(async (req, res) => {
      const { owner } = req.body;
      return res.send(await database.getProfileStats(owner));
    })
  );

  app.post(
    "/profile/getCreatedCount",
    asyncHandler(async (req, res) => {
      const { owner } = req.body;
      return res.send(await database.getProfileCreatedCount(owner));
    })
  );

  app.post(
    "/profile/getCollectionCount",
    asyncHandler(async (req, res) => {
      const { owner } = req.body;
      return res.send(await database.getProfileCollectionCount(owner));
    })
  );

  app.post(
    "/profile/getHistoricalCount",
    asyncHandler(async (req, res) => {
      const { owner } = req.body;
      return res.send(await database.getProfileHistoricalCount(owner));
    })
  );

  app.post(
    "/profile/queryBySearch",
    asyncHandler(async (req, res) => {
      const { search } = req.body;
      if (
        search === null ||
        search === undefined ||
        search.trim() === "" ||
        search.trim().length > 50
      ) {
        return res.send({ results: null });
      }

      const results = await database.queryProfileBySearch(search);
      // Add profile by address if no meta exists.
      if (cryptoUtils.isAddress(search) && !results.includes(search)) {
        results.push(search);
      }
      return res.send({
        results: results,
      });
    })
  );

  app.post(
    "/profile/queryByTradeCount",
    asyncHandler(async (req, res) => {
      return res.send({
        results: await database.queryProfileByTradeCount(),
      });
    })
  );

  app.post(
    "/profile/queryByEarnings",
    asyncHandler(async (req, res) => {
      return res.send({
        results: await database.queryProfileByEarnings(),
      });
    })
  );

  app.post("/collection/getStats", async (req, res) => {
    const { handle } = req.body;
    return res.send(await database.getCollectionStats(handle));
  });

  app.post("/collection/queryByOwner", async (req, res) => {
    const { owner } = req.body;
    return res.send(await database.queryCollectionByOwner(owner));
  });

  app.post("/collection/queryUnassignedNftsByOwner", async (req, res) => {
    const { owner } = req.body;
    return res.send(await database.queryUnassignedNftsByOwner(owner));
  });

  app.post(
    "/collection/queryBySearch",
    asyncHandler(async (req, res) => {
      const { search } = req.body;
      if (
        search === null ||
        search === undefined ||
        search.trim() === "" ||
        search.trim().length > 50
      ) {
        return res.send({ results: null });
      }

      return res.send({
        results: await database.queryCollectionBySearch(search),
      });
    })
  );

  app.post(
    "/collection/create",
    asyncHandler(async (req, res) => {
      const {
        timestamp,
        handle,
        owner,
        name,
        thumbnail,
        description,
        signature,
      } = req.body;
      const message = JSON.stringify({
        timestamp: timestamp,
        owner: owner,
        handle: handle,
        name: name,
        thumbnail: thumbnail,
        description: description,
      });

      // Verify signature
      const signaturePublicKeys = cryptoUtils.recover(
        cryptoUtils.sha256(Buffer.from(message, "utf8")),
        Buffer.from(signature, "hex")
      );
      if (
        signaturePublicKeys.every(
          (x) => cryptoUtils.publicKeyToAddress(x) !== owner
        )
      ) {
        return res.send({ error: "Wrong signature" });
      }

      // Verify timestamp
      if (timestamp < Date.now() - 60 * 1000) {
        return res.send({ error: "Request expired" });
      }

      // Validate handle.
      if (!handle.match(/^([a-z0-9])+$/) || handle.length > 40) {
        return res.send({ error: "Bad handle format" });
      }
      // Validate name length.
      if (name.length > 40) {
        return res.send({ error: "Name too long" });
      }
      // validate description length.
      if (description.length > 500) {
        return res.send({ error: "Description too long" });
      }

      // Validate thumbnail.
      if (thumbnail !== null) {
        const assetListTx = await database.getFirstTransaction(thumbnail);
        if (assetListTx.owner !== owner) {
          return res.send({ error: "Wrong thumbnail creator" });
        }
      }

      //TODO Lock? Maybe not needed here, since nothing else can be
      // done until the collection has been created; and two create
      // request at the same time will just lead to a rejection
      // on duplicate column by DB.
      await database.setCollection({
        handle: handle,
        owner: owner,
        name: name,
        thumbnail: thumbnail,
        description: description,
      });

      // Upload to storage.
      await storage.uploadCollection(handle, {
        owner: owner,
        name: name,
        thumbnail: thumbnail,
        description: description,
      });

      res.send({});
    })
  );

  app.post(
    "/collection/update",
    asyncHandler(async (req, res) => {
      const { timestamp, handle, name, thumbnail, description, signature } =
        req.body;
      const message = JSON.stringify({
        timestamp: timestamp,
        handle: handle,
        name: name,
        thumbnail: thumbnail,
        description: description,
      });

      // Retrieve owner.
      const collection = await database.getCollection(handle);
      if (collection === null) {
        return res.send({ error: "Invalid collection" });
      }

      // Verify signature
      const signaturePublicKeys = cryptoUtils.recover(
        cryptoUtils.sha256(Buffer.from(message, "utf8")),
        Buffer.from(signature, "hex")
      );
      if (
        signaturePublicKeys.every(
          (x) => cryptoUtils.publicKeyToAddress(x) !== collection.owner
        )
      ) {
        return res.send({ error: "Wrong signature" });
      }

      // Verify timestamp
      if (timestamp < Date.now() - 60 * 1000) {
        return res.send({ error: "Request expired" });
      }

      // Validate handle.
      if (!handle.match(/^([a-z0-9])+$/) || handle.length > 40) {
        return res.send({ error: "Bad handle format" });
      }
      // Validate name length.
      if (name.length > 40) {
        return res.send({ error: "Name too long" });
      }
      // validate description length.
      if (description.length > 500) {
        return res.send({ error: "Description too long" });
      }

      // Validate thumbnail.
      if (thumbnail !== null) {
        const assetListTx = await database.getFirstTransaction(thumbnail);
        if (assetListTx.owner !== collection.owner) {
          return res.send({ error: "Wrong thumbnail creator" });
        }
      }

      //TODO Lock? Maybe not needed here, since nothing else can be
      // done until the collection has been created; and two create
      // request at the same time will just lead to a rejection
      // on duplicate column by DB.
      await database.setCollection({
        handle: handle,
        name: name,
        thumbnail: thumbnail,
        description: description,
      });

      // Upload to storage.
      await storage.uploadCollection(handle, {
        owner: collection.owner,
        name: name,
        thumbnail: thumbnail,
        description: description,
      });

      res.send({});
    })
  );

  app.post(
    "/collection/setItem",
    asyncHandler(async (req, res) => {
      const { timestamp, address, handle, signature } = req.body;

      // Get collection.
      const collection = await database.getCollection(handle);
      if (collection === null) {
        return res.send({ error: "Invalid collection" });
      }

      // Verify signature
      const message = JSON.stringify({
        timestamp: timestamp,
        address: address,
        handle: handle,
      });
      const signaturePublicKeys = cryptoUtils.recover(
        cryptoUtils.sha256(Buffer.from(message, "utf8")),
        Buffer.from(signature, "hex")
      );
      if (
        signaturePublicKeys.every(
          (x) => cryptoUtils.publicKeyToAddress(x) !== collection.owner
        )
      ) {
        return res.send({ error: "Wrong signature" });
      }
      // Verify timestamp
      if (timestamp < Date.now() - 60 * 1000) {
        return res.send({ error: "Request expired" });
      }

      const nft = await database.getAsset(address);
      if (nft === null) {
        return res.send({ error: "Invalid NFT" });
      }

      const listTx = await database.getFirstTransaction(address);
      if (listTx === null) {
        return res.send({ error: "Invalid NFT" });
      }

      if (collection.owner !== listTx.owner) {
        return res.send({ error: "Incorrect ownership" });
      }

      await database.setCollectionItem(address, handle);
      res.send({});
    })
  );

  app.post(
    "/collection/getItems",
    asyncHandler(async (req, res) => {
      const { handle } = req.body;
      res.send(await database.getCollectionItems(handle));
    })
  );

  app.post(
    "/collection/getItemCollection",
    asyncHandler(async (req, res) => {
      const { address } = req.body;
      return res.send({
        handle: await database.getItemCollection(address),
      });
    })
  );

  app.post(
    "/collection/queryByTradeCountScaled",
    asyncHandler(async (req, res) => {
      const { limit } = req.body;
      return res.send({
        results: await database.queryCollectionByScaled(
          "tradeCountScaled",
          ACTIVITY_DECAY,
          height,
          limit
        ),
      });
    })
  );

  app.post(
    "/collection/queryByTradeVolumeScaled",
    asyncHandler(async (req, res) => {
      return res.send({
        results: await database.queryCollectionByScaled(
          "tradeVolumeScaled",
          ACTIVITY_DECAY,
          height,
          100
        ),
      });
    })
  );

  app.post(
    "/collection/queryByTradeVolume",
    asyncHandler(async (req, res) => {
      return res.send({
        results: await database.queryCollectionByScaled(
          "tradeVolume",
          1,
          height,
          100
        ),
      });
    })
  );

  app.post(
    "/collection/queryByValuable",
    asyncHandler(async (req, res) => {
      return res.send({
        results: await database.queryCollectionByValuable(),
      });
    })
  );

  app.post(
    "/getPlatformStats",
    asyncHandler(async (req, res) => {
      return res.send(await database.getPlatformStats());
    })
  );

  app.listen(80, () => {
    console.log("Started");
  });
})();
