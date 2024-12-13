const cryptoUtils = require("./cryptoUtils");
const dingo = require("./dingo");
const assert = require("assert");

const LISTING_FEE = dingo.toSatoshi("100"); //old 1000
const REPRICE_FEE = dingo.toSatoshi("100"); //old 1000
const LINK_PAYMENT = dingo.toSatoshi("1"); // 1 coin.
const PLATFORM_TAX = "25"; // 2.5%
const DUST = "100000000"; // 1 coin.
const MIN_PRICE = dingo.toSatoshi("1"); // 1 coin.
const MAX_PRICE = dingo.toSatoshi("1000000000000"); // 1T coin.
const MAX_PRICE_MULTIPLY = 10n;
const DEBUG = false;

function debugLog(...x) {
  if (DEBUG) {
    console.log(...x);
  }
}

function computeRoyalty(value, royalty) {
  return ((BigInt(value) * BigInt(royalty)) / 1000n).toString();
}

function computeTax(value) {
  return computeRoyalty(value, PLATFORM_TAX);
}

async function resolveVout(txid, index) {
  const tx = await dingo.decodeRawTransaction(
    await dingo.getRawTransaction(txid)
  );
  return {
    address: tx.vout[index].scriptPubKey.addresses[0],
    value: dingo.toSatoshi(tx.vout[index].value),
  };
}

async function parseNftTransaction(tx) {
  const vins = [];
  for (const x of tx.vin.filter((x) => !("coinbase" in x))) {
    vins.push(await resolveVout(x.txid, x.vout));
  }

  const vouts = [];
  let opReturn = null;
  for (const x of tx.vout) {
    if (x.scriptPubKey.type === "nulldata") {
      opReturn = Buffer.from(x.scriptPubKey.asm.split(" ")[1], "hex");
    } else {
      vouts.push({
        address: x.scriptPubKey.addresses[0],
        value: dingo.toSatoshi(x.value),
      });
    }
  }

  return {
    txid: tx.txid,
    vins: vins,
    vouts: vouts,
    data: opReturn,
  };
}

class ListTransactionProcessor {
  constructor(platformPrivateKey) {
    this.platformPrivateKey = platformPrivateKey;
    this.platformAddress = cryptoUtils.privateKeyToAddress(platformPrivateKey);
  }
  create(address, price, royalty) {
    if (
      BigInt(price) < BigInt(MIN_PRICE) ||
      BigInt(price) > BigInt(MAX_PRICE)
    ) {
      //return res.send({ error: "Listing price not in accepted range." });
      return null;
    }

    if (!Number.isInteger(royalty) || royalty < 25 || royalty > 100) {
      //return res.send({ error: "Invalid royalty" });
      return null;
    }

    const vouts = {};
    vouts[this.platformAddress] = LISTING_FEE; // Link to platform address.
    vouts[address] = LINK_PAYMENT; // Link to asset address.
    vouts["data"] = Buffer.from(`0|LIST|${price}|${royalty}|`, "utf8").toString(
      "hex"
    );
    return vouts;
  }
  infer(tx) {
    // Check if signature is present and in the correct format.
    if (
      tx.data === null ||
      tx.data.toString("utf8").match(/0\|LIST\|[0-9]+\|[0-9]+/) === null
    ) {
      return null;
    }
    debugLog("=== Inferring for ListTransactionProcessor ===");

    // Extract tokens.
    const tokens = tx.data.toString("utf8").split("|");
    const [nonce, price, royalty] = [
      parseInt(tokens[0]),
      tokens[2],
      parseInt(tokens[3]),
    ];
    debugLog("  Tokens = ", nonce, price, royalty);

    // Check price.
    if (
      BigInt(price) < BigInt(MIN_PRICE) ||
      BigInt(price) > BigInt(MAX_PRICE)
    ) {
      return null;
    }
    debugLog("  Price valid");

    // Check royalty.
    if (!Number.isInteger(royalty) || royalty < 25 || royalty > 100) {
      return null;
    }
    debugLog("  Royalty valid");

    // Check unique owner address.
    if (new Set(tx.vins.map((x) => x.address)).size !== 1) {
      return null;
    }
    const ownerAddress = tx.vins[0].address;
    debugLog("  Owner = ", ownerAddress);

    // Check vouts are unique in address.
    for (const vout of tx.vouts) {
      if (tx.vouts.filter((x) => x.address === vout.address).length !== 1) {
        return null;
      }
    }
    debugLog("  Unique vout");

    // Check for valid platform link.
    if (
      tx.vouts.filter(
        (x) => x.address === this.platformAddress && x.value === LISTING_FEE
      ).length !== 1
    ) {
      return null;
    }
    debugLog("  Platform link");

    // Infer asset vout by eliminating platform and change address.
    const possibleAssetVouts = tx.vouts.filter(
      (x) => ![this.platformAddress, ownerAddress].includes(x.address)
    );
    if (possibleAssetVouts.length !== 1) {
      return false;
    }
    const assetVout = possibleAssetVouts[0];
    if (assetVout.value !== LINK_PAYMENT) {
      return null;
    }
    debugLog("  Asset address = ", assetVout.address);

    debugLog("  >> Inference successful!");
    return {
      txid: tx.txid,
      vins: tx.vins,
      vouts: tx.vouts,
      address: assetVout.address,
      nonce: nonce, // Should be zero.
      owner: ownerAddress,
      price: price,
      royalty: royalty,
    };
  }
}

class RepriceTransactionProcessor {
  constructor(platformPrivateKey) {
    this.platformPrivateKey = platformPrivateKey;
    this.platformAddress = cryptoUtils.privateKeyToAddress(platformPrivateKey);
  }
  create(sellTx, lastTx, address, nonce, price) {

    try {
      price = BigInt(price);
    } catch {
      // return res.send({ error: "Invalid selling price" });
      return null;
    }
    if (
      price < BigInt(MIN_PRICE) ||
      price > (sellTx === null ? BigInt(lastTx.price) : (MAX_PRICE_MULTIPLY * BigInt(sellTx.price))) ||
      price > BigInt(MAX_PRICE)
    ) {
      //return res.send({ error: "Listing price not in accepted range." });
      return null;
    }
    price = price.toString();

    // Get UTXO of asset's address.
    const vins = lastTx.vouts
      .map((x, i) => {
        // Map before filter to retain correct index.
        return {
          address: x.address,
          vout: i,
        };
      })
      .filter((x) => x.address === address)
      .map((x) => {
        return {
          txid: lastTx.txid,
          vout: x.vout,
        };
      });
    assert(vins.length === 1);

    // Add links.
    const vouts = {};
    vouts[this.platformAddress] = REPRICE_FEE; // Link to platform address.
    vouts[address] = LINK_PAYMENT; // Link to asset address.
    vouts["data"] = Buffer.from(`${nonce}|REPRICE|${price}`, "utf8").toString(
      "hex"
    );
    return [vins, vouts];
  }
  infer(tx) {
    // Check if signature is present and in the correct format.
    debugLog("=== Inferring for RepriceTransactionProcessor ===");
    if (
      tx.data === null ||
      tx.data.toString("utf8").match(/[0-9]+\|REPRICE\|[0-9]+/) === null
    ) {
      return null;
    }
    debugLog("  Format OK");

    // Extract tokens.
    const tokens = tx.data.toString("utf8").split("|");
    const [nonce, price] = [parseInt(tokens[0]), tokens[2]];
    debugLog("  Nonce, Price = ", nonce, price);

    // Check price.
    if (
      BigInt(price) < BigInt(MIN_PRICE) ||
      BigInt(price) > BigInt(MAX_PRICE)
    ) {
      return null;
    }
    debugLog("  Price valid");

    // Check that there are exactly two unique vin unique address.
    // Extract assetAddress as first entry, and owner address.
    if (tx.vins.size < 2) {
      return null;
    }
    const assetVin = tx.vins[0];
    debugLog("  Asset vin = ", assetVin);
    if (new Set(tx.vins.slice(1).map((x) => x.address)).size !== 1) {
      return null;
    }
    const ownerAddress = tx.vins[1].address;
    debugLog("  Owner address = ", ownerAddress);

    // Check that addresses are not duplicated.
    if (
      new Set([this.platformAddress, assetVin.address, ownerAddress]).size !== 3
    ) {
      return null;
    }
    debugLog("  Unique addresses");

    // Check vouts are unique in address.
    for (const vout of tx.vouts) {
      if (tx.vouts.filter((x) => x.address === vout.address).length !== 1) {
        return null;
      }
    }
    debugLog("  Unique vout");

    // Check for valid platform link.
    if (
      tx.vouts.filter(
        (x) => x.address === this.platformAddress && x.value === LISTING_FEE
      ).length !== 1
    ) {
      return null;
    }
    debugLog("  Platform link");

    // Infer asset vout by eliminating platform and change address.
    const possibleAssetVouts = tx.vouts.filter(
      (x) => ![this.platformAddress, ownerAddress].includes(x.address)
    );
    if (possibleAssetVouts.length !== 1) {
      return false;
    }
    const assetVout = possibleAssetVouts[0];
    if (assetVout.value !== LINK_PAYMENT) {
      return null;
    }
    debugLog("  Asset address = ", assetVout.address);

    debugLog("  >> Inference successful!");
    return {
      txid: tx.txid,
      vins: tx.vins,
      vouts: tx.vouts,
      address: assetVout.address,
      nonce: nonce,
      owner: ownerAddress,
      price: price
    };
  }
  verify(sellTx, lastTx, tx) {
    // Check nonce.
    if (tx.nonce !== lastTx.nonce + 1) {
      return null;
    }

    // Check price.
    if (tx.price  > (sellTx === null ? BigInt(lastTx.price) : (MAX_PRICE_MULTIPLY * BigInt(sellTx.price)))) {
      return null;
    }

    // Check owner.
    if (tx.owner !== lastTx.owner) {
      return null;
    }

    return {
      owner: tx.owner
    };
  }
}

class BuyTransactionProcessor {
  constructor(platformPrivateKey) {
    this.platformPrivateKey = platformPrivateKey;
    this.platformAddress = cryptoUtils.privateKeyToAddress(platformPrivateKey);
  }
  create(listTx, sellTx, address, nonce, price) {
    try {
      price = BigInt(price);
    } catch {
      return null;
    }
    if (
      price < BigInt(MIN_PRICE) ||
      price > MAX_PRICE_MULTIPLY * BigInt(sellTx.price) ||
      price > BigInt(MAX_PRICE)
    ) {
      return null;
    }
    price = price.toString();

    // Get UTXO of asset's address.
    const vins = sellTx.vouts
      .map((x, i) => {
        // Map before filter to retain correct index.
        return {
          address: x.address,
          vout: i,
        };
      })
      .filter((x) => x.address === address)
      .map((x) => {
        return {
          txid: sellTx.txid,
          vout: x.vout,
        };
      });
    assert(vins.length === 1);

    let tax = computeTax(sellTx.price);
    let royalty = computeRoyalty(sellTx.price, listTx.royalty);
    const sellerPayment = (
      BigInt(sellTx.price) -
      (BigInt(tax) < BigInt(DUST) ? 0n : BigInt(tax)) - // If tax < dust, deduct additional.from user instead.
      (BigInt(royalty) < BigInt(DUST) ? 0n : BigInt(royalty))
    ) // If royalty < dust, deduct additional from user instead.
      .toString();
    if (BigInt(tax) < BigInt(DUST)) {
      tax = DUST; // If tax < dust, deduct additional.from user instead.
    }
    if (BigInt(royalty) < BigInt(DUST)) {
      royalty = DUST; // If royalty < dust, deduct additional.from user instead.
    }

    const vouts = {};
    vouts[this.platformAddress] = tax; // Payment to platform address.
    vouts[address] = LINK_PAYMENT.toString(); // Link to asset address.
    if (listTx.owner === sellTx.owner) {
      // For the first buy, listTx and sellTx are the same.
      vouts[listTx.owner] = (
        BigInt(royalty) + BigInt(sellerPayment)
      ).toString();
    } else {
      vouts[listTx.owner] = royalty; // Payment to creator.
      vouts[sellTx.owner] = sellerPayment; // Payment to seller.
    }
    vouts["data"] = Buffer.from(`${nonce}|BUY|${price}`, "utf8").toString(
      "hex"
    );

    return [vins, vouts];
  }
  infer(tx) {
    // Check if signature is present and in the correct format.
    if (
      tx.data === null ||
      tx.data.toString("utf8").match(/[0-9]+\|BUY\|[0-9]+/) === null
    ) {
      return null;
    }
    debugLog("=== Inferring for BuyTransactionProcessor ===");
    debugLog(tx);

    // Extract tokens.
    const tokens = tx.data.toString("utf8").split("|");
    const [nonce, price] = [parseInt(tokens[0]), tokens[2]];
    debugLog("  Nonce, Price = ", nonce, price);

    // Check price.
    if (
      BigInt(price) < BigInt(MIN_PRICE) ||
      BigInt(price) > BigInt(MAX_PRICE)
    ) {
      return null;
    }

    // Check that there are exactly two unique vin unique address.
    // Extract assetAddress as first entry, and owner address.
    if (tx.vins.size < 2) {
      return null;
    }
    const assetVin = tx.vins[0];
    debugLog("  Asset vin = ", assetVin);
    if (new Set(tx.vins.slice(1).map((x) => x.address)).size !== 1) {
      return null;
    }
    const ownerAddress = tx.vins[1].address;
    debugLog("  Owner address = ", ownerAddress);

    // Check that addresses are not duplicated.
    if (
      new Set([this.platformAddress, assetVin.address, ownerAddress]).size !== 3
    ) {
      return null;
    }
    debugLog("  Unique addresses");

    // Check vouts are unique in address.
    // This usually fails if the creator or the latest owner is trying to buy
    // his/her own asset.
    for (const vout of tx.vouts) {
      if (tx.vouts.filter((x) => x.address === vout.address).length !== 1) {
        debugLog(tx.vouts);
        return null;
      }
    }
    debugLog("  Unique vout");

    // Check for valid platform link.
    if (
      tx.vouts.filter(
        (x) =>
          x.address === this.platformAddress &&
          BigInt(x.value) >= BigInt(LINK_PAYMENT)
      ).length !== 1
    ) {
      return null;
    }
    debugLog("  Platform link");

    // Check for valid asset link.
    if (
      tx.vouts.filter(
        (x) => x.address === assetVin.address && x.value === LINK_PAYMENT
      ).length !== 1
    ) {
      return null;
    }
    debugLog("  Asset link");

    // Check payments from remaining vouts.
    const payments = tx.vouts.filter(
      (x) =>
        ![this.platformAddress, assetVin.address, ownerAddress].includes(
          x.address
        )
    );

    // Tax and royalty are either shared or separate.
    if (!(payments.length === 1 || (payments.length === 2 && payments[0].address !== payments[1].address))) {
      return null;
    }
    debugLog("  Payment count valid");

    debugLog("  >> Inference successful!");
    return {
      txid: tx.txid,
      vins: tx.vins,
      vouts: tx.vouts,
      address: assetVin.address,
      nonce: nonce,
      owner: ownerAddress,
      payments: payments,
      price: price,
    };
  }
  verifyPayments(listTx, sellTx, tx) {
    // Check nonce.
    if (tx.nonce !== sellTx.nonce + 1) {
      return null;
    }

    // Check price.
    if (tx.price > MAX_PRICE_MULTIPLY * BigInt(sellTx.price)) {
      return null;
    }
    // Check tax and royalty.
    let tax = computeTax(sellTx.price);
    let royalty = computeRoyalty(sellTx.price, listTx.royalty);
    const sellerPayment = (
      BigInt(sellTx.price) -
      (BigInt(tax) < BigInt(DUST) ? 0n : BigInt(tax)) - // If tax < dust, deduct additional.from user instead.
      (BigInt(royalty) < BigInt(DUST) ? 0n : BigInt(royalty))
    ) // If royalty < dust, deduct additional from user instead.
      .toString();
    if (BigInt(tax) < BigInt(DUST)) {
      tax = DUST; // If tax < dust, deduct additional.from user instead.
    }
    if (BigInt(royalty) < BigInt(DUST)) {
      royalty = DUST; // If royalty < dust, deduct additional.from user instead.
    }

    if (listTx.owner === sellTx.owner) {
      // For the first buy, listTx and sellTx are the same.
      assert(tx.payments.length === 1);
      return tx.payments[0].address === listTx.owner &&
        tx.payments[0].value ===
          (BigInt(royalty) + BigInt(sellerPayment)).toString()
        ? {
            tax: tax,
            royalty: royalty,
          }
        : null;
    } else {
      assert(tx.payments.length === 2);
      for (let i = 0; i < 2; i++) {
        if (
          tx.payments[i].address === listTx.owner &&
          tx.payments[i].value === royalty &&
          tx.payments[1 - i].address === sellTx.owner &&
          tx.payments[1 - i].value === sellerPayment
        ) {
          return {
            tax: tax,
            royalty: royalty,
          };
        }
      }
      return null;
    }
  }
}

module.exports = {
  parseNftTransaction,
  ListTransactionProcessor,
  RepriceTransactionProcessor,
  BuyTransactionProcessor,
};
